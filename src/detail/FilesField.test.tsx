// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FilesField } from '@/detail/FilesField';
import { resetLayers } from '@/components/ui/layers';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { useNavStore } from '@/stores/navStore';
import { seedBytes, reset as resetBytes } from '@/lib/mockBytes';
import { mockDrop } from '@/lib/mockDropped';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const ipc = vi.hoisted(() => ({
  canPickFiles: vi.fn(() => true),
  pickFiles: vi.fn(async () => [] as string[]),
  importAttachment: vi.fn(async (_v: string, source: string) => {
    const name = source.split('/').pop() ?? 'file';
    return { path: `attachments/${name}`, reused: false };
  }),
}));

vi.mock('@/lib/ipc', async (original) => ({
  ...(await original<typeof import('@/lib/ipc')>()),
  ...ipc,
}));

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
    resetBytes();
    useNavStore.getState().reset();
    useUiStore.setState({ toasts: [] });
    useVaultStore.setState({ vaultPath: '/vault' });
    ipc.canPickFiles.mockReturnValue(true);
    ipc.pickFiles.mockResolvedValue([]);
    ipc.importAttachment.mockClear();
    ipc.importAttachment.mockImplementation(async (_v: string, source: string) => {
      const name = source.split('/').pop() ?? 'file';
      return { path: `attachments/${name}`, reused: false };
    });
  });
  afterEach(cleanup);

  const open = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: /Add file to/ }));

  it('opens image chips in an image-only lightbox, other files as pages and URLs as links', async () => {
    const user = userEvent.setup();
    seedBytes('0', 'attachments/a.png', { bytes: [1, 2] });
    const onChange = vi.fn();
    render(
      <FilesField
        values={['attachments/a.png', 'attachments/b.pdf', 'https://example.com/image.png']}
        label="Files"
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Open a.png' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByText('1 of 1')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open b.pdf' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'file', path: 'attachments/b.pdf' });
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://example.com/image.png');
    expect(
      screen.getByRole('button', { name: 'Add file to Files' }).hasAttribute('data-cell-primary'),
    ).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

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

  it.each(['vault round trip', 'unmount', 'another record'])(
    'discards a picker after %s',
    async (change) => {
      const user = userEvent.setup();
      const picked = deferred<string[]>();
      ipc.pickFiles.mockReturnValue(picked.promise);
      const onChange = vi.fn();
      const field = render(
        <FilesField ownerKey="a:files" values={[]} label="Files" onChange={onChange} />,
      );
      await open(user);
      await user.click(screen.getByTestId('files-upload'));
      if (change === 'unmount') field.unmount();
      else if (change === 'another record')
        field.rerender(
          <FilesField ownerKey="b:files" values={[]} label="Files" onChange={onChange} />,
        );
      else
        act(() => {
          useVaultStore.setState({ vaultPath: '/other' });
          useVaultStore.setState({ vaultPath: '/vault' });
        });
      await act(async () => picked.resolve(['/a/new.pdf']));
      expect(ipc.importAttachment).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it('never replaces newer values or starts the next import after a pending copy', async () => {
    const user = userEvent.setup();
    const copied = deferred<{ path: string; reused: boolean }>();
    ipc.pickFiles.mockResolvedValue(['/a/one.pdf', '/a/two.pdf']);
    ipc.importAttachment.mockReturnValue(copied.promise);
    const onChange = vi.fn();
    const field = render(
      <FilesField ownerKey="a:files" values={[]} label="Files" onChange={onChange} />,
    );
    await open(user);
    await user.click(screen.getByTestId('files-upload'));
    await waitFor(() => expect(ipc.importAttachment).toHaveBeenCalledTimes(1));
    field.rerender(
      <FilesField
        ownerKey="a:files"
        values={['attachments/newer.pdf']}
        label="Files"
        onChange={onChange}
      />,
    );
    await act(async () => copied.resolve({ path: 'attachments/one.pdf', reused: false }));
    expect(ipc.importAttachment).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
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

  it('copies native dropped files in order and names folders and hidden files as skipped', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <FilesField
        ownerKey="a:files"
        values={['attachments/old.pdf']}
        label="Files"
        onChange={onChange}
      />,
    );
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => container.querySelector('[data-os-drop]'),
    });
    await act(async () =>
      mockDrop({
        at: { x: 8, y: 9 },
        files: [
          { path: '/outside/one.pdf', content: '%PDF' },
          { path: '/outside/folder', folder: true },
          { path: '/outside/.hidden.md', content: 'hidden' },
          { path: '/outside/two.png', base64: 'AQI=' },
        ],
      }),
    );
    expect(ipc.importAttachment.mock.calls.map(([, path]) => path)).toEqual([
      '/outside/one.pdf',
      '/outside/two.png',
    ]);
    expect(onChange).toHaveBeenCalledWith([
      'attachments/old.pdf',
      'attachments/one.pdf',
      'attachments/two.png',
    ]);
    expect(useUiStore.getState().toasts.map((toast) => toast.message)).toEqual([
      'Skipped folder (a folder), .hidden.md (a hidden file)',
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
