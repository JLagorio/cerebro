// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/ipc', async (original) => ({
  ...(await original<typeof import('@/lib/ipc')>()),
  probeDraftTarget: vi.fn(async () => ({ kind: 'missing' })),
  writeClipboard: vi.fn(async () => undefined),
  chooseDraftExport: vi.fn(),
  commitDraftExport: vi.fn(),
  cancelDraftExport: vi.fn(),
  createRecoveredPage: vi.fn(),
}));
import * as ipc from '@/lib/ipc';
import { DeletedDraftRecovery } from './DeletedDraftRecoveryFace';
import { __resetOpenPages, retainDocumentOwner, unresolvedOpenPages } from './openPages';
import { useVaultStore } from '@/stores/vaultStore';
const key = { vaultId: '/demo-vault', path: 'notes/gone.md', ownerId: 'pane-a' };
beforeEach(() => {
  __resetOpenPages();
  useVaultStore.setState({ vaultPath: key.vaultId });
  vi.mocked(ipc.probeDraftTarget).mockResolvedValue({ kind: 'missing' });
});
afterEach(() => {
  cleanup();
  __resetOpenPages();
  vi.clearAllMocks();
});
it('shows a recoverable missing source body and copies exact bytes without clearing it', async () => {
  const write = vi.fn();
  const owner = retainDocumentOwner(key, 'before', write);
  owner.edit('\r\n<div>😀</div>\r\n', 'source');
  owner.setChildDrafts('sheets', '  invalid cell\r\n');
  render(
    <DeletedDraftRecovery
      vaultId={key.vaultId}
      path={key.path}
      fallback={<p>Generic missing</p>}
    />,
  );
  await screen.findByText(/original file is missing/i);
  fireEvent.click(screen.getByRole('button', { name: 'Copy body' }));
  await screen.findByText(/Copied. Your original draft is still kept/);
  expect(ipc.writeClipboard).toHaveBeenCalledWith('\r\n<div>😀</div>\r\n');
  expect(write).not.toHaveBeenCalled();
  expect(unresolvedOpenPages()).toHaveLength(1);
  expect(screen.getByText(/child drafts are kept separately/i)).toBeTruthy();
});
it('does not call an unreadable target deleted and retains its recovery actions', async () => {
  vi.mocked(ipc.probeDraftTarget).mockResolvedValue({ kind: 'unavailable', code: 'denied' });
  const owner = retainDocumentOwner(key, 'before', vi.fn());
  owner.edit('exact');
  render(<DeletedDraftRecovery vaultId={key.vaultId} path={key.path} fallback={null} />);
  await screen.findByText(/Could not check the original file/);
  expect(screen.queryByText(/original file is missing/i)).toBeNull();
  expect(screen.getByRole('button', { name: 'Copy body' })).toBeTruthy();
});
it('a stale discard confirmation cannot erase a newer child payload', async () => {
  const owner = retainDocumentOwner(key, 'before', vi.fn());
  owner.edit('exact');
  render(<DeletedDraftRecovery vaultId={key.vaultId} path={key.path} fallback={null} />);
  await screen.findByText(/original file is missing/i);
  fireEvent.click(screen.getByRole('button', { name: 'Discard this draft' }));
  act(() => owner.setChildDrafts('sheets', 'newer invalid formula'));
  fireEvent.click(screen.getByRole('button', { name: 'Discard permanently' }));
  await waitFor(() => expect(screen.getByText(/draft changed/i)).toBeTruthy());
  expect(owner.snapshot().childDrafts?.sheets).toBe('newer invalid formula');
});
it('cancels an old picker across a vault A→B→A transition and never exports replacement state', async () => {
  const owner = retainDocumentOwner(key, 'before', vi.fn());
  owner.edit('exact');
  let finish!: (value: { kind: 'chosen'; token: string }) => void;
  vi.mocked(ipc.chooseDraftExport).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  vi.mocked(ipc.cancelDraftExport).mockResolvedValue();
  render(<DeletedDraftRecovery vaultId={key.vaultId} path={key.path} fallback={null} />);
  await screen.findByText(/original file is missing/i);
  fireEvent.click(screen.getByRole('button', { name: 'Save as…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save recovery file' }));
  await waitFor(() => expect(ipc.chooseDraftExport).toHaveBeenCalledOnce());
  act(() => {
    useVaultStore.setState({ vaultPath: '/other-vault' });
    useVaultStore.setState({ vaultPath: key.vaultId });
  });
  await act(async () => {
    finish({ kind: 'chosen', token: 'old-picker' });
    await Promise.resolve();
  });
  expect(ipc.commitDraftExport).not.toHaveBeenCalled();
  expect(ipc.cancelDraftExport).toHaveBeenCalledWith('old-picker');
  expect(owner.snapshot().latestDraft).toBe('exact');
  expect(screen.getByRole('button', { name: 'Save recovery file' })).toHaveProperty(
    'disabled',
    false,
  );
});
it('a fresh admission response from before a real vault A→B→A cannot release recovery', async () => {
  const owner = retainDocumentOwner(key, 'before', vi.fn());
  owner.edit('exact source', 'source');
  render(<DeletedDraftRecovery vaultId={key.vaultId} path={key.path} fallback={null} />);
  await screen.findByText(/original file is missing/i);
  vi.mocked(ipc.probeDraftTarget).mockResolvedValue({ kind: 'present' });
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  let finish!: (result: Awaited<ReturnType<typeof ipc.readNoteSource>>) => void;
  const read = vi.spyOn(ipc, 'readNoteSource').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Reload restored page' }));
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  act(() => {
    useVaultStore.setState({ vaultPath: '/other-vault' });
    useVaultStore.setState({ vaultPath: key.vaultId });
  });
  await act(async () => {
    finish({ content: '# Outside\n', hash: 'outside' });
  });
  expect(owner.requiresRecovery()).toBe(true);
  expect(owner.recoveryResumePending()).toBe(false);
  expect(owner.snapshot().latestDraft).toBe('exact source');
  expect(screen.getByRole('button', { name: 'Copy body' })).toBeTruthy();
  read.mockRestore();
});
