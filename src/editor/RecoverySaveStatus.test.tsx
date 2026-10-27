import { useVaultStore } from '@/stores/vaultStore';
// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as ipc from '@/lib/ipc';
import { DocumentOwner } from './documentOwner';
import { RecoverySaveStatus } from './RecoverySaveStatus';
const key = { vaultId: 'v', path: 'a.md', ownerId: 'p' };
beforeEach(() => {
  vi.restoreAllMocks();
  useVaultStore.setState({ vaultPath: 'v' });
});
it('shows an explicit choice only after lookup and submits the same owner generation once', async () => {
  vi.spyOn(ipc, 'recoveryFailure').mockResolvedValue({
    reason: 'journal_storage_failed',
    expiresAt: Date.now() / 1000 + 60,
  });
  const saved: (string | undefined)[] = [];
  const owner = new DocumentOwner(key, 'old', async (_body, _format, bypass) => {
    saved.push(bypass);
    if (!bypass) throw new Error('recovery_required:nonce');
    return { kind: 'file', contentHash: 'ok', recovery: { kind: 'without_copy' } };
  });
  owner.edit('new');
  await owner.flush();
  render(<RecoverySaveStatus owner={owner} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Save without a recovery copy' }));
  await waitFor(() => expect(owner.snapshot().acknowledgedGeneration).toBe(1));
  expect(saved).toEqual([undefined, 'nonce']);
  expect((await screen.findByRole('status')).textContent).toContain(
    'Saved without a recovery copy',
  );
});
it('late failure lookup cannot authorize newer typing', async () => {
  let resolve!: (value: { reason: string; expiresAt: number }) => void;
  vi.spyOn(ipc, 'recoveryFailure').mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const owner = new DocumentOwner(key, 'old', async () => {
    throw new Error('recovery_required:nonce');
  });
  owner.edit('new');
  await owner.flush();
  render(<RecoverySaveStatus owner={owner} />);
  await waitFor(() => expect(ipc.recoveryFailure).toHaveBeenCalled());
  await act(async () => {
    owner.edit('newest');
    resolve({ reason: 'journal_storage_failed', expiresAt: Date.now() / 1000 + 60 });
  });
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Save without a recovery copy' })).toBeNull(),
  );
  expect(owner.snapshot().latestDraft).toBe('newest');
});
it('a vault round trip invalidates a pending save failure lookup', async () => {
  let resolve!: (value: { reason: string; expiresAt: number }) => void;
  vi.spyOn(ipc, 'recoveryFailure').mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const owner = new DocumentOwner(key, 'old', async () => {
    throw new Error('recovery_required:nonce');
  });
  owner.edit('new');
  await owner.flush();
  render(<RecoverySaveStatus owner={owner} />);
  await waitFor(() => expect(ipc.recoveryFailure).toHaveBeenCalled());
  await act(async () => {
    useVaultStore.setState({ vaultPath: 'other' });
    useVaultStore.setState({ vaultPath: 'v' });
    resolve({ reason: 'journal_storage_failed', expiresAt: Date.now() / 1000 + 60 });
  });
  expect(screen.queryByRole('button', { name: 'Save without a recovery copy' })).toBeNull();
});
