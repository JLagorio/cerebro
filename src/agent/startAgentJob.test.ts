import { useFollowupStore } from '@/stores/followupStore';
import type { Followup } from '@/engine/followups';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeEntry } from '@/engine/testHelpers';
import { jobQueue, runNowJob, type AgentJob } from '@/engine/jobs';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { useRunLogStore } from '@/stores/runLogStore';
import * as ipc from '@/lib/ipc';
import * as mock from '@/lib/mockIpc';
import * as agent from './agentIpc';
import { deferralText, startAgentJob } from './startAgentJob';

const { events } = vi.hoisted(() => ({
  events: { callback: null as ((event: { kind: string }) => void) | null },
}));
vi.mock('./agentIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agentIpc')>();
  return {
    startedOrThrow: actual.startedOrThrow,
    checkWake: vi.fn(async (_vault: string, _actor: string, wakes: string[]) => ({
      state: 'met',
      wakes,
    })),
    runAgent: vi.fn(async () => ({ run: 8, durableId: 'run8', sessionId: 's', attach: 'a' })),
    stopAgent: vi.fn(async () => true),
    attachRun: vi.fn(async (_handle: unknown, _after: number, callback: typeof events.callback) => {
      events.callback = callback;
      return {
        state: 'held',
        done: false,
        detach: () => {
          events.callback = null;
        },
      };
    }),
    onAgentEvent: vi.fn((callback: typeof events.callback) => {
      events.callback = callback;
      return () => {
        events.callback = null;
      };
    }),
  };
});
vi.mock('./systemPrompt', () => ({ buildSystemPrompt: vi.fn(() => 'system') }));
vi.mock('@/lib/ipc', async () => ({
  ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
  readNote: vi.fn(async () => '# Instructions'),
  claimFollowup: vi.fn(),
  fleetActorSummary: vi.fn(async () => ({ last_outcome: null })),
  reviewQueue: vi.fn(async () => []),
  jobLedgerClaim: vi.fn(async (...args: Parameters<typeof mock.jobLedgerClaim>) =>
    mock.jobLedgerClaim(...args),
  ),
  jobLedgerUnclaim: vi.fn(async (...args: Parameters<typeof mock.jobLedgerUnclaim>) =>
    mock.jobLedgerUnclaim(...args),
  ),
}));
const NOW = new Date(2026, 6, 28, 12);
const entry = makeEntry({
  path: 'agents/scout.md',
  title: 'Scout',
  type: 'Agent',
  properties: { slug: 'scout', schedule: 'daily 08:00' },
});
const ctx = () => ({ vaultPath: '/vault', onSettled: vi.fn(), onHold: vi.fn() });
const manual = () => runNowJob(entry, { skillRuns: {}, now: NOW });
const queue = (): AgentJob => {
  const job = manual();
  delete job.manual;
  return job;
};
beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(agent.checkWake)
    .mockReset()
    .mockImplementation(async (_vault, _actor, wakes) => ({ state: 'met', wakes }));
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mock.resetOperational();
  const held = await mock.jobLedgerRead('/vault');
  for (const ledger of ['attempts', 'skillRuns', 'triggerRuns'] as const)
    for (const [key, runKey] of Object.entries(held[ledger]))
      await mock.jobLedgerUnclaim('/vault', ledger, key, runKey);
  vi.mocked(ipc.readNote).mockResolvedValue('# Instructions');
  vi.mocked(ipc.jobLedgerClaim).mockImplementation(async (...args) => mock.jobLedgerClaim(...args));
  vi.mocked(ipc.jobLedgerUnclaim).mockImplementation(async (...args) =>
    mock.jobLedgerUnclaim(...args),
  );
  vi.mocked(agent.runAgent).mockResolvedValue({
    run: 8,
    durableId: 'run8',
    sessionId: 's',
    attach: 'a',
  });
  useVaultStore.setState({
    vaultPath: '/vault',
    entriesVault: '/vault',
    entries: [entry],
    rescan: vi.fn(async () => {}),
  });
  useUiStore.setState({
    runs: [],
    skillRuns: {},
    triggerRuns: {},
    learnAttempts: {},
    autoLearn: false,
  });
  useRunLogStore.setState({ entries: [] });
  events.callback = null;
  vi.mocked(agent.attachRun)
    .mockReset()
    .mockImplementation(async (_handle, _after, deliver) => {
      events.callback = deliver as (event: { kind: string }) => void;
      return {
        state: 'held',
        done: false,
        detach: () => {
          events.callback = null;
        },
      };
    });
});
afterEach(() => {
  events.callback?.({ kind: 'Done' });
  vi.useRealTimers();
});

it('a queue job reads then claims then starts, and settles before its registry row leaves', async () => {
  const context = ctx();
  context.onSettled.mockImplementation(() => expect(useUiStore.getState().runs).toHaveLength(1));
  expect(await startAgentJob(queue(), context)).toEqual({ kind: 'started', run: 8 });
  expect(vi.mocked(ipc.readNote).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(ipc.jobLedgerClaim).mock.invocationCallOrder[0],
  );
  expect(vi.mocked(ipc.jobLedgerClaim).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(agent.runAgent).mock.invocationCallOrder[0],
  );
  events.callback?.({ kind: 'Done' });
  expect(context.onSettled).toHaveBeenCalledOnce();
  expect(useUiStore.getState().runs).toEqual([]);
  expect(useRunLogStore.getState().entries[0]).toMatchObject({ trigger: 'schedule', status: 'ok' });
});
it('a manual start takes a due fire through the real mock ledger and the queue no longer derives it', async () => {
  const job = manual();
  await startAgentJob(job, ctx());
  expect(vi.mocked(agent.runAgent).mock.calls[0][1]).toMatchObject({
    lane: 'agent',
    attended: false,
    cause: {
      kind: 'manual',
      subject: entry.path,
      detail: 'in place of its run due 2026-07-28 08:00',
    },
  });
  const ledgers = await mock.jobLedgerRead('/vault');
  expect(ledgers.skillRuns[job.key]).toBe(job.runKey);
  expect(jobQueue([entry], [], { attempts: {}, skillRuns: ledgers.skillRuns, now: NOW })).toEqual(
    [],
  );
  events.callback?.({ kind: 'Done' });
  expect(useRunLogStore.getState().entries[0]).toMatchObject({ trigger: 'manual' });
  expect(useRunLogStore.getState().entries[0]).not.toHaveProperty('dueAt');
  expect(useUiStore.getState().triggerRuns).toEqual({});
});
it('a manual start that loses a fire still runs without claiming that fire in its cause', async () => {
  vi.mocked(ipc.jobLedgerClaim).mockResolvedValue(false);
  await startAgentJob(manual(), ctx());
  expect(vi.mocked(agent.runAgent).mock.calls[0][1].cause).toEqual({
    kind: 'manual',
    subject: entry.path,
  });
  expect(ipc.jobLedgerUnclaim).not.toHaveBeenCalled();
});
it('nothing due claims nothing and a manual deferral cannot give back another call’s fire', async () => {
  const job = manual();
  job.ledger = null;
  vi.mocked(agent.runAgent).mockResolvedValue({
    deferred: ['global_pause'],
    words: ['background work is paused'],
  });
  expect(await startAgentJob(job, ctx())).toMatchObject({ kind: 'deferred', gaveBack: false });
  expect(ipc.jobLedgerClaim).not.toHaveBeenCalled();
  expect(ipc.jobLedgerUnclaim).not.toHaveBeenCalled();
});
it('a deferral holds then returns its won claim and logs the supplied words', async () => {
  vi.mocked(agent.runAgent).mockResolvedValue({
    deferred: ['global_pause'],
    words: ['background work is paused'],
  });
  const context = ctx();
  expect(await startAgentJob(manual(), context)).toMatchObject({
    kind: 'deferred',
    gaveBack: true,
  });
  expect(context.onHold.mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(ipc.jobLedgerUnclaim).mock.invocationCallOrder[0],
  );
  expect((await mock.jobLedgerRead('/vault')).skillRuns).toEqual({});
  expect(useRunLogStore.getState().entries[0].error).toBe(
    'deferred by the budget gate: background work is paused',
  );
});
it('a failed body read holds without taking a fire or spawning', async () => {
  vi.mocked(ipc.readNote).mockRejectedValue(new Error('no bytes'));
  const context = ctx();
  expect(await startAgentJob(manual(), context)).toMatchObject({ kind: 'failed', recorded: false });
  expect(ipc.jobLedgerClaim).not.toHaveBeenCalled();
  expect(agent.runAgent).not.toHaveBeenCalled();
  expect(context.onHold).toHaveBeenCalledOnce();
});
it('a Rust refusal gives its fire back, holds, and logs Rust’s words', async () => {
  vi.mocked(agent.runAgent).mockRejectedValue(new Error('Scout is already running'));
  const context = ctx();
  expect(await startAgentJob(manual(), context)).toMatchObject({
    kind: 'failed',
    error: 'Scout is already running',
    recorded: false,
  });
  expect((await mock.jobLedgerRead('/vault')).skillRuns).toEqual({});
  expect(context.onHold).toHaveBeenCalledOnce();
  expect(useRunLogStore.getState().entries[0].error).toBe(
    'did not start: Scout is already running',
  );
});
it('a vault switch during the body read abandons before claiming', async () => {
  vi.mocked(ipc.readNote).mockImplementation(async () => {
    useVaultStore.setState({ vaultPath: '/other' });
    return 'body';
  });
  expect(await startAgentJob(manual(), ctx())).toEqual({ kind: 'moved' });
  expect(ipc.jobLedgerClaim).not.toHaveBeenCalled();
  expect(agent.runAgent).not.toHaveBeenCalled();
});
it('deferralText names an unknown code and an empty dispatch without inventing a reason', () => {
  expect(deferralText(['future_gate'])).toBe('the budget gate said future_gate');
  expect(deferralText([])).toBe('the dispatcher found nothing to start');
});

const wakeJob = (ids = ['one', 'two']): AgentJob => ({
  ...queue(),
  ledger: 'wakes',
  key: 'scout#wake',
  runKey: ids[0],
  cooldownKey: 'slug:scout',
  wake: {
    claim: ids[0],
    coalesce: ids.slice(1),
    trigger: { event: 'changed', ask: 'Should we act?' },
    admittedAt: NOW.toISOString(),
    deferredBefore: null,
  },
});
it('checks twenty wakes together before reading instructions or starting one full run', async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `wake${i}`);
  const checkedYes = new Set<string>();
  await startAgentJob(wakeJob(ids), { ...ctx(), checkedYes });
  expect(agent.checkWake).toHaveBeenCalledExactlyOnceWith(
    '/vault',
    'process:scout',
    ids,
    'Should we act?',
  );
  expect(vi.mocked(agent.checkWake).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(ipc.readNote).mock.invocationCallOrder[0],
  );
  expect(agent.runAgent).toHaveBeenCalledOnce();
  expect(vi.mocked(agent.runAgent).mock.calls[0][1].wake).toEqual({
    claim: ids[0],
    coalesce: ids.slice(1),
  });
  expect(checkedYes).toEqual(new Set(ids));
});
it.each(['not_met', 'gone'] as const)(
  'a %s starts no full run and stamps no cooldown',
  async (state) => {
    vi.mocked(agent.checkWake).mockResolvedValue({ state, wakes: ['one', 'two'] });
    expect(await startAgentJob(wakeJob(), ctx())).toEqual({ kind: 'answered' });
    expect(agent.runAgent).not.toHaveBeenCalled();
    expect(ipc.readNote).not.toHaveBeenCalled();
    expect(useUiStore.getState().triggerRuns).toEqual({});
  },
);
it('keeps only checked survivors and promotes their first wake to the head', async () => {
  vi.mocked(agent.checkWake).mockResolvedValue({ state: 'met', wakes: ['two', 'not-in-this-job'] });
  await startAgentJob(wakeJob(), ctx());
  expect(vi.mocked(agent.runAgent).mock.calls[0][1].wake).toEqual({ claim: 'two', coalesce: [] });
});
it('a previously met wake survives a newer no without repeating its check', async () => {
  vi.mocked(agent.checkWake).mockResolvedValue({ state: 'not_met', wakes: ['two'] });
  await startAgentJob(wakeJob(), { ...ctx(), checkedYes: new Set(['one']) });
  expect(agent.checkWake).toHaveBeenCalledWith(
    '/vault',
    'process:scout',
    ['two'],
    'Should we act?',
  );
  expect(vi.mocked(agent.runAgent).mock.calls[0][1].wake).toEqual({ claim: 'one', coalesce: [] });
});
it('a met wake is not checked again after its full run is deferred', async () => {
  const context = { ...ctx(), checkedYes: new Set<string>() };
  vi.mocked(agent.runAgent).mockResolvedValueOnce({
    deferred: ['global_pause'],
    words: ['background work is paused'],
  });
  expect((await startAgentJob(wakeJob(), context)).kind).toBe('deferred');
  expect(useUiStore.getState().triggerRuns).toEqual({});
  await startAgentJob(wakeJob(), context);
  expect(agent.checkWake).toHaveBeenCalledOnce();
  expect(agent.runAgent).toHaveBeenCalledTimes(2);
});
it('an unavailable check holds only its wakes until the returned retry time', async () => {
  const retry_at = new Date(NOW.getTime() + 180000).toISOString();
  vi.mocked(agent.checkWake).mockResolvedValue({
    state: 'unavailable',
    wakes: ['one'],
    retry_at,
    skipped: false,
  });
  const onCheckHold = vi.fn();
  expect(await startAgentJob(wakeJob(), { ...ctx(), onCheckHold })).toEqual({ kind: 'answered' });
  expect(onCheckHold).toHaveBeenCalledExactlyOnceWith(['one'], retry_at);
  expect(agent.runAgent).not.toHaveBeenCalled();
  expect(useUiStore.getState().triggerRuns).toEqual({});
});
it('a skipped unavailable check leaves no local retry', async () => {
  vi.mocked(agent.checkWake).mockResolvedValue({
    state: 'unavailable',
    wakes: ['one', 'two'],
    retry_at: null,
    skipped: true,
  });
  const onCheckHold = vi.fn();
  await startAgentJob(wakeJob(), { ...ctx(), onCheckHold });
  expect(onCheckHold).not.toHaveBeenCalled();
  expect(agent.runAgent).not.toHaveBeenCalled();
});
it('a check deferral uses its words once and consumes no wake or cooldown', async () => {
  vi.mocked(agent.checkWake).mockResolvedValue({
    state: 'deferred',
    wakes: ['one', 'two'],
    reasons: ['global_pause'],
    words: ['background work is paused'],
  });
  const refreshWakes = vi.fn(async () => {});
  expect(await startAgentJob(wakeJob(), { ...ctx(), refreshWakes })).toEqual({
    kind: 'deferred',
    reasons: ['global_pause'],
    words: ['background work is paused'],
    gaveBack: false,
  });
  expect(useRunLogStore.getState().entries[0].error).toBe(
    'deferred by the budget gate: background work is paused',
  );
  expect(agent.runAgent).not.toHaveBeenCalled();
  expect(ipc.jobLedgerClaim).not.toHaveBeenCalled();
  expect(useUiStore.getState().triggerRuns).toEqual({});
  const deferredJob = wakeJob();
  deferredJob.wake!.deferredBefore = 'global_pause';
  await startAgentJob(deferredJob, ctx());
  expect(useRunLogStore.getState().entries).toHaveLength(1);
});
it('a vault switch while checking abandons without caching its yes or starting', async () => {
  vi.mocked(agent.checkWake).mockImplementation(async () => {
    useVaultStore.setState({ vaultPath: '/other' });
    return { state: 'met', wakes: ['one', 'two'] };
  });
  const checkedYes = new Set<string>();
  expect(await startAgentJob(wakeJob(), { ...ctx(), checkedYes })).toEqual({ kind: 'moved' });
  expect(checkedYes.size).toBe(0);
  expect(agent.runAgent).not.toHaveBeenCalled();
});

it('replays a terminal error emitted before the start response and releases the queue', async () => {
  const terminal = { run: 8, seq: 1, kind: 'Error', message: 'fast failure' } as const;
  const off = vi.fn();
  let emitted = false;
  vi.mocked(agent.runAgent).mockImplementation(async () => {
    emitted = true;
    return { run: 8, durableId: 'run8', attach: 'run8' };
  });
  vi.mocked(agent.attachRun).mockImplementation(async (handle, after, deliver) => {
    expect(emitted).toBe(true);
    expect(handle).toMatchObject({ run: 8, attach: 'run8' });
    expect(after).toBe(0);
    deliver(terminal);
    return { state: 'held', done: true, detach: off };
  });
  const context = ctx();
  expect(await startAgentJob(manual(), context)).toEqual({ kind: 'started', run: 8 });
  expect(context.onSettled).toHaveBeenCalledOnce();
  expect(off).toHaveBeenCalledOnce();
  expect(useUiStore.getState().runs).toEqual([]);
  expect(useRunLogStore.getState().entries[0]).toMatchObject({
    status: 'failed',
    error: 'fast failure',
  });
});
// M91.2d: an Error under an Agent call is that subagent's, as Rust's reader
// takes it (M91.3b): the run goes on, and only its own Error or Done ends it.
it("a subagent's Error neither fails nor ends the run it ran in", async () => {
  const context = ctx();
  expect(await startAgentJob(manual(), context)).toEqual({ kind: 'started', run: 8 });
  const subagents = {
    kind: 'Error',
    message: 'API Error: Request rejected (429)',
    parent: 'toolu_agent',
  } as const;
  events.callback?.(subagents);
  expect(context.onSettled).not.toHaveBeenCalled();
  expect(useUiStore.getState().runs).toHaveLength(1);
  events.callback?.({ kind: 'Done' });
  expect(context.onSettled).toHaveBeenCalledOnce();
  expect(useUiStore.getState().runs).toEqual([]);
  const [entry] = useRunLogStore.getState().entries;
  expect(entry).toMatchObject({ status: 'ok' });
  expect(entry).not.toHaveProperty('error');
});
it("the run's own Error after a subagent's still fails it, in its own words", async () => {
  const context = ctx();
  await startAgentJob(manual(), context);
  const subagents = { kind: 'Error', message: 'the researcher stopped', parent: 'toolu_agent' };
  const own = { kind: 'Error', message: 'the run stopped' };
  events.callback?.(subagents);
  events.callback?.(own);
  expect(context.onSettled).toHaveBeenCalledOnce();
  expect(useRunLogStore.getState().entries[0]).toMatchObject({
    status: 'failed',
    error: 'the run stopped',
  });
});
it('an unknown run journal ends the registry with an honest failure', async () => {
  vi.mocked(agent.attachRun).mockResolvedValue({ state: 'unknown' });
  await startAgentJob(manual(), ctx());
  expect(useUiStore.getState().runs).toEqual([]);
  expect(useRunLogStore.getState().entries[0]).toMatchObject({
    status: 'failed',
    error: "Couldn't read this run's events, so its outcome is unknown.",
  });
});

const laterRow = (): Followup => ({
  followupId: 'later',
  actor: 'process:scout',
  note: 'check the reply',
  dueAt: NOW.toISOString(),
  requestedAt: NOW.toISOString(),
  requestedByRun: 'old',
  state: 'pending',
  claimedAt: null,
  runId: null,
  endedAt: null,
  cancelReason: null,
});
const laterJob = (): AgentJob => ({
  ...queue(),
  key: 'followup:later',
  runKey: 'followup:later',
  ledger: 'followup',
  cooldownKey: null,
  followup: laterRow(),
});
it('a follow-up claims before reading and runs with the stored note and bound id', async () => {
  const row = { ...laterRow(), note: 'stored note', state: 'claimed' as const };
  vi.mocked(ipc.claimFollowup).mockResolvedValue({ state: 'claimed', row });
  await startAgentJob(laterJob(), ctx());
  expect(vi.mocked(ipc.claimFollowup).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(ipc.readNote).mock.invocationCallOrder[0],
  );
  expect(ipc.jobLedgerClaim).not.toHaveBeenCalled();
  expect(agent.runAgent).toHaveBeenCalledWith(
    '/vault',
    expect.objectContaining({
      followup: 'later',
      cause: { kind: 'followup', subject: 'stored note', due_at: row.dueAt },
    }),
  );
  events.callback?.({ kind: 'Done' });
  expect(useRunLogStore.getState().entries[0]).toMatchObject({ trigger: 'followup', status: 'ok' });
});
it('a follow-up that was already claimed or cancelled starts nothing and reads no body', async () => {
  for (const answer of [
    { state: 'not_waiting' } as const,
    { state: 'cancelled', reason: 'paused' } as const,
  ]) {
    vi.mocked(ipc.claimFollowup).mockResolvedValue(answer);
    await startAgentJob(laterJob(), ctx());
  }
  expect(ipc.readNote).not.toHaveBeenCalled();
  expect(agent.runAgent).not.toHaveBeenCalled();
  expect(useRunLogStore.getState().entries).toEqual([]);
});
it('a follow-up deferral holds for fifteen minutes, records one row, and never touches the schedule ledger', async () => {
  useFollowupStore.getState().reset('/vault');
  mock.__seedFollowups([{ vault: '/vault', ...laterRow() }]);
  vi.mocked(ipc.claimFollowup).mockResolvedValue({ state: 'claimed', row: laterRow() });
  vi.mocked(agent.runAgent).mockResolvedValue({
    deferred: ['agent_running'],
    words: ['this agent is already running'],
  });
  await startAgentJob(laterJob(), ctx());
  expect(useFollowupStore.getState().held.later).toBe(NOW.getTime() + 15 * 60_000);
  expect(ipc.jobLedgerUnclaim).not.toHaveBeenCalled();
  expect(useRunLogStore.getState().entries).toHaveLength(1);
});
it('a body read failure after claiming holds its stale-claim retry without falsely finishing it', async () => {
  useFollowupStore.getState().reset('/vault');
  mock.__seedFollowups([{ vault: '/vault', ...laterRow(), state: 'claimed' }]);
  vi.mocked(ipc.claimFollowup).mockResolvedValue({ state: 'claimed', row: laterRow() });
  vi.mocked(ipc.readNote).mockRejectedValue(Error('unreadable'));
  await startAgentJob(laterJob(), ctx());
  expect(agent.runAgent).not.toHaveBeenCalled();
  expect(useFollowupStore.getState().held.later).toBe(NOW.getTime() + 15 * 60_000);
  expect((await mock.listFollowups('/vault'))[0].state).toBe('claimed');
});

it('a delayed follow-up deferral cannot hold or refresh the newly opened vault', async () => {
  useFollowupStore.getState().reset('/vault');
  vi.mocked(ipc.claimFollowup).mockResolvedValue({ state: 'claimed', row: laterRow() });
  let resolve!: (start: agent.RunStart) => void;
  vi.mocked(agent.runAgent).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const starting = startAgentJob(laterJob(), ctx());
  await vi.waitFor(() => expect(agent.runAgent).toHaveBeenCalled());
  useVaultStore.setState({ vaultPath: '/other', entriesVault: '/other', entries: [] });
  const refresh = vi.spyOn(useFollowupStore.getState(), 'refresh');
  resolve({ deferred: ['agent_running'], words: ['this agent is already running'] });
  await starting;
  expect(useFollowupStore.getState().held).toEqual({});
  expect(useFollowupStore.getState().vault).toBe('/other');
  expect(refresh).not.toHaveBeenCalledWith('/other');
  expect(useRunLogStore.getState().entries).toEqual([]);
  refresh.mockRestore();
});

it('an unexpected observed generation cannot attach an unkeyed job or report claimed wakes', async () => {
  vi.mocked(agent.runAgent).mockResolvedValueOnce({
    observed_generation: {
      generationId: '11111111111111111111111111111111',
      firstRunId: '22222222222222222222222222222222',
      currentRunId: '33333333333333333333333333333333',
      state: 'running',
    },
  });
  const onClaimedWakes = vi.fn();
  const result = await startAgentJob(wakeJob(), { ...ctx(), onClaimedWakes });
  expect(result).toMatchObject({ kind: 'failed', recorded: false });
  expect(result).not.toHaveProperty('run');
  expect(agent.attachRun).not.toHaveBeenCalled();
  expect(agent.stopAgent).not.toHaveBeenCalled();
  expect(onClaimedWakes).not.toHaveBeenCalled();
  expect(useUiStore.getState().runs).toEqual([]);
  expect(useUiStore.getState().triggerRuns).toEqual({});
  expect(useRunLogStore.getState().entries[0]).toMatchObject({ status: 'failed' });
  expect(useRunLogStore.getState().entries[0]).not.toHaveProperty('durableId');
});
