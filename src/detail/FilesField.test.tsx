// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FilesField } from '@/detail/FilesField';
import { resetLayers } from '@/components/ui/layers';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

const ipc = vi.hoisted(() => ({
  canPickFiles: vi.fn(() => true),
  pickFiles: vi.fn(async () => [] as string[]),
  importAttachment: vi.fn(async (_v: string, source: string) => {
    const name = source.split('/').pop() ?? 'file';
    return `attachments/${name}`;
  }),
}));

vi.mock('@/lib/ipc', () => ipc);

/**
 * Files, for real (M16.13c).
 *
 * The old control was a text input placeholdered "Path or URL": you typed a
 * path to a file the app had never seen and nothing checked it existed, would
 * keep existing, or was reachable from any other machine. Picking now copies
 * into the vault and stores the VAULT-RELATIVE path the copy landed at.
 */
describe('FilesField', () => {
  beforeEach(() => {
    resetLayers();
    useUiStore.setState({ toasts: [] });
    useVaultStore.setState({ vaultPath: '/vault' });
    ipc.canPickFiles.mockReturnValue(true);
    ipc.pickFiles.mockResolvedValue([]);
    ipc.importAttachment.mockImplementation(async (_v: string, source: string) => {
      const name = source.split('/').pop() ?? 'file';
      return `attachments/${name}`;
    });
  });
  afterEach(cleanup);

  const open = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: /Add file to/ }));

  it('copies a picked file in and stores the path the copy landed at', async () => {
    const user = userEvent.setup();
    ipc.pickFiles.mockResolvedValue(['/Users/me/Downloads/report.pdf']);
    const onChange = vi.fn();
    render(<FilesField values={[]} label="Attachments" onChange={onChange} />);

    await open(user);
    await user.click(screen.getByTestId('files-upload'));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(ipc.importAttachment).toHaveBeenCalledWith('/vault', '/Users/me/Downloads/report.pdf');
    // The vault-relative path, never the absolute one it came from.
    expect(onChange).toHaveBeenCalledWith(['attachments/report.pdf']);
  });

  // Concurrently would race: the dedupe suffix is decided by what is already
  // on disk, so two imports of `report.pdf` would both see the folder empty.
  it('imports several picks in order and appends them all', async () => {
    const user = userEvent.setup();
    ipc.pickFiles.mockResolvedValue(['/a/one.png', '/a/two.png']);
    const onChange = vi.fn();
    render(<FilesField values={['attachments/old.pdf']} label="Attachments" onChange={onChange} />);

    await open(user);
    await user.click(screen.getByTestId('files-upload'));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange).toHaveBeenCalledWith([
      'attachments/old.pdf',
      'attachments/one.png',
      'attachments/two.png',
    ]);
  });

  it('does nothing at all when the picker is cancelled', async () => {
    const user = userEvent.setup();
    ipc.pickFiles.mockResolvedValue([]);
    const onChange = vi.fn();
    render(<FilesField values={[]} label="Attachments" onChange={onChange} />);

    await open(user);
    await user.click(screen.getByTestId('files-upload'));
    await waitFor(() => expect(ipc.pickFiles).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });

  // The store-layer invariant: actions never throw, they toast. A failed copy
  // must leave the field exactly as it was rather than recording a path to a
  // file that is not there.
  it('toasts and writes nothing when the copy fails', async () => {
    const user = userEvent.setup();
    ipc.pickFiles.mockResolvedValue(['/a/locked.pdf']);
    ipc.importAttachment.mockRejectedValue(new Error('permission denied'));
    const onChange = vi.fn();
    render(<FilesField values={[]} label="Attachments" onChange={onChange} />);

    await open(user);
    await user.click(screen.getByTestId('files-upload'));

    await waitFor(() => expect(useUiStore.getState().toasts.length).toBe(1));
    expect(useUiStore.getState().toasts[0].message).toMatch(/permission denied/);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps the typed route, which is the only one that can hold a URL', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<FilesField values={[]} label="Attachments" onChange={onChange} />);

    await open(user);
    await user.click(screen.getByTestId('files-link'));
    await user.type(screen.getByPlaceholderText('Path or URL'), 'https://example.com/spec.pdf');
    await user.keyboard('{Enter}');

    expect(onChange).toHaveBeenCalledWith(['https://example.com/spec.pdf']);
  });

  it('renders a URL as a link and a vault file as a named chip', () => {
    render(
      <FilesField
        values={['https://example.com/spec.pdf', 'attachments/report.pdf']}
        label="Attachments"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('link', { name: 'https://example.com/spec.pdf' })).toBeTruthy();
    // The basename is what a chip has room for; the full path is the title.
    expect(screen.getByTitle('attachments/report.pdf').textContent).toBe('report.pdf');
  });

  // Removing a reference is not deleting a file — the copy stays in the vault
  // folder, which is the user's to prune.
  it('clears the key rather than writing an empty list', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<FilesField values={['attachments/a.pdf']} label="Attachments" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Remove attachments/a.pdf' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  // Disabled rather than hidden: "this is a desktop feature" beats an item
  // that silently is not there.
  it('offers upload as disabled where there is no native picker', async () => {
    const user = userEvent.setup();
    ipc.canPickFiles.mockReturnValue(false);
    render(<FilesField values={[]} label="Attachments" onChange={vi.fn()} />);
    await open(user);
    expect(screen.queryByTestId('files-upload')).toBeNull();
    expect(screen.getByRole('menuitem', { name: /Upload a file/ }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.getByTestId('files-link')).toBeTruthy();
  });
});
