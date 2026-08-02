import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DetailPanel } from '@/detail/DetailPanel';
import { FieldEditor } from '@/detail/FieldEditor';
import { buildSchema } from '@/engine/schema';
import * as ipc from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { fixtureVault, makeEntry } from '@/test/factories';

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
  listFolders: vi.fn().mockResolvedValue([]),
  createFolder: vi.fn(),
  renameNote: vi.fn(),
  deleteNote: vi.fn(),
}));

afterEach(cleanup);

describe('DetailPanel', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault(), vaultPath: '/vault' });
    useUiStore.setState({ detailPath: 'projects/onboarding/items/fld-1.md' });
  });

  it('writes a frontmatter patch when a status option is picked', async () => {
    const user = userEvent.setup();
    const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
    useVaultStore.setState({ patchFrontmatter });
    render(<DetailPanel />);
    await user.click(screen.getByRole('button', { name: 'Todo' }));
    await user.click(screen.getByRole('option', { name: 'Doing' }));
    expect(patchFrontmatter).toHaveBeenCalledWith('projects/onboarding/items/fld-1.md', {
      status: 'doing',
    });
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

  // M15: one Escape must dismiss ONE surface. The window listener sits above
  // the null-guard (hooks are unconditional), so the guard is in the handler.
  it('leaves the record panel open when QuickOpen owns the Escape', () => {
    render(<DetailPanel />);
    useUiStore.setState({ quickOpenVisible: true });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().detailPath).not.toBeNull();
    useUiStore.setState({ quickOpenVisible: false });
  });

  it('leaves the record panel open when the inline diff owns the Escape', () => {
    render(<DetailPanel />);
    useUiStore.setState({ diffView: { path: 'projects/onboarding/items/fld-1.md', commit: null } });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().detailPath).not.toBeNull();
    useUiStore.setState({ diffView: null });
  });

  it('leaves the record panel open when a modal is on top', () => {
    render(<DetailPanel />);
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    document.body.appendChild(modal);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().detailPath).not.toBeNull();
    modal.remove();
  });

  it('renders nothing when no detail path is open', () => {
    useUiStore.setState({ detailPath: null });
    const { container } = render(<DetailPanel />);
    expect(container.firstChild).toBeNull();
  });

  // --- Tests below cover reported deviations from the plan's verbatim code ---

  // Task 12: the body renders in the rich editor; NoteBodyEditor covers
  // save-failure toasts and the note-10 newline normalization at its level.
  it('renders the note body in the rich markdown editor', async () => {
    vi.mocked(ipc.readNote).mockResolvedValueOnce('\n# Design first-run flow\n\nBody text\n');
    render(<DetailPanel />);
    await waitFor(() => expect(screen.getByTestId('markdown-editor')).toBeTruthy(), {
      timeout: 5_000,
    });
    await waitFor(() => expect(screen.getByText('Body text')).toBeTruthy());
    expect(screen.queryByRole('textbox', { name: 'Description' })).toBeNull();
  });

  it('toasts and reverts the title when the H1 rename fails (note 16a)', async () => {
    useUiStore.setState({ toasts: [] });
    vi.mocked(ipc.setNoteTitle).mockRejectedValueOnce(new Error('read-only vault'));
    render(<DetailPanel />);
    const input = screen.getByLabelText('Title') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Renamed flow' } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(useUiStore.getState().toasts.map((t) => t.message)).toContain("Couldn't rename item");
    });
    expect(input.value).toBe('Design first-run flow');
  });

  it('toasts when the body cannot be loaded (note 16a guard discipline)', async () => {
    useUiStore.setState({ toasts: [] });
    vi.mocked(ipc.readNote).mockRejectedValueOnce(new Error('gone'));
    render(<DetailPanel />);
    await waitFor(() => {
      expect(useUiStore.getState().toasts.map((t) => t.message)).toContain("Couldn't load page");
    });
  });

  // M1.x stale-body-after-rename, block edition: the editor keeps its
  // document across a rename (the file path doesn't change) — without the
  // splice, its next debounced save writes the OLD H1 back over the renamed
  // file. spliceTitleIntoBlocks unit coverage lives in markdown.test.ts.
  it('splices the new H1 into the live editor after a rename', async () => {
    vi.mocked(ipc.readNote).mockResolvedValueOnce('# Design first-run flow\n\nBody text\n');
    vi.mocked(ipc.scanVault).mockResolvedValue(fixtureVault());
    render(<DetailPanel />);
    await waitFor(() => expect(screen.getByText('Body text')).toBeTruthy(), { timeout: 5_000 });
    const input = screen.getByLabelText('Title') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Renamed flow' } });
    fireEvent.blur(input);
    // The editor's H1 block now carries the new title...
    await waitFor(() => {
      expect(screen.getByTestId('markdown-editor').textContent).toContain('Renamed flow');
    });
    // ...and the splice-triggered debounced save writes it to disk.
    await waitFor(
      () => {
        const bodies = vi.mocked(ipc.saveNote).mock.calls.map((c) => c[2]);
        expect(bodies.some((b) => b.startsWith('# Renamed flow'))).toBe(true);
      },
      { timeout: 3_000 },
    );
  });

  // M14.2: which knowledge surface answers is capability-gated — a record the
  // base holds concepts ABOUT gets its dossier (projects became ordinary
  // records in the M12.5 aftermath, so the dossier rides the panel now); any
  // other record keeps the wide-net related list.
  it('shows the entity dossier when the base holds concepts about the record', async () => {
    const user = userEvent.setup();
    useVaultStore.setState({
      entries: [
        ...fixtureVault(),
        makeEntry({
          path: 'knowledge/systems/first-run.md',
          title: 'First-run flow',
          // The scanner hands wikilink fields over bracket-stripped, in
          // relationships — not properties (M12.4a).
          relationships: { about: ['fld-1'] },
        }),
      ],
    });
    render(<DetailPanel />);
    await user.click(screen.getByTestId('detail-knowledge-toggle'));
    expect(screen.getByTestId('entity-dossier')).toBeTruthy();
    expect(screen.queryByTestId('related-knowledge')).toBeNull();
  });

  it('keeps the related list when the base only knows around the record', async () => {
    const user = userEvent.setup();
    render(<DetailPanel />);
    await user.click(screen.getByTestId('detail-knowledge-toggle'));
    expect(screen.getByTestId('related-knowledge')).toBeTruthy();
    expect(screen.queryByTestId('entity-dossier')).toBeNull();
  });
});

// spliceTitle (string splice) was replaced by spliceTitleIntoBlocks in Task
// 12 — equivalent coverage lives in src/editor/markdown.test.ts.

// M1.x .nan guard: Number('junk') is NaN and serde_yaml writes it as `.nan`.
describe('FieldEditor number guard', () => {
  beforeEach(() => {
    useUiStore.setState({ toasts: [] });
  });

  function setupNumberEditor() {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    const entry = entries.find((e) => e.path === 'projects/onboarding/items/fld-1.md')!;
    const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
    useVaultStore.setState({ entries, patchFrontmatter });
    render(<FieldEditor entry={entry} def={{ name: 'effort', kind: 'number' }} schema={schema} />);
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
    expect(patchFrontmatter).toHaveBeenCalledWith('projects/onboarding/items/fld-1.md', {
      effort: 5,
    });
  });

  // M15: the read view seeded the draft from the FORMATTED display, so a
  // percent field opened holding "76%" and commit rejected the app's own
  // display string with "Enter a number" — the field was unusable.
  function setupFormattedEditor(format: 'percent' | 'currency') {
    const entries = fixtureVault();
    // The format lives on the TYPE — resolveField reads the declared def, not
    // the one handed to FieldEditor — so declare it there.
    const typeDoc = entries.find((e) => e.path === 'types/work-item.md')!;
    (typeDoc.properties as unknown as { fields: Record<string, unknown> }).fields.effort = {
      kind: 'number',
      format,
      precision: 0,
    };
    const entry = entries.find((e) => e.path === 'projects/onboarding/items/fld-1.md')!;
    entry.properties.effort = 1840;
    const schema = buildSchema(entries);
    const def = schema.types.get('Work item')!.fields.find((f) => f.name === 'effort')!;
    const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
    useVaultStore.setState({ entries, patchFrontmatter });
    render(<FieldEditor entry={entry} def={def} schema={schema} />);
    return patchFrontmatter;
  }

  it('opens a currency field on the raw number, not "$1,840"', async () => {
    const user = userEvent.setup();
    setupFormattedEditor('currency');
    expect(screen.getByRole('button').textContent).toBe('$1,840');
    await user.click(screen.getByRole('button'));
    expect((screen.getByLabelText('Effort') as HTMLInputElement).value).toBe('1840');
  });

  it('accepts a retyped formatted value instead of toasting at it', async () => {
    const user = userEvent.setup();
    const patchFrontmatter = setupFormattedEditor('percent');
    await user.click(screen.getByRole('button'));
    const input = screen.getByLabelText('Effort');
    await user.clear(input);
    await user.type(input, '76%');
    fireEvent.blur(input);
    expect(patchFrontmatter).toHaveBeenCalledWith('projects/onboarding/items/fld-1.md', {
      effort: 76,
    });
    expect(useUiStore.getState().toasts.map((t) => t.message)).not.toContain('Enter a number');
  });
});
