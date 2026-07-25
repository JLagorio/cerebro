import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DetailPanel } from '@/detail/DetailPanel';
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
});
