import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/ipc', { spy: true });
import * as ipc from '@/lib/ipc';
import { __seedFollowups, resetOperational } from '@/lib/mockIpc';
import type { Followup } from '@/engine/followups';
import { useUiStore } from './uiStore';
import { useVaultStore } from './vaultStore';
import { useFollowupStore } from './followupStore';
const store = () => useFollowupStore.getState();
const vault = '/demo-vault';
const row: Followup = {
  followupId: 'id',
  actor: 'process:release-scout',
  note: 'check',
  dueAt: '2026-10-15T13:00:00Z',
  requestedAt: '2026-10-15T12:00:00Z',
  requestedByRun: 'run',
  state: 'pending',
  claimedAt: null,
  runId: null,
  endedAt: null,
  cancelReason: null,
};
beforeEach(() => {
  vi.restoreAllMocks();
  resetOperational();
  useVaultStore.setState({ vaultPath: vault });
  store().reset(vault);
  useUiStore.setState({ toasts: [] });
});
it('reads rows, retains local retry holds and prunes them when a row leaves', async () => {
  __seedFollowups([{ vault, ...row }]);
  await store().load(vault);
  expect(store().read).toEqual({ state: 'ready', rows: [row] });
  store().hold('id', 123);
  await store().refresh(vault);
  expect(store().held).toEqual({ id: 123 });
  expect(await store().cancel('id')).toBe(true);
  expect(store().read).toEqual({ state: 'ready', rows: [] });
  expect(store().held).toEqual({});
});
it('failed reads remain unavailable and a later refresh recovers', async () => {
  __seedFollowups(null);
  await store().load(vault);
  expect(store().read).toEqual({ state: 'unavailable' });
  __seedFollowups([]);
  await store().refresh(vault);
  expect(store().read).toEqual({ state: 'ready', rows: [] });
});
it('cancellation never throws, says false honestly and reloads it', async () => {
  vi.spyOn(ipc, 'listFollowups');
  __seedFollowups([{ vault, ...row, state: 'claimed' }]);
  await store().load(vault);
  expect(await store().cancel('id')).toBe(false);
  expect(useUiStore.getState().toasts.at(-1)?.message).toBe(
    'That follow-up already started or was cancelled',
  );
  expect(ipc.listFollowups).toHaveBeenCalledTimes(2);
  vi.spyOn(ipc, 'cancelFollowup').mockRejectedValue(Error('db down'));
  expect(await store().cancel('id')).toBe(false);
  expect(useUiStore.getState().toasts.at(-1)?.message).toBe("Couldn't cancel that follow-up");
});
it('a late read cannot replace the latest read or cross a vault switch and return', async () => {
  let finish!: (rows: Followup[]) => void;
  vi.spyOn(ipc, 'listFollowups').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const old = store().refresh(vault);
  await store().refresh(vault);
  finish([row]);
  await old;
  expect(store().read).toEqual({ state: 'ready', rows: [] });
  vi.spyOn(ipc, 'listFollowups').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const stale = store().refresh(vault);
  store().hold('id', 123);
  useVaultStore.setState({ vaultPath: '/other' });
  useVaultStore.setState({ vaultPath: vault });
  finish([row]);
  await stale;
  expect(store().read).toEqual({ state: 'loading' });
  expect(store().held).toEqual({});
});
it('a cancel completed after a vault switch has no toast or refresh in the new vault', async () => {
  let finish!: (answer: boolean) => void;
  vi.spyOn(ipc, 'cancelFollowup').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const cancelling = store().cancel('id');
  useVaultStore.setState({ vaultPath: '/other' });
  finish(false);
  expect(await cancelling).toBe(false);
  expect(useUiStore.getState().toasts).toEqual([]);
  expect(store().vault).toBe('/other');
});
