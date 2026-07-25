import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DetailPanel, spliceTitle } from '@/detail/DetailPanel';
import { FieldEditor } from '@/detail/FieldEditor';
import { buildSchema } from '@/engine/schema';
import * as ipc from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { fixtureVault } from '@/test/factories';

vi.mock('@/lib/ipc', () => ({
  readNote: vi.fn().mockResolvedValue('Existing body'),
  saveNote: vi.fn().mockResolvedValue(undefined),
  setNoteTitle: vi.fn().mockResolvedValue(undefined),
  pickVault: vi.fn(),
  getLastVault: vi.fn(),
  scanVault: vi.fn().mockResolvedValue([]),
  updateFrontmatter: vi.fn().mockResolvedValue(undefined),
  createNote: vi.fn(),
  listViews: vi.fn().mockResolvedValue([]),
  saveView: vi.fn(),
  startWatcher: vi.fn().mockResolvedValue(undefined),
}));

afterEach(cleanup);

describe('DetailPanel', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault(), vaultPath: '/vault' });
    useUiStore.setState({ detailPath: 'items/fld-1.md' });
  });

  it('writes a frontmatter patch when a status option is picked', async () => {
    const user = userEvent.setup();
    const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
    useVaultStore.setState({ patchFrontmatter });
    render(<DetailPanel />);
    await user.click(screen.getByRole('button', { name: 'Todo' }));
    await user.click(screen.getByRole('option', { name: 'Doing' }));
    expect(patchFrontmatter).toHaveBeenCalledWith('items/fld-1.md', { status: 'doing' });
  });

  it('shows undeclared frontmatter keys as advisory text', () => {
    render(<DetailPanel />);
    expect(screen.getByText('Channel')).toBeTruthy();
    expect(screen.getByText('field-ops')).toBeTruthy();
  });

  it('closes on Escape', () => {
    render(<DetailPanel />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().detailPath).toBeNull();
  });

  it('renders nothing when no detail path is open', () => {
    useUiStore.setState({ detailPath: null });
    const { container } = render(<DetailPanel />);
    expect(container.firstChild).toBeNull();
  });

  // --- Tests below cover reported deviations from the plan's verbatim code ---

  it('strips the leading blank line a Rust-backend body carries (note 10)', async () => {
    // Mock readNote strips leading newlines; Rust read_note returns the body
    // verbatim including the blank line after the frontmatter fence. The
    // panel must display both identically.
    vi.mocked(ipc.readNote).mockResolvedValueOnce('\n# Design first-run flow\n\nBody text\n');
    render(<DetailPanel />);
    await waitFor(() => {
      const textarea = screen.getByLabelText('Description') as HTMLTextAreaElement;
      expect(textarea.value).toBe('# Design first-run flow\n\nBody text\n');
    });
  });

  it('toasts when the description save fails instead of rejecting silently (note 16a)', async () => {
    useUiStore.setState({ toasts: [] });
    vi.mocked(ipc.saveNote).mockRejectedValueOnce(new Error('disk full'));
    render(<DetailPanel />);
    await waitFor(() => {
      expect((screen.getByLabelText('Description') as HTMLTextAreaElement).disabled).toBe(false);
    });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Edited body' } });
    fireEvent.blur(screen.getByLabelText('Description'));
    await waitFor(() => {
      expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
        "Couldn't save description",
      );
    });
  });

  it('toasts and reverts the title when the H1 rename fails (note 16a)', async () => {
    useUiStore.setState({ toasts: [] });
    vi.mocked(ipc.setNoteTitle).mockRejectedValueOnce(new Error('read-only vault'));
    render(<DetailPanel />);
    const input = screen.getByLabelText('Title') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Renamed flow' } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
        "Couldn't rename item",
      );
    });
    expect(input.value).toBe('Design first-run flow');
  });

  it('toasts when the body cannot be loaded (note 16a guard discipline)', async () => {
    useUiStore.setState({ toasts: [] });
    vi.mocked(ipc.readNote).mockRejectedValueOnce(new Error('gone'));
    render(<DetailPanel />);
    await waitFor(() => {
      expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
        "Couldn't load description",
      );
    });
  });

  // M1.x stale-body-after-rename: the readNote effect keys on entry.path,
  // which a rename doesn't change — without the splice, a later description
  // save writes the OLD H1 back over the renamed file.
  it('splices the new H1 into the loaded body after a rename', async () => {
    vi.mocked(ipc.readNote).mockResolvedValueOnce('# Design first-run flow\n\nBody text\n');
    vi.mocked(ipc.scanVault).mockResolvedValue(fixtureVault());
    render(<DetailPanel />);
    await waitFor(() => {
      expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe(
        '# Design first-run flow\n\nBody text\n',
      );
    });
    const input = screen.getByLabelText('Title') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Renamed flow' } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe(
        '# Renamed flow\n\nBody text\n',
      );
    });
    // A later description edit + save writes the new title, not the stale one.
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: '# Renamed flow\n\nBody text\n\nMore.\n' },
    });
    fireEvent.blur(screen.getByLabelText('Description'));
    await waitFor(() => {
      expect(vi.mocked(ipc.saveNote)).toHaveBeenCalledWith(
        '/vault',
        'items/fld-1.md',
        '# Renamed flow\n\nBody text\n\nMore.\n',
      );
    });
  });
});

describe('spliceTitle', () => {
  it('replaces the H1 line in place', () => {
    expect(spliceTitle('# Old title\n\nBody stays.\n', 'New title')).toBe(
      '# New title\n\nBody stays.\n',
    );
  });

  it('skips pseudo-H1s inside code fences (parity with replace_h1)', () => {
    expect(spliceTitle('```\n# in code\n```\n\n# Real\n\nBody.\n', 'New')).toBe(
      '```\n# in code\n```\n\n# New\n\nBody.\n',
    );
  });

  it('prepends an H1 when the body has none', () => {
    expect(spliceTitle('Just prose.\n', 'Now titled')).toBe('# Now titled\n\nJust prose.\n');
  });
});

// M1.x .nan guard: Number('junk') is NaN and serde_yaml writes it as `.nan`.
describe('FieldEditor number guard', () => {
  beforeEach(() => {
    useUiStore.setState({ toasts: [] });
  });

  function setupNumberEditor() {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    const entry = entries.find((e) => e.path === 'items/fld-1.md')!;
    const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
    useVaultStore.setState({ entries, patchFrontmatter });
    render(
      <FieldEditor entry={entry} def={{ name: 'effort', kind: 'number' }} schema={schema} />,
    );
    return patchFrontmatter;
  }

  it('refuses a non-numeric draft with a toast instead of writing .nan', async () => {
    const user = userEvent.setup();
    const patchFrontmatter = setupNumberEditor();
    await user.click(screen.getByRole('button'));
    await user.type(screen.getByLabelText('Effort'), 'abc');
    fireEvent.blur(screen.getByLabelText('Effort'));
    expect(patchFrontmatter).not.toHaveBeenCalled();
    expect(useUiStore.getState().toasts.map((t) => t.message)).toContain('Enter a number');
  });

  it('commits a numeric draft as a number', async () => {
    const user = userEvent.setup();
    const patchFrontmatter = setupNumberEditor();
    await user.click(screen.getByRole('button'));
    await user.type(screen.getByLabelText('Effort'), '5');
    fireEvent.blur(screen.getByLabelText('Effort'));
    expect(patchFrontmatter).toHaveBeenCalledWith('items/fld-1.md', { effort: 5 });
  });
});
