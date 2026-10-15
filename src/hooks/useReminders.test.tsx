import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useReminders } from './useReminders';
import { useVaultStore } from '@/stores/vaultStore';
import { useReminderStore } from '@/stores/reminderStore';
import { useUiStore } from '@/stores/uiStore';
import { makeEntry } from '@/test/factories';
import type { Entry } from '@/engine/types';
import { collectReminders, reminderClaimFor } from '@/engine/reminders';
import * as ipc from '@/lib/ipc';
import * as mock from '@/lib/mockIpc';
let n = 0;
let vault = '';
const body = 'Call vendor 📅 2026-07-28 12:00 ((remind:0d))';
const now = '2026-07-28T12:00:00';
const toast = vi.fn();
function datedType(): Entry {
  return makeEntry({
    path: 'types/visit.md',
    title: 'Visit',
    type: 'Type',
    properties: {
      fields: { due: { kind: 'date', remind: '1d' }, status: { kind: 'status' } },
      statuses: [
        { id: 'active', group: 'active' },
        { id: 'done', group: 'done' },
      ],
    } as unknown as Entry['properties'],
  });
}
beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  localStorage.clear();
  mock.resetMockFs();
  vault = `/reminders-${++n}`;
  toast.mockReset();
  useUiStore.setState({ toast });
  useReminderStore.getState().reset(null);
  useVaultStore.setState({
    vaultPath: vault,
    entriesVault: vault,
    entries: [makeEntry({ path: 'a.md', modifiedAt: String(n) })],
  });
  vi.spyOn(ipc, 'readNote').mockResolvedValue(body);
});
afterEach(() => vi.useRealTimers());
it('merges property reminders without extra body reads and re-arms a changed date', async () => {
  const type = datedType();
  const entry = makeEntry({
    path: 'visits/checkup.md',
    title: 'Checkup',
    type: 'Visit',
    properties: { due: '2026-07-29 10:00' },
  });
  useVaultStore.setState({ entries: [type, entry] });
  vi.mocked(ipc.readNote).mockResolvedValue('');
  const hook = renderHook(useReminders);
  await waitFor(() => expect(toast).toHaveBeenCalledWith('⏰ Reminder (2h late): Checkup · Due'));
  expect(ipc.readNote).toHaveBeenCalledTimes(2);
  expect(useReminderStore.getState().reminders).toHaveLength(1);
  hook.rerender();
  expect(toast).toHaveBeenCalledOnce();
  act(() =>
    useVaultStore.setState({
      entries: [type, { ...entry, properties: { due: '2026-07-29 11:00' } }],
    }),
  );
  await waitFor(() => expect(toast).toHaveBeenCalledWith('⏰ Reminder (1h late): Checkup · Due'));
  expect(ipc.readNote).toHaveBeenCalledTimes(2);
  expect((await mock.reminderState(vault)).fires).toHaveLength(2);
});
it.each([false, true])(
  'settles a claim across a scan replacement, finished=%s',
  async (finished) => {
    const type = datedType();
    const entry = makeEntry({
      path: 'visits/checkup.md',
      title: 'Checkup',
      type: 'Visit',
      properties: { due: '2026-07-29 10:00' },
    });
    useVaultStore.setState({ entries: [type, entry] });
    vi.mocked(ipc.readNote).mockResolvedValue('');
    let finish!: (value: Awaited<ReturnType<typeof ipc.reminderClaim>>) => void;
    const claim = vi.spyOn(ipc, 'reminderClaim').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderHook(useReminders);
    await waitFor(() => expect(claim).toHaveBeenCalledOnce());
    act(() =>
      useVaultStore.setState({
        entries: [
          type,
          {
            ...entry,
            properties: { ...entry.properties, ...(finished ? { status: 'done' } : {}) },
          },
        ],
      }),
    );
    await waitFor(() =>
      expect(useReminderStore.getState().reminders).toHaveLength(finished ? 0 : 1),
    );
    const result = await mock.reminderClaim(vault, claim.mock.calls[0][1]);
    await act(async () => finish(result));
    if (finished) expect(toast).not.toHaveBeenCalled();
    else
      await waitFor(() =>
        expect(toast).toHaveBeenCalledWith('⏰ Reminder (2h late): Checkup · Due'),
      );
    expect(claim).toHaveBeenCalledOnce();
  },
);

it('drops a fresh notice when its vault lifetime ends, including a later return', async () => {
  let finish!: (value: Awaited<ReturnType<typeof ipc.reminderClaim>>) => void;
  const claim = vi.spyOn(ipc, 'reminderClaim').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const entries = useVaultStore.getState().entries;
  renderHook(useReminders);
  await waitFor(() => expect(claim).toHaveBeenCalledOnce());
  act(() =>
    useVaultStore.setState({
      vaultPath: vault + '-other',
      entriesVault: vault + '-other',
      entries: [],
    }),
  );
  await waitFor(() => expect(useReminderStore.getState().vault).toBe(vault + '-other'));
  const result = await mock.reminderClaim(vault, claim.mock.calls[0][1]);
  await act(async () => finish(result));
  expect(toast).not.toHaveBeenCalled();
  act(() => useVaultStore.setState({ vaultPath: vault, entriesVault: vault, entries }));
  await waitFor(() => expect(useReminderStore.getState().reminders).toHaveLength(1));
  expect(toast).not.toHaveBeenCalled();
});

it('keeps a finished record’s body and properties quiet without reading the body', async () => {
  const type = datedType();
  const entry = makeEntry({
    path: 'visits/checkup.md',
    title: 'Checkup',
    type: 'Visit',
    properties: { due: '2026-07-29', status: 'done' },
  });
  useVaultStore.setState({ entries: [type, entry] });
  vi.mocked(ipc.readNote).mockImplementation(async (_vault, path) =>
    path === entry.path ? body : '',
  );
  renderHook(useReminders);
  await waitFor(() => expect(useReminderStore.getState().status).toBe('ready'));
  expect(ipc.readNote).not.toHaveBeenCalledWith(vault, entry.path);
  expect(toast).not.toHaveBeenCalled();
  expect(useReminderStore.getState().reminders).toEqual([]);
});
it('claims before toasting and a claimed chip stays quiet after a webview wipe', async () => {
  let finish!: (value: Awaited<ReturnType<typeof ipc.reminderClaim>>) => void;
  const claim = vi.spyOn(ipc, 'reminderClaim').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const hook = renderHook(useReminders);
  await waitFor(() => expect(claim).toHaveBeenCalledOnce());
  expect(toast).not.toHaveBeenCalled();
  const results = await mock.reminderClaim(vault, claim.mock.calls[0][1]);
  await act(async () => finish(results));
  await waitFor(() => expect(toast).toHaveBeenCalledWith('⏰ Reminder: Call vendor'));
  hook.unmount();
  toast.mockClear();
  useReminderStore.getState().reset(vault);
  localStorage.clear();
  renderHook(useReminders);
  await waitFor(() => expect(useReminderStore.getState().status).toBe('ready'));
  expect(toast).not.toHaveBeenCalled();
});
it('announces a missed window once and names a vault closure', async () => {
  const closed = new Date('2026-07-28T11:00:00').toISOString(),
    reopened = new Date('2026-07-28T12:01:00').toISOString();
  vi.setSystemTime(new Date('2026-07-28T12:02:00'));
  mock.__seedSessionWindow(vault, {
    closedAt: closed,
    reopenedAt: reopened,
    cause: 'vault',
    precision: 'clean_exact',
  });
  const hook = renderHook(useReminders);
  await waitFor(() =>
    expect(toast).toHaveBeenCalledWith(
      '⏰ A reminder passed while this vault was closed: Call vendor',
    ),
  );
  expect((await mock.reminderState(vault)).fires[0].outcome).toBe('missed');
  hook.rerender();
  expect(toast).toHaveBeenCalledOnce();
});
it('imports legacy claims once without writing the old key', async () => {
  localStorage.setItem('cerebro.firedReminders', JSON.stringify(['a.md#0@2026-07-28T12:00']));
  const write = vi.spyOn(Storage.prototype, 'setItem'),
    importer = vi.spyOn(ipc, 'reminderImport');
  renderHook(useReminders);
  await waitFor(() => expect(importer).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(Object.values(useReminderStore.getState().fires)[0]?.outcome).toBe('imported'),
  );
  expect(toast).not.toHaveBeenCalled();
  expect(write.mock.calls.some(([key]) => key === 'cerebro.firedReminders')).toBe(false);
});
it('moves a renamed page claim silently and scopes body caches to each vault', async () => {
  const r = collectReminders('a.md', body)[0];
  await mock.reminderClaim(vault, [reminderClaimFor(r, 'fired')]);
  renderHook(useReminders);
  await waitFor(() => expect(useReminderStore.getState().reminders).toHaveLength(1));
  act(() => useVaultStore.setState({ entries: [makeEntry({ path: 'b.md', modifiedAt: 'new' })] }));
  await waitFor(() =>
    expect(
      Object.values(useReminderStore.getState().fires).some(
        (f) => f.path === 'b.md' && f.outcome === 'moved',
      ),
    ).toBe(true),
  );
  expect(toast).not.toHaveBeenCalled();
  act(() => useVaultStore.setState({ vaultPath: vault + 'b', entriesVault: vault + 'b' }));
  await waitFor(() => expect(toast).toHaveBeenCalledWith('⏰ Reminder: Call vendor'));
  expect(ipc.readNote).toHaveBeenCalledWith(vault + 'b', 'b.md');
});
it('waits for the matching scan and reports failed history once before falling back', async () => {
  useVaultStore.setState({ entriesVault: '/old' });
  vi.spyOn(ipc, 'reminderState').mockRejectedValue(Error('disk'));
  renderHook(useReminders);
  expect(ipc.readNote).not.toHaveBeenCalled();
  act(() => useVaultStore.setState({ entriesVault: vault }));
  await waitFor(() => expect(toast).toHaveBeenCalledWith('⏰ Reminder: Call vendor'));
  expect(toast.mock.calls.filter(([s]) => String(s).startsWith('Reminder history'))).toHaveLength(
    1,
  );
  act(() =>
    useVaultStore.setState({ entries: [makeEntry({ path: 'a.md', modifiedAt: 'changed' })] }),
  );
  await waitFor(() => expect(ipc.readNote).toHaveBeenCalledTimes(2));
  expect(toast.mock.calls.filter(([s]) => String(s).startsWith('⏰'))).toHaveLength(1);
});
it('keeps older reminders outside both closure and grace silent', async () => {
  vi.spyOn(ipc, 'readNote').mockResolvedValue(body.replace('2026-07-28', '2026-07-20'));
  renderHook(useReminders);
  await waitFor(() => expect(useReminderStore.getState().status).toBe('ready'));
  expect(toast).not.toHaveBeenCalled();
  expect((await mock.reminderState(vault)).fires).toEqual([]);
});

it.each(['agent', 'unattributed', 'not_recorded', 'knowledge', 'unreadable', 'human'] as const)(
  'native delivery checks the last content writer: %s',
  async (writer) => {
    const post = vi.spyOn(ipc, 'postNotification').mockResolvedValue('posted');
    const ask = vi.spyOn(ipc, 'requestNotificationPermission');
    const attribution = vi.spyOn(ipc, 'pageAttribution');
    if (writer === 'unreadable') attribution.mockRejectedValue(new Error('unavailable'));
    else if (writer === 'not_recorded' || writer === 'knowledge')
      attribution.mockResolvedValue({ state: writer });
    else
      attribution.mockResolvedValue({
        state: writer === 'unattributed' ? 'unattributed' : 'recorded',
        actor: writer === 'human' ? 'human:me' : 'process:agent',
        kind: 'vault.write',
        at: now,
        run_id: null,
        approved_by: null,
      });
    renderHook(useReminders);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('⏰ Reminder: Call vendor'));
    await waitFor(() => expect(attribution).toHaveBeenCalledOnce());
    await act(async () => {
      await Promise.resolve();
    });
    expect(post).toHaveBeenCalledTimes(writer === 'human' ? 1 : 0);
    expect(ask).not.toHaveBeenCalled();
  },
);
it('two due chips toast once and post one banner; a rejection never removes the toast', async () => {
  vi.mocked(ipc.readNote).mockResolvedValue(`${body}\nBook room 📅 2026-07-28 12:00 ((remind:0d))`);
  const attribution = vi.spyOn(ipc, 'pageAttribution').mockResolvedValue({
    state: 'recorded',
    actor: 'human:me',
    kind: 'vault.write',
    at: now,
    run_id: null,
    approved_by: null,
  });
  const post = vi.spyOn(ipc, 'postNotification').mockRejectedValue(new Error('native unavailable'));
  renderHook(useReminders);
  await waitFor(() => expect(post).toHaveBeenCalledOnce());
  expect(post.mock.calls[0][1]).toBe('2 reminders');
  expect(attribution).toHaveBeenCalledOnce();
  expect(toast).toHaveBeenCalledOnce();
  expect(toast).toHaveBeenCalledWith('⏰ 2 reminders: Call vendor · Book room');
});
it('a type-level reminder posts without a page writer, even when native permission is denied', async () => {
  useVaultStore.setState({
    entries: [
      datedType(),
      makeEntry({
        path: 'visit.md',
        title: 'Checkup',
        type: 'Visit',
        properties: { due: '2026-07-29 12:00' },
      }),
    ],
  });
  vi.mocked(ipc.readNote).mockResolvedValue('');
  const attribution = vi.spyOn(ipc, 'pageAttribution');
  const post = vi.spyOn(ipc, 'postNotification').mockResolvedValue('denied');
  renderHook(useReminders);
  await waitFor(() => expect(post).toHaveBeenCalledOnce());
  expect(attribution).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith('⏰ Reminder: Checkup · Due');
});
it('a native attribution read that outlives the vault never posts', async () => {
  let finish!: (value: Awaited<ReturnType<typeof ipc.pageAttribution>>) => void;
  const attribution = vi.spyOn(ipc, 'pageAttribution').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const post = vi.spyOn(ipc, 'postNotification');
  renderHook(useReminders);
  await waitFor(() => expect(attribution).toHaveBeenCalledOnce());
  act(() => useVaultStore.setState({ vaultPath: '/other', entriesVault: null, entries: [] }));
  await act(async () =>
    finish({
      state: 'recorded',
      actor: 'human:me',
      kind: 'vault.write',
      at: now,
      run_id: null,
      approved_by: null,
    }),
  );
  expect(post).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith('⏰ Reminder: Call vendor');
});
