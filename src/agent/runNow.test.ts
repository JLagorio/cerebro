import { beforeEach, expect, it, vi } from 'vitest';
import { makeEntry } from '@/engine/testHelpers';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { pausedAgents } from '@/lib/ipc';
import { startAgentJob, type JobStart } from './startAgentJob';
import { runAgentNow } from './runNow';
vi.mock('./startAgentJob', async () => ({
  ...(await vi.importActual<typeof import('./startAgentJob')>('./startAgentJob')),
  startAgentJob: vi.fn(async () => ({ kind: 'started', run: 8 })),
}));
vi.mock('@/lib/ipc', async () => ({
  ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
  pausedAgents: vi.fn(async () => []),
}));
const entry = makeEntry({
  path: 'agents/scout.md',
  type: 'Agent',
  title: 'Scout',
  properties: { slug: 'scout', schedule: 'daily 08:00' },
});
const toast = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(startAgentJob).mockResolvedValue({ kind: 'started', run: 8 });
  vi.mocked(pausedAgents).mockResolvedValue([]);
  useVaultStore.setState({ vaultPath: '/vault', entriesVault: '/vault', entries: [entry] });
  useUiStore.setState({ runs: [], skillRuns: {}, autoLearn: false, toast, toasts: [] });
});
it('a gone page, opening vault and page pause each refuse before starting', async () => {
  expect(await runAgentNow('gone.md')).toBe(false);
  expect(toast).toHaveBeenLastCalledWith("Not started — that agent's page is gone.");
  useVaultStore.setState({ entriesVault: '/other' });
  expect(await runAgentNow(entry.path)).toBe(false);
  expect(toast).toHaveBeenLastCalledWith('Not started — the vault is still opening.');
  useVaultStore.setState({
    entriesVault: '/vault',
    entries: [{ ...entry, properties: { ...entry.properties, paused: true } }],
  });
  expect(await runAgentNow(entry.path)).toBe(false);
  expect(toast).toHaveBeenLastCalledWith('Scout is paused. Resume it to run it now.');
  expect(startAgentJob).not.toHaveBeenCalled();
});
it('a registry job or fleet pause refuses by name', async () => {
  useUiStore.setState({
    runs: [
      {
        id: 'job',
        owner: 'job',
        path: entry.path,
        label: 'Scout',
        place: null,
        conversationId: null,
        run: 2,
        startedAt: 0,
      },
    ],
  });
  expect(await runAgentNow(entry.path)).toBe(false);
  expect(toast).toHaveBeenLastCalledWith(
    'Scout is already running. Let that run finish, or stop it first.',
  );
  useUiStore.setState({ runs: [] });
  vi.mocked(pausedAgents).mockResolvedValue(['process:scout']);
  expect(await runAgentNow(entry.path)).toBe(false);
  expect(toast).toHaveBeenLastCalledWith(
    'Scout is paused on the fleet. Resume it there to run it now.',
  );
  expect(startAgentJob).not.toHaveBeenCalled();
});
it('a pending start reserves the page before its first read', async () => {
  let finish!: (result: string[]) => void;
  vi.mocked(pausedAgents).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = runAgentNow(entry.path);
  expect(await runAgentNow(entry.path)).toBe(false);
  expect(pausedAgents).toHaveBeenCalledOnce();
  finish([]);
  await first;
  expect(startAgentJob).toHaveBeenCalledOnce();
});
it('an unreadable fleet pause proceeds to Rust, with Learn on its own off', async () => {
  vi.mocked(pausedAgents).mockRejectedValue(new Error('unavailable'));
  expect(await runAgentNow(entry.path)).toMatchObject({ kind: 'started' });
  expect(vi.mocked(startAgentJob).mock.calls[0][0]).toMatchObject({
    manual: true,
    kind: 'agent',
    ledger: 'skillRuns',
  });
  expect(vi.mocked(startAgentJob).mock.calls[0][1]).not.toHaveProperty('onHold');
});
it('an agent without a schedule starts without a ledger', async () => {
  useVaultStore.setState({ entries: [{ ...entry, properties: { slug: 'scout' } }] });
  await runAgentNow(entry.path);
  expect(vi.mocked(startAgentJob).mock.calls[0][0]).toMatchObject({ ledger: null, manual: true });
});
it.each([
  [
    {
      kind: 'deferred',
      reasons: ['global_pause'],
      words: ['background work is paused'],
      gaveBack: true,
    },
    "Scout didn't start: background work is paused. Its scheduled run is still owed.",
  ],
  [
    { kind: 'failed', error: 'permission refused', recorded: false },
    "Scout didn't start: permission refused",
  ],
  [{ kind: 'moved' }, 'Not started — the vault changed before Scout could start.'],
] as [JobStart, string][])('names a refused result in words', async (result, words) => {
  vi.mocked(startAgentJob).mockResolvedValue(result);
  await runAgentNow(entry.path);
  expect(toast).toHaveBeenLastCalledWith(words);
});
it('a vault switch or new page pause during the fleet read starts nothing', async () => {
  vi.mocked(pausedAgents).mockImplementation(async () => {
    useVaultStore.setState({ vaultPath: '/other' });
    return [];
  });
  expect(await runAgentNow(entry.path)).toBe(false);
  expect(startAgentJob).not.toHaveBeenCalled();
  useVaultStore.setState({ vaultPath: '/vault' });
  vi.mocked(pausedAgents).mockImplementation(async () => {
    useVaultStore.setState({ entries: [{ ...entry, properties: { paused: true } }] });
    return [];
  });
  expect(await runAgentNow(entry.path)).toBe(false);
  expect(startAgentJob).not.toHaveBeenCalled();
});
it('an unexpected start failure never escapes and releases the reservation', async () => {
  vi.mocked(startAgentJob).mockRejectedValueOnce(new Error('gone'));
  expect(await runAgentNow(entry.path)).toBe(false);
  expect(toast).toHaveBeenLastCalledWith("Scout didn't start: gone");
  expect(await runAgentNow(entry.path)).toMatchObject({ kind: 'started' });
});
