import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLedgerStore } from '@/stores/ledgerStore';
import type { JobLedgers, LedgerStatus } from '@/lib/ipc';
import { act, cleanup, renderHook } from '@testing-library/react';

const handlers: Array<(event: unknown) => void> = [];
/** The run id the mocked runAgent hands back for every job. */
const JOB_RUN = 8;
/** M33.7: `runAgent` hands back BOTH ids — the process tag the stream is
 * filtered by, and the durable id the run's database row is keyed under. */
const JOB_DURABLE = 'durable-job-8';
vi.mock('./agentIpc', () => ({
  runAgent: vi.fn(async () => ({ run: JOB_RUN, durableId: JOB_DURABLE })),
  stopAgent: vi.fn(async () => true),
  // Honours the run filter, like the real fan-out (M17.3): a job hears its
  // own run and nothing else.
  onAgentEvent: vi.fn((handler: (event: unknown) => void, run?: number) => {
    const scoped =
      run === undefined
        ? handler
        : (event: unknown) => {
            if ((event as { run?: number }).run === run) handler(event);
          };
    handlers.push(scoped);
    return () => {
      const i = handlers.indexOf(scoped);
      if (i >= 0) handlers.splice(i, 1);
    };
  }),
}));
// The runner only needs the prompt string. A spy, so a test can read the
// grant each job composes its prompt for (M54.7).
vi.mock('./systemPrompt', () => ({ buildSystemPrompt: vi.fn(() => 'sys') }));
// Scheduled runs read their record's body before consuming the fire key.
// The durable ledgers (M34.2.3) are mocked at the wire so each test controls
// hydration and the claim verdict without sharing mockIpc's module state.
vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return {
    ...actual,
    readNote: vi.fn(async () => '---\ntype: Skill\n---\nplaybook'),
    // Real by default; a test parks it to hold a start-up open (M53.10).
    reviewQueue: vi.fn(actual.reviewQueue),
    jobLedgerRead: vi.fn(async () => ({ attempts: {}, skillRuns: {}, triggerRuns: {} })),
    jobLedgerClaim: vi.fn(async () => true),
    jobLedgerUnclaim: vi.fn(async () => true),
    jobLedgerStamp: vi.fn(async () => undefined),
    jobLedgerImport: vi.fn(async () => 0),
    // M63.1: the real mock wake store by default; a test fails one.
    admitWakes: vi.fn(actual.admitWakes),
    wakesPending: vi.fn(actual.wakesPending),
    cancelWakes: vi.fn(actual.cancelWakes),
  };
});

import * as agentIpc from './agentIpc';
import { buildSystemPrompt } from './systemPrompt';
import { pausedByHook, useJobRunner } from './useJobRunner';
import { makeEntry } from '@/engine/testHelpers';
import { parseTriggers } from '@/engine/triggers';
import { triggerWords } from '@/engine/wakes';
import { mentionedTools } from '@/engine/toolGrant';
import type { Entry } from '@/engine/types';
import * as ipc from '@/lib/ipc';
import * as mockIpc from '@/lib/mockIpc';
import { useRunLogStore } from '@/stores/runLogStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/** Mirrors the runner's SETTLE_MS — how long a burst of edits gets to settle. */
const SETTLE = 4_000;

/**
 * The job this file drives the runner with.
 *
 * A SCHEDULED SKILL since M26.4j: the distillation lanes are gone, so an
 * ordinary note produces no background job at all — reading one is the Rust
 * ingest pass's, and nothing in this hook can start it. What is asserted here
 * has never been about learning anyway; it is about who owns a stream.
 */
const note = makeEntry({
  path: 'records/skills/digest.md',
  title: 'Digest',
  type: 'Skill',
  snippet: 'playbook',
  properties: { schedule: 'daily 09:00' },
});

/** Advance past the settle timer and flush the run's async start-up. */
async function startJob(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SETTLE);
  });
}

const MINUTE = 60_000;

/**
 * Let the clock run, in steps, then one settle. An async `act` holds React's
 * renders until its scope ends, so one long advance re-derives the queue
 * ONCE, at the end, and the job it finds then has not started when the scope
 * returns. Each step renders what its ticks changed, and the next step lets
 * that render's settle timer fire. In a quiet vault the derivation only gains
 * jobs as time passes, so a job due anywhere inside a step is due at its end.
 */
async function advance(ms: number, step = MINUTE): Promise<void> {
  for (let left = ms; left > 0; left -= step) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(step, left));
    });
  }
  await startJob();
}

/** A ledger status whose writer is held — the normal, recording state. */
const recordingStatus: LedgerStatus = {
  verdict: 'valid',
  detail: 'valid',
  head: null,
  seq: null,
  segments: 1,
  anomalies: 0,
  reconciliation_open: false,
  divergences: [],
  quarantined: [],
  stopped: false,
  history_unreadable: false,
  approved_supersessions: [],
  recorded_human: [],
  writer: { state: 'held', detail: null },
};

/** Restore the ledger wire mocks to their defaults: hydration finds an empty
 * table, every claim is fresh. Called from each describe's beforeEach — the
 * mocks are module-level and a verdict one test scripted must not leak. */
function resetLedgerMocks(): void {
  // M49.2: the knowledge lanes run only while the vault is recording.
  useLedgerStore.setState({ vault: '/vault', read: { kind: 'read', status: recordingStatus } });
  vi.mocked(ipc.jobLedgerRead).mockReset();
  vi.mocked(ipc.jobLedgerRead).mockImplementation(async () => ({
    attempts: {},
    skillRuns: {},
    triggerRuns: {},
  }));
  vi.mocked(ipc.jobLedgerClaim).mockReset();
  vi.mocked(ipc.jobLedgerClaim).mockImplementation(async () => true);
  vi.mocked(ipc.jobLedgerUnclaim).mockReset();
  vi.mocked(ipc.jobLedgerUnclaim).mockImplementation(async () => true);
  vi.mocked(ipc.jobLedgerStamp).mockReset();
  vi.mocked(ipc.jobLedgerStamp).mockImplementation(async () => undefined);
  vi.mocked(ipc.jobLedgerImport).mockReset();
  vi.mocked(ipc.jobLedgerImport).mockImplementation(async () => 0);
  // M63.1: an empty wake store, read and written through the real mock.
  mockIpc.resetOperational();
  vi.mocked(ipc.admitWakes).mockReset();
  vi.mocked(ipc.admitWakes).mockImplementation((vault, wakes) => mockIpc.admitWakes(vault, wakes));
  vi.mocked(ipc.wakesPending).mockReset();
  vi.mocked(ipc.wakesPending).mockImplementation((vault) => mockIpc.wakesPending(vault));
  vi.mocked(ipc.cancelWakes).mockReset();
  vi.mocked(ipc.cancelWakes).mockImplementation((vault, cancels) =>
    mockIpc.cancelWakes(vault, cancels),
  );
}

/** The run each woken start claimed, newest last (M63.1). */
const wokenRuns: string[] = [];

/**
 * `runAgent` as Rust answers a woken run (M63.1): it claims the wake in the
 * mock store, as `dispatch::claim_woken` claims it with the lease, and a
 * budget gate standing in `gate` defers it there. Anything else starts.
 */
function wokenRunAgent(gate: { deferred: string[] } | null = null): void {
  vi.mocked(agentIpc.runAgent).mockImplementation(async (vault, options) => {
    if (options.wake != null) {
      if (gate !== null) {
        mockIpc.deferMockWake(options.wake.claim, gate.deferred);
        return gate;
      }
      const runId = `woken-${wokenRuns.length + 1}`;
      const woken = mockIpc.claimMockWake(vault, options.actor ?? '', options.wake, runId);
      if (woken === 'gone') return { settled: 'gone' };
      if ('deferred' in woken) return { deferred: woken.deferred };
      wokenRuns.push(runId);
    }
    return { run: JOB_RUN, durableId: JOB_DURABLE };
  });
}

/** The job's run says Done, and the wake its claim started finishes. */
function jobDone(): void {
  act(() => handlers.forEach((h) => h({ run: JOB_RUN, kind: 'Done' })));
  const last = wokenRuns.at(-1);
  if (last !== undefined) mockIpc.finishMockWake(last, 'succeeded');
}

/** Every wake in the mock store: key letter, state, outcome, reason, detail. */
function wakeRows(): string[] {
  const holder = window as unknown as { __cerebroMockWakes: () => mockIpc.MockWake[] };
  return holder
    .__cerebroMockWakes()
    .map((w) =>
      [w.cause.subject, w.state, w.outcome, w.reason, w.detail].filter(Boolean).join(' '),
    );
}

/**
 * One vault's job_ledger table behind the wire mocks, for the tests that
 * relaunch: what the table holds across the launch is what they are about.
 * The store's rules (runtime/job_ledger.rs, mirrored by mockIpc): a claim is
 * fresh unless its slot already holds that run key, an unclaim deletes only
 * its own run key, and an import never overwrites a slot the table holds.
 */
function durableTable(): JobLedgers {
  const table: JobLedgers = { attempts: {}, skillRuns: {}, triggerRuns: {} };
  vi.mocked(ipc.jobLedgerRead).mockImplementation(async () => ({
    attempts: { ...table.attempts },
    skillRuns: { ...table.skillRuns },
    triggerRuns: { ...table.triggerRuns },
  }));
  vi.mocked(ipc.jobLedgerClaim).mockImplementation(async (_vault, ledger, key, runKey) => {
    if (table[ledger][key] === runKey) return false;
    table[ledger][key] = runKey;
    return true;
  });
  vi.mocked(ipc.jobLedgerUnclaim).mockImplementation(async (_vault, ledger, key, runKey) => {
    if (table[ledger][key] !== runKey) return false;
    delete table[ledger][key];
    return true;
  });
  vi.mocked(ipc.jobLedgerStamp).mockImplementation(async (_vault, key, at) => {
    table.triggerRuns[key] = at;
  });
  vi.mocked(ipc.jobLedgerImport).mockImplementation(async (_vault, entries) => {
    let landed = 0;
    for (const { ledger, key, runKey } of entries) {
      const slots = table[ledger as keyof JobLedgers];
      if (key in slots) continue;
      slots[key] = runKey;
      landed += 1;
    }
    return landed;
  });
  return table;
}

/**
 * Whose events are whose.
 *
 * This describe once covered a preempt handshake: the chat killed this
 * runner's child, waited up to five seconds for `learningPath` to clear, and
 * took the single shared slot — with three tests for the ways that went wrong
 * (a late Done arriving mid-chat-turn, a Done that never arrived, a takeover
 * landing while start-up was parked on an await). M17.3 deleted the whole
 * mechanism by giving every run an id, and M17.7 deleted the flags it
 * coordinated through. What is left is the property that made all of it
 * unnecessary: a job ends on ITS terminal event and no other.
 */
describe('useJobRunner stream ownership', () => {
  beforeEach(() => {
    handlers.length = 0;
    vi.useFakeTimers();
    vi.mocked(agentIpc.runAgent).mockClear();
    resetLedgerMocks();
    useVaultStore.setState({
      vaultPath: '/vault',
      entriesVault: '/vault',
      entries: [note],
      rescan: vi.fn(async () => undefined),
    });
    useUiStore.setState({
      autoLearn: true,
      learnAttempts: {},
      skillRuns: {},
      runs: [],
      agentShell: 'off',
      agentConnectors: false,
      stdioApprovals: {},
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('pushes current state in front of an unattended run, superseding its memory', async () => {
    // M33.8 — the munder-difflin pattern: a resumed process is TOLD what is
    // true now rather than trusting the notes it wrote weeks ago. The clause
    // is asserted verbatim because it is the part that does the work.
    renderHook(() => useJobRunner());
    await startJob();

    const [, options] = vi.mocked(agentIpc.runAgent).mock.calls[0];
    expect(options.message.startsWith('CURRENT STATE (supersedes anything you remember)')).toBe(
      true,
    );
    expect(options.message).toContain('- Your last run:');
    // And the instructions still follow it — the block leads, it does not
    // replace.
    expect(options.message).toContain('playbook');
  });

  it("names a schedule's cause: its schedule and the moment it was owed (M56.7)", async () => {
    renderHook(() => useJobRunner());
    await startJob();
    const [, options] = vi.mocked(agentIpc.runAgent).mock.calls[0];
    expect(options.cause).toEqual({
      kind: 'schedule',
      detail: 'daily 09:00',
      due_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/),
    });
    // Rust frames why the run started; the message never pastes it.
    expect(options.message).not.toContain('You were woken because');
  });

  it('finish() on the owned stream releases everything', async () => {
    renderHook(() => useJobRunner());
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);
    // M17.7: the job is a RUN in the registry, carrying the note it reads and
    // the child it spawned — not a boolean plus a path anybody could set.
    const job = () => useUiStore.getState().runs.find((r) => r.owner === 'job') ?? null;
    expect(job()?.path).toBe('records/skills/digest.md');
    expect(job()?.run).toBe(JOB_RUN);

    act(() => handlers.forEach((h) => h({ run: JOB_RUN, kind: 'Done' })));
    expect(useUiStore.getState().runs).toEqual([]);
  });

  it('a chat turn no longer takes the stream, so a job runs to its own end', async () => {
    // M17.3 deleted the takeover entirely. Three tests lived here for the
    // window where the chat killed this runner's child and waited up to five
    // seconds for the single slot: a late Done arriving mid-chat-turn, a Done
    // that never arrived at all, and a takeover landing while start-up was
    // parked on an await. None of them is reachable now — the chat has its
    // own run and never touches this one.
    renderHook(() => useJobRunner());
    await startJob();
    const reading = () => useUiStore.getState().runs.find((r) => r.owner === 'job')?.path ?? null;
    expect(reading()).toBe('records/skills/digest.md');

    // A chat turn starts beside it and registers its own run.
    act(() =>
      useUiStore.getState().startRun({
        id: 'chat-1',
        owner: 'chat',
        label: 'what is at risk',
        place: null,
        path: null,
        conversationId: 'c-1',
        run: 99,
        startedAt: 0,
      }),
    );

    // The chat's own run finishes. Its Done is not this job's business.
    act(() => handlers.forEach((h) => h({ run: 99, kind: 'Done' })));
    expect(reading()).toBe('records/skills/digest.md');

    // The job ends on ITS terminal event, and releases what it claimed.
    act(() => handlers.forEach((h) => h({ run: JOB_RUN, kind: 'Done' })));
    expect(reading()).toBeNull();
  });

  it('stops listening once its job is done', async () => {
    renderHook(() => useJobRunner());
    await startJob();
    expect(handlers.length).toBeGreaterThan(0);
    act(() => handlers.forEach((h) => h({ run: JOB_RUN, kind: 'Done' })));
    expect(handlers.length).toBe(0);
  });
});

/**
 * The fire-key ledger (PR #5 review): scoped to the open vault, and consumed
 * only once the record's body is actually in hand — a failed READ surrenders
 * the key for a retry instead of eating the whole period, without hot-looping
 * on it or wedging the jobs queued behind it.
 */
describe('useJobRunner scheduled runs', () => {
  const skill = (path: string, title: string) =>
    makeEntry({
      path,
      filename: path.split('/').pop() ?? path,
      folder: 'records/skills',
      title,
      type: 'Skill',
      properties: { schedule: 'daily 09:00' },
    });
  // 10:30 on 2026-07-31 — the day's 09:00 fire is due and unrecorded.
  const FIRE_KEY = '2026-07-31 09:00';

  beforeEach(() => {
    handlers.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 31, 10, 30));
    vi.mocked(agentIpc.runAgent).mockClear();
    vi.mocked(ipc.readNote).mockClear();
    vi.mocked(ipc.readNote).mockImplementation(async () => '---\ntype: Skill\n---\nplaybook');
    resetLedgerMocks();
    useVaultStore.setState({
      vaultPath: '/vault',
      entriesVault: '/vault',
      entries: [skill('records/skills/digest.md', 'Digest')],
      rescan: vi.fn(async () => undefined),
    });
    useUiStore.setState({
      autoLearn: true,
      learnAttempts: {},
      skillRuns: {},
      runs: [],
      agentShell: 'off',
      agentConnectors: false,
      stdioApprovals: {},
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('a run records its fire key under the OPEN VAULT, not a flat path map', async () => {
    renderHook(() => useJobRunner());
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().skillRuns).toEqual({
      '/vault': { 'records/skills/digest.md': FIRE_KEY },
    });

    act(() => handlers.forEach((h) => h({ run: JOB_RUN, kind: 'Done' })));
    expect(useUiStore.getState().runs).toEqual([]);
  });

  it('a failed read leaves the fire key unconsumed and steps past to the next job', async () => {
    vi.mocked(ipc.readNote).mockImplementation(async (_vault, path) => {
      if (path.includes('a-broken')) throw new Error('io');
      return '---\ntype: Skill\n---\nplaybook';
    });
    useVaultStore.setState({
      entries: [
        skill('records/skills/a-broken.md', 'A Broken'),
        skill('records/skills/b-works.md', 'B Works'),
      ],
    });
    renderHook(() => useJobRunner());

    // First in path order is the unreadable record: no run, no key consumed.
    // (Hydration writes the vault's slice, empty — measured-at-zero, which
    // is not a consumed key.)
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
    expect(useUiStore.getState().skillRuns).toEqual({ '/vault': {} });

    // The failure steps aside rather than blocking the queue: the next
    // settle drains the OTHER skill, and the broken one is not re-read in a
    // loop — it waits for the next fire or the next app start.
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().skillRuns).toEqual({
      '/vault': { 'records/skills/b-works.md': FIRE_KEY },
    });
    const brokenReads = vi
      .mocked(ipc.readNote)
      .mock.calls.filter(([, path]) => path.includes('a-broken'));
    expect(brokenReads).toHaveLength(1);
  });

  it('a parked read resumes and consumes its fire key exactly once', async () => {
    // This asserted a chat TAKEOVER landing mid-read, and that the abandoned
    // job kept its fire key for a retry. M17.3 removed takeovers — a chat turn
    // is its own run and never reaches into this one — so what is left to pin
    // is the ordering the takeover case was built on: the key is consumed
    // after the body is in hand, and only once.
    let releaseRead: (body: string) => void = () => undefined;
    vi.mocked(ipc.readNote).mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          releaseRead = resolve;
        }),
    );
    renderHook(() => useJobRunner());
    await startJob();
    expect(useUiStore.getState().runs[0]?.path).toBe('records/skills/digest.md');
    // Parked on the read: no child, and no key spent on a run that has not
    // happened.
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
    expect(useUiStore.getState().skillRuns).toEqual({ '/vault': {} });

    await act(async () => {
      releaseRead('---\ntype: Skill\n---\nplaybook');
      await Promise.resolve();
    });

    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().skillRuns['/vault']).toBeDefined();
  });

  it('a failed read in one vault never suppresses the same path in another', async () => {
    vi.mocked(ipc.readNote).mockImplementation(async (vault) => {
      if (vault === '/vault') throw new Error('io');
      return '---\ntype: Skill\n---\nplaybook';
    });
    renderHook(() => useJobRunner());

    // /vault: the read fails; the failure is remembered for the session.
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();

    // /other holds the same relative path with the same due fire key — fire
    // keys are calendar values, so they collide across vaults by
    // construction. This vault's file was never read; the failure memory
    // must not reach across. (Its snapshot lands with its own name, as an
    // open's does — the queue derives nothing from another vault's.)
    act(() => useVaultStore.setState({ vaultPath: '/other', entriesVault: '/other' }));
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().skillRuns).toEqual({
      '/vault': {},
      '/other': { 'records/skills/digest.md': FIRE_KEY },
    });
  });
});

/**
 * Shell for unattended runs (PR #5 security review): background jobs execute
 * vault-authored content, so the Settings shell ceiling is only a ceiling
 * here. The one path to the shell on a schedule is an Agent record declaring
 * `tools: shell` inside that ceiling, and under Ask nobody can answer, so the
 * table withholds it (M57.2).
 */
describe('useJobRunner shell gating', () => {
  const agentRecord = (path: string, title: string, tools?: string | string[]) =>
    makeEntry({
      path,
      filename: path.split('/').pop() ?? path,
      folder: 'records/agents',
      title,
      type: 'Agent',
      properties:
        tools === undefined ? { schedule: 'daily 09:00' } : { schedule: 'daily 09:00', tools },
    });

  beforeEach(() => {
    handlers.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 31, 10, 30));
    vi.mocked(agentIpc.runAgent).mockClear();
    vi.mocked(ipc.readNote).mockImplementation(async () => '---\ntype: Skill\n---\nplaybook');
    resetLedgerMocks();
    useVaultStore.setState({
      vaultPath: '/vault',
      entriesVault: '/vault',
      entries: [],
      rescan: vi.fn(async () => undefined),
    });
    useUiStore.setState({
      autoLearn: true,
      learnAttempts: {},
      skillRuns: {},
      runs: [],
      agentShell: 'on', // the ceiling is OPEN in every case below
      agentConnectors: false,
      stdioApprovals: {},
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('a scheduled skill never inherits the Settings shell ceiling', async () => {
    useVaultStore.setState({
      entries: [
        makeEntry({
          path: 'records/skills/digest.md',
          filename: 'digest.md',
          folder: 'records/skills',
          title: 'Digest',
          type: 'Skill',
          properties: { schedule: 'daily 09:00' },
        }),
      ],
    });
    renderHook(() => useJobRunner());
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(agentIpc.runAgent).mock.calls[0][1]).toMatchObject({ shell: 'off' });
  });

  it('hands an agent its record body with the system prompt, never the message (M34.1.4)', async () => {
    // Standing instructions are STANDING. Folded into the user message, a
    // multi-turn agent re-reads its own charter as if the user had just
    // typed it; the mocked readNote body is 'playbook', so that string must
    // appear on exactly one side of the wire.
    useVaultStore.setState({
      entries: [agentRecord('records/agents/scout.md', 'Scout')],
    });
    renderHook(() => useJobRunner());
    await startJob();

    const [, options] = vi.mocked(agentIpc.runAgent).mock.calls[0];
    expect(options.systemPrompt).toContain(
      'Your standing instructions, from records/agents/scout.md',
    );
    expect(options.systemPrompt).toContain('playbook');
    expect(options.message).not.toContain('playbook');
  });

  it('stamps a schedule-fired run with the moment it was owed (M34.2)', async () => {
    // The clock is pinned to 10:30 and the schedule says 09:00, so this run
    // is a catch-up — the log entry must know when it was due, and lateness
    // is derived, never stored.
    useRunLogStore.getState().clear();
    useVaultStore.setState({
      entries: [agentRecord('records/agents/scout.md', 'Scout')],
    });
    renderHook(() => useJobRunner());
    await startJob();
    act(() => handlers.forEach((h) => h({ run: JOB_RUN, kind: 'Done' })));

    const [entry] = useRunLogStore.getState().entries;
    expect(entry.dueAt).toBeDefined();
    const due = new Date(entry.dueAt!);
    expect([due.getHours(), due.getMinutes()]).toEqual([9, 0]);
  });

  it('logs a run a hook outside Cerebro paused as failed, and says so (M57.1)', async () => {
    // Nobody watches a job, so a call a hook held is never answered: the run
    // stopped there, Rust booked it failed and requeued its items, and the
    // log says why rather than calling it done.
    useRunLogStore.getState().clear();
    useVaultStore.setState({
      entries: [agentRecord('records/agents/scout.md', 'Scout')],
    });
    renderHook(() => useJobRunner());
    await startJob();
    act(() =>
      handlers.forEach((h) =>
        h({ run: JOB_RUN, kind: 'ToolDeferred', tool_id: 't-1', tool_name: 'Bash' }),
      ),
    );
    act(() => handlers.forEach((h) => h({ run: JOB_RUN, kind: 'Done' })));
    const [entry] = useRunLogStore.getState().entries;
    expect(entry.status).toBe('failed');
    expect(entry.error).toBe(pausedByHook('Bash'));
    expect(entry.error).toContain('paused by a hook outside Cerebro');
  });

  it('logs a run that died before it started — could not tell is not found nothing (M34.2)', async () => {
    // An unreadable record used to end in pure silence: no run row, no log
    // entry, indistinguishable from "nothing was due". The absence of a row
    // reads as an empty state, and this surface is not allowed to say
    // "nothing happened" when it means "we could not tell".
    useRunLogStore.getState().clear();
    vi.mocked(ipc.readNote).mockImplementationOnce(async () => {
      throw new Error('EACCES');
    });
    useVaultStore.setState({
      entries: [agentRecord('records/agents/scout.md', 'Scout')],
    });
    renderHook(() => useJobRunner());
    await startJob();

    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
    const [entry] = useRunLogStore.getState().entries;
    expect(entry.status).toBe('failed');
    expect(entry.error).toContain('could not read records/agents/scout.md');
    expect(entry.error).toContain('cannot say what it found');
  });

  it('an agent gets shell only from its own tools: declaration, inside the ceiling', async () => {
    useVaultStore.setState({
      entries: [
        agentRecord('records/agents/a-armed.md', 'Armed', 'shell'),
        agentRecord('records/agents/b-plain.md', 'Plain'),
      ],
    });
    renderHook(() => useJobRunner());

    await startJob();
    act(() => handlers.forEach((h) => h({ run: JOB_RUN, kind: 'Done' })));
    await startJob();

    const calls = vi.mocked(agentIpc.runAgent).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toMatchObject({ shell: 'on' });
    expect(calls[1][1]).toMatchObject({ shell: 'off' });
  });

  it('sends a shell-declaring agent the Ask ceiling unattended, and every other job off (M57.2)', async () => {
    vi.mocked(buildSystemPrompt).mockClear();
    useUiStore.setState({ agentShell: 'ask' });
    useVaultStore.setState({
      entries: [
        agentRecord('records/agents/a-armed.md', 'Armed', 'shell'),
        agentRecord('records/agents/b-plain.md', 'Plain'),
      ],
    });
    renderHook(() => useJobRunner());

    await startJob();
    act(() => handlers.forEach((h) => h({ run: JOB_RUN, kind: 'Done' })));
    await startJob();

    const calls = vi.mocked(agentIpc.runAgent).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toMatchObject({ shell: 'ask', attended: false });
    expect(calls[1][1]).toMatchObject({ shell: 'off', attended: false });
    // Nobody can answer it, so its prompts never say it can change files.
    const grant = vi.mocked(buildSystemPrompt).mock.calls[0][1].grant;
    expect(grant?.shell).toBe(false);
  });

  // M57.7: the web reaches a scheduled run only from an Agent record that
  // declares `tools: web`, under Web access in Settings; a skill never.
  it('sends the web only to an agent that declares it, under Web access, and never to a skill', async () => {
    vi.mocked(buildSystemPrompt).mockClear();
    useUiStore.setState({ agentWebAccess: true });
    useVaultStore.setState({
      entries: [
        agentRecord('records/agents/a-web.md', 'Web', 'web'),
        agentRecord('records/agents/b-both.md', 'Both', ['shell', 'web']),
        agentRecord('records/agents/c-plain.md', 'Plain', 'shell'),
        makeEntry({
          path: 'records/skills/digest.md',
          filename: 'digest.md',
          folder: 'records/skills',
          title: 'Digest',
          type: 'Skill',
          properties: { schedule: 'daily 09:00', tools: 'web' },
        }),
      ],
    });
    renderHook(() => useJobRunner());
    for (let i = 0; i < 4; i += 1) {
      await startJob();
      act(() => handlers.forEach((h) => h({ run: JOB_RUN, kind: 'Done' })));
    }
    const calls = vi.mocked(agentIpc.runAgent).mock.calls;
    expect(calls).toHaveLength(4);
    const byPrompt = (path: string) =>
      calls.find(([, options]) => options.systemPrompt?.includes(path))?.[1];
    expect(byPrompt('records/agents/a-web.md')).toMatchObject({ web: true });
    expect(byPrompt('records/agents/b-both.md')).toMatchObject({ web: true, shell: 'on' });
    expect(byPrompt('records/agents/c-plain.md')).toMatchObject({ web: false });
    const skill = calls.find(([, options]) => options.web === false && options.shell === 'off');
    expect(skill).toBeDefined();
    // The grant follows the same answer, so only the web agents' prompts may
    // name the web tools.
    const grants = vi.mocked(buildSystemPrompt).mock.calls.map(([, options]) => options.grant.web);
    expect(grants.filter((held) => held === true)).toHaveLength(2);
    useUiStore.setState({ agentWebAccess: false });
  });

  it('gives a declaring agent no web while Web access is off (M57.7)', async () => {
    useUiStore.setState({ agentWebAccess: false });
    useVaultStore.setState({ entries: [agentRecord('records/agents/a-web.md', 'Web', 'web')] });
    renderHook(() => useJobRunner());
    await startJob();
    expect(vi.mocked(agentIpc.runAgent).mock.calls[0][1]).toMatchObject({ web: false });
  });

  it('a background run is never attended, so the legacy MCP fallback stays closed', async () => {
    // `attended` gates connector_context's absent-file branch (PR #5
    // security review): with connectors on but no connectors.json, only a
    // watched panel turn may inherit the user's global MCP config. A
    // background job executes vault-authored content unattended, and must
    // say so on every run it starts.
    useUiStore.setState({ agentConnectors: true });
    useVaultStore.setState({
      entries: [
        makeEntry({
          path: 'records/skills/digest.md',
          filename: 'digest.md',
          folder: 'records/skills',
          title: 'Digest',
          type: 'Skill',
          properties: { schedule: 'daily 09:00' },
        }),
      ],
    });
    renderHook(() => useJobRunner());
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(agentIpc.runAgent).mock.calls[0][1]).toMatchObject({
      connectors: true,
      attended: false,
    });
  });
});

/**
 * M54.7 — a job's prompts are composed for what the run holds, and nobody is
 * watching it. A scheduled skill runs under its own `allowed-tools:` too, as
 * an agent always has.
 */
describe('useJobRunner composes each job for its grant', () => {
  const scheduled = (type: 'Agent' | 'Skill', properties: Record<string, unknown>) =>
    makeEntry({
      path: `records/${type === 'Agent' ? 'agents' : 'skills'}/scout.md`,
      filename: 'scout.md',
      folder: `records/${type === 'Agent' ? 'agents' : 'skills'}`,
      title: 'Scout',
      type,
      properties: { schedule: 'daily 09:00', ...properties } as never,
    });

  beforeEach(() => {
    handlers.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 31, 10, 30));
    vi.mocked(agentIpc.runAgent).mockClear();
    vi.mocked(buildSystemPrompt).mockClear();
    vi.mocked(ipc.readNote).mockImplementation(async () => '---\ntype: Agent\n---\nplaybook');
    resetLedgerMocks();
    useVaultStore.setState({
      vaultPath: '/vault',
      entriesVault: '/vault',
      entries: [],
      rescan: vi.fn(async () => undefined),
    });
    useUiStore.setState({
      autoLearn: true,
      learnAttempts: {},
      skillRuns: {},
      runs: [],
      agentShell: 'on',
      agentConnectors: false,
      stdioApprovals: {},
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  /** Run the one due job and hand back its grant and its start. */
  async function runOne() {
    renderHook(() => useJobRunner());
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildSystemPrompt)).toHaveBeenCalledTimes(1);
    return {
      grant: vi.mocked(buildSystemPrompt).mock.calls[0][1].grant,
      options: vi.mocked(agentIpc.runAgent).mock.calls[0][1],
    };
  }

  it('composes an agent job unattended, for the tools its record narrows it to', async () => {
    useVaultStore.setState({
      entries: [scheduled('Agent', { 'allowed-tools': ['search_notes'] })],
    });
    const { grant, options } = await runOne();
    expect(grant.attended).toBe(false);
    expect([...grant.tools]).toEqual(['search_notes']);
    expect(options.allowedTools).toEqual(['search_notes']);
    // Neither closing line reaches a run that cannot act on it.
    expect(options.message).not.toContain('update_frontmatter');
    expect(options.message).not.toContain('write_concept');
    expect(mentionedTools(options.message)).toEqual([]);
  });

  it('asks an unnarrowed agent for its notes and its learning, as before', async () => {
    useVaultStore.setState({ entries: [scheduled('Agent', {})] });
    const { grant, options } = await runOne();
    expect(grant.attended).toBe(false);
    expect(grant.tools.has('update_frontmatter')).toBe(true);
    expect(options.allowedTools).toBeNull();
    expect(options.message).toContain('update_frontmatter');
    expect(options.message).toContain('write_concept');
  });

  it('withdraws the shell from a read-scoped agent’s grant, as Rust withdraws it', async () => {
    useVaultStore.setState({
      entries: [scheduled('Agent', { tools: 'shell', 'read-scope': ['sources/'] })],
    });
    const { grant, options } = await runOne();
    expect(options.shell).toBe('on');
    expect(grant.shell).toBe(false);
  });

  it('runs a scheduled skill under its own allowed-tools', async () => {
    useVaultStore.setState({
      entries: [scheduled('Skill', { 'allowed-tools': ['search_notes'] })],
    });
    const { grant, options } = await runOne();
    expect(options.allowedTools).toEqual(['search_notes']);
    expect([...grant.tools]).toEqual(['search_notes']);
    expect(grant).toMatchObject({ shell: false, attended: false });
  });

  it('leaves a scheduled skill that declares nothing unnarrowed', async () => {
    useVaultStore.setState({ entries: [scheduled('Skill', {})] });
    const { options } = await runOne();
    expect(options.allowedTools).toBeNull();
  });

  it('hands an agent job the connector tools its record denies (M54.9)', async () => {
    useVaultStore.setState({
      entries: [
        scheduled('Agent', {
          connectors: ['gmail'],
          'disallowed-tools': ['mcp__gmail__trash_thread'],
        }),
      ],
    });
    const { options } = await runOne();
    expect(options).toMatchObject({
      attended: false,
      connectorNames: ['gmail'],
      disallowedTools: ['mcp__gmail__trash_thread'],
    });
  });

  it('passes an agent run its record’s model and effort (M56.5)', async () => {
    useVaultStore.setState({
      entries: [scheduled('Agent', { model: ' sonnet ', effort: 'high' })],
    });
    const { options } = await runOne();
    expect(options).toMatchObject({ model: 'sonnet', effort: 'high' });
  });

  it('passes an agent run its record’s ask-first (M57.4)', async () => {
    useVaultStore.setState({ entries: [scheduled('Agent', { 'ask-first': true })] });
    expect((await runOne()).options).toMatchObject({ askFirst: true, attended: false });
  });

  it('reads an odd ask-first on, and none as off (M57.4)', async () => {
    useVaultStore.setState({ entries: [scheduled('Agent', { 'ask-first': 'please' })] });
    expect((await runOne()).options.askFirst).toBe(true);
  });

  it('sends ask-first false for a record that writes without asking (M57.4)', async () => {
    useVaultStore.setState({ entries: [scheduled('Agent', {})] });
    expect((await runOne()).options.askFirst).toBe(false);
  });

  it('runs a record that names neither at Claude Code’s default (M56.5)', async () => {
    useVaultStore.setState({ entries: [scheduled('Agent', {})] });
    const { options } = await runOne();
    expect(options).toMatchObject({ model: null, effort: null });
  });

  it('logs a start Rust refused in its words, not as a failed read (M56.5, Q12)', async () => {
    useRunLogStore.getState().clear();
    const refusal = 'effort "turbo" is not one Claude Code accepts. Nothing was started.';
    vi.mocked(agentIpc.runAgent).mockRejectedValueOnce(new Error(refusal));
    useVaultStore.setState({ entries: [scheduled('Agent', { effort: 'turbo' })] });
    renderHook(() => useJobRunner());
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);
    const [entry] = useRunLogStore.getState().entries;
    expect(entry.status).toBe('failed');
    expect(entry.error).toBe(`did not start: ${refusal}`);
  });

  it('gives a scheduled skill no connector to reach and nothing to deny', async () => {
    // A skill's record names no connectors, and an unattended run that names
    // none reaches none (M54.9): Rust reads the null this sends as that.
    useVaultStore.setState({
      entries: [scheduled('Skill', { 'disallowed-tools': ['mcp__gmail__trash_thread'] })],
    });
    const { options } = await runOne();
    expect(options).toMatchObject({ attended: false, connectorNames: null, disallowedTools: null });
  });
});

/**
 * The durable ledgers (M34.2.3): the queue waits for hydration, the database
 * arbitrates every fire, and the localStorage era is imported exactly once.
 */
describe('useJobRunner durable ledgers', () => {
  const skill = makeEntry({
    path: 'records/skills/digest.md',
    filename: 'digest.md',
    folder: 'records/skills',
    title: 'Digest',
    type: 'Skill',
    properties: { schedule: 'daily 09:00' },
  });
  const FIRE_KEY = '2026-07-31 09:00';

  beforeEach(() => {
    handlers.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 31, 10, 30));
    vi.mocked(agentIpc.runAgent).mockClear();
    // Implementation too, not just calls: the deferral test scripts a
    // deferred answer and it must not leak into its neighbours.
    vi.mocked(agentIpc.runAgent).mockImplementation(async () => ({
      run: JOB_RUN,
      durableId: JOB_DURABLE,
    }));
    vi.mocked(ipc.readNote).mockImplementation(async () => '---\ntype: Skill\n---\nplaybook');
    resetLedgerMocks();
    useVaultStore.setState({
      vaultPath: '/vault',
      entriesVault: '/vault',
      entries: [skill],
      rescan: vi.fn(async () => undefined),
    });
    useUiStore.setState({
      autoLearn: true,
      learnAttempts: {},
      skillRuns: {},
      triggerRuns: {},
      runs: [],
      agentShell: 'off',
      agentConnectors: false,
      stdioApprovals: {},
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('a queue whose ledgers cannot be read never fires — gated is not empty', async () => {
    // "We could not read the ledgers" and "nothing ever ran" are opposite
    // sentences; acting on the second when the first is true would re-fire
    // every schedule ever answered.
    vi.mocked(ipc.jobLedgerRead).mockImplementation(async () => {
      throw new Error('no runtime db');
    });
    renderHook(() => useJobRunner());
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
  });

  it('a fire the durable table already answered is not due after hydration', async () => {
    // The DB remembers a fire localStorage never saw (a webview wipe, a
    // second machine): hydration must land it in the derivation, not just in
    // a cache beside it.
    vi.mocked(ipc.jobLedgerRead).mockImplementation(async () => ({
      attempts: {},
      skillRuns: { 'records/skills/digest.md': FIRE_KEY },
      triggerRuns: {},
    }));
    renderHook(() => useJobRunner());
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
    // And the hydrated key is mirrored where the derivation reads it.
    expect(useUiStore.getState().skillRuns['/vault']).toEqual({
      'records/skills/digest.md': FIRE_KEY,
    });
  });

  it('a lost claim spawns nothing — the other window owns the run', async () => {
    vi.mocked(ipc.jobLedgerClaim).mockImplementation(async () => false);
    renderHook(() => useJobRunner());
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
    // The verdict still updates the local view, so the derivation stops
    // offering the job, and the runner is free for the next one.
    expect(useUiStore.getState().skillRuns['/vault']).toEqual({
      'records/skills/digest.md': FIRE_KEY,
    });
    expect(useUiStore.getState().runs).toEqual([]);
  });

  it('imports the localStorage era exactly when the table is empty', async () => {
    useUiStore.setState({
      skillRuns: { '/vault': { 'records/skills/digest.md': FIRE_KEY } },
    });
    renderHook(() => useJobRunner());
    await startJob();
    expect(vi.mocked(ipc.jobLedgerImport)).toHaveBeenCalledWith('/vault', [
      { ledger: 'skillRuns', key: 'records/skills/digest.md', runKey: FIRE_KEY },
    ]);
  });

  it('a deferred run surrenders its fire key and logs one deferred row (M34.2.4)', async () => {
    // The ambient gate said "not now". The fire was never answered, so the
    // claim is surrendered, durable and local (M53.27) — a consumed key would
    // make the deferral eat the whole period — and the log row is DEFERRED,
    // not failed: nothing went wrong.
    useRunLogStore.getState().clear();
    vi.mocked(agentIpc.runAgent).mockImplementation(async () => ({
      deferred: ['daily_token_ceiling'],
    }));
    renderHook(() => useJobRunner());
    await startJob();

    expect(vi.mocked(ipc.jobLedgerUnclaim)).toHaveBeenCalledWith(
      '/vault',
      'skillRuns',
      'records/skills/digest.md',
      FIRE_KEY,
    );
    expect(useUiStore.getState().skillRuns['/vault']).toEqual({});
    const [entry] = useRunLogStore.getState().entries;
    expect(entry.status).toBe('deferred');
    expect(entry.error).toContain('daily_token_ceiling');
    // The runner is free again, and the fire is held for the rest of the
    // session rather than re-asked at every settle (an hour of settles is
    // asserted on the recheck lane below).
    expect(useUiStore.getState().runs).toEqual([]);
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);
  });

  it('a deferred fire is not imported back as answered, so the next launch asks again (M53.27)', async () => {
    // When the table holds nothing else, a launch first imports the
    // localStorage era. The deferred fire's local record, left behind, went
    // in as answered, and the deferral ate the fire it refused after all.
    const table = durableTable();
    vi.mocked(agentIpc.runAgent).mockImplementationOnce(async () => ({
      deferred: ['daily_token_ceiling'],
    }));
    renderHook(() => useJobRunner());
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);
    expect(table.skillRuns).toEqual({});
    expect(useUiStore.getState().skillRuns['/vault']).toEqual({});

    // A relaunch: the store outlives the unmount, as its localStorage mirror
    // outlives the app.
    cleanup();
    renderHook(() => useJobRunner());
    await startJob();
    expect(vi.mocked(ipc.jobLedgerImport)).not.toHaveBeenCalled();
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(2);
    expect(table.skillRuns).toEqual({ 'records/skills/digest.md': FIRE_KEY });
  });

  it('every unattended job names its kind as its budget lane (M34.2.4)', async () => {
    renderHook(() => useJobRunner());
    await startJob();
    expect(vi.mocked(agentIpc.runAgent).mock.calls[0][1]).toMatchObject({
      attended: false,
      lane: 'scheduled',
    });
  });

  it('does not import into a table that already remembers anything', async () => {
    vi.mocked(ipc.jobLedgerRead).mockImplementation(async () => ({
      attempts: {},
      skillRuns: { 'records/skills/other.md': '2026-07-30 09:00' },
      triggerRuns: {},
    }));
    useUiStore.setState({
      skillRuns: { '/vault': { 'records/skills/digest.md': FIRE_KEY } },
    });
    renderHook(() => useJobRunner());
    await startJob();
    // The database has been the arbiter since it existed — a non-empty table
    // means the era is over, and re-importing would resurrect stale answers.
    expect(vi.mocked(ipc.jobLedgerImport)).not.toHaveBeenCalled();
  });
});

/**
 * M49.2: the stale and schema recheck lanes exist to rewrite `knowledge/`,
 * and every one of those writes refuses while the vault is not recording
 * (M49.1). They wait instead of spending a paid run on a certain refusal.
 * The budget gate can make a recheck wait too, and the last test here is
 * what a deferral leaves behind (M53.27).
 */
describe('useJobRunner while the vault is not recording', () => {
  const staleConcept = makeEntry({
    path: 'knowledge/systems/old.md',
    title: 'Old',
    properties: {
      generated: { by: 'claude-code', at: '2026-06-01T00:00:00Z' },
      stale_after: '2026-07-01',
    },
  });

  beforeEach(() => {
    handlers.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 31, 10, 30));
    vi.mocked(agentIpc.runAgent).mockClear();
    // Implementation too: the deferral test scripts a deferred answer.
    vi.mocked(agentIpc.runAgent).mockImplementation(async () => ({
      run: JOB_RUN,
      durableId: JOB_DURABLE,
    }));
    resetLedgerMocks();
    useVaultStore.setState({
      vaultPath: '/vault',
      entriesVault: '/vault',
      entries: [staleConcept],
      rescan: vi.fn(async () => undefined),
    });
    useUiStore.setState({
      autoLearn: true,
      learnAttempts: {},
      skillRuns: {},
      triggerRuns: {},
      runs: [],
      agentShell: 'off',
      agentConnectors: false,
      stdioApprovals: {},
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('runs the recheck while the writer is held', async () => {
    renderHook(() => useJobRunner());
    await startJob();
    expect(agentIpc.runAgent).toHaveBeenCalledTimes(1);
    // A recheck lane is Cerebro's upkeep, with the lane's reason (M56.7).
    expect(vi.mocked(agentIpc.runAgent).mock.calls[0][1].cause).toEqual({
      kind: 'maintenance',
      subject: 'knowledge/systems/old.md',
      detail: 'a concept passed its recheck date',
    });
  });

  it.each(['lost-lock', 'refused', 'fail-stopped', 'other-vault', 'inactive'] as const)(
    'holds it while the writer is %s',
    async (state) => {
      useLedgerStore.setState({
        vault: '/vault',
        read: { kind: 'read', status: { ...recordingStatus, writer: { state, detail: 'why' } } },
      });
      renderHook(() => useJobRunner());
      await startJob();
      expect(agentIpc.runAgent).not.toHaveBeenCalled();
    },
  );

  it('holds it when the status could not be read, or was read for another vault', async () => {
    useLedgerStore.setState({ vault: '/vault', read: { kind: 'unavailable', error: 'ipc down' } });
    const { unmount } = renderHook(() => useJobRunner());
    await startJob();
    unmount();
    useLedgerStore.setState({ vault: '/other', read: { kind: 'read', status: recordingStatus } });
    renderHook(() => useJobRunner());
    await startJob();
    expect(agentIpc.runAgent).not.toHaveBeenCalled();
  });

  it('a deferred recheck leaves no record, is asked once a session, and runs after a relaunch (M53.27)', async () => {
    // The gate defers the recheck, so the claim gives back its records,
    // durable and local. The local one used to stay, and the next launch
    // merged it back over the table: the recheck stayed suppressed until its
    // date moved, and moving that date is the recheck's own job.
    const table = durableTable();
    vi.mocked(agentIpc.runAgent).mockImplementation(async () => ({
      deferred: ['daily_token_ceiling'],
    }));
    renderHook(() => useJobRunner());
    await startJob();
    expect(vi.mocked(ipc.jobLedgerUnclaim)).toHaveBeenCalledWith(
      '/vault',
      'attempts',
      'knowledge/systems/old.md',
      'stale:2026-07-01',
    );
    expect(table.attempts).toEqual({});
    expect(useUiStore.getState().learnAttempts).toEqual({});

    // Held for the rest of the session: the gate would defer every ask, and
    // an hour of settles asks it once.
    for (let settle = 0; settle < 20; settle += 1) await startJob();
    await advance(60 * MINUTE, 5 * MINUTE);
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);

    // The next launch asks again, and this time the gate lets it run.
    vi.mocked(agentIpc.runAgent).mockImplementation(async () => ({
      run: JOB_RUN,
      durableId: JOB_DURABLE,
    }));
    cleanup();
    renderHook(() => useJobRunner());
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(2);
    expect(table.attempts).toEqual({ 'knowledge/systems/old.md': 'stale:2026-07-01' });
  });

  it('a recheck whose start-up spans a switch surrenders its attempt claim (M53.10)', async () => {
    // The attempt is claimed first, then the start-up waits on the review
    // queue, and the window moves to another vault meanwhile. The run never
    // happens, so the claim goes back, durable and local: kept, it would hold
    // the recheck off until its date moved, and moving that date is the
    // recheck's own job.
    const table = durableTable();
    let answer: (cards: Awaited<ReturnType<typeof ipc.reviewQueue>>) => void = () => undefined;
    vi.mocked(ipc.reviewQueue).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    renderHook(() => useJobRunner());
    await startJob();
    expect(table.attempts).toEqual({ 'knowledge/systems/old.md': 'stale:2026-07-01' });
    expect(useUiStore.getState().learnAttempts).toEqual({
      'knowledge/systems/old.md': 'stale:2026-07-01',
    });

    act(() => useVaultStore.setState({ vaultPath: '/other' }));
    await act(async () => {
      answer([]);
      await Promise.resolve();
    });
    expect(useUiStore.getState().runs).toEqual([]);
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
    expect(vi.mocked(ipc.jobLedgerUnclaim)).toHaveBeenCalledWith(
      '/vault',
      'attempts',
      'knowledge/systems/old.md',
      'stale:2026-07-01',
    );
    expect(table.attempts).toEqual({});
    expect(useUiStore.getState().learnAttempts).toEqual({});
  });
});

/**
 * Woken runs and schedules in their own slots (AUTOMATION-2, M63.1), driven
 * through the real runner and the real mock wake store: the scan's offers,
 * the admission, the claim and the cooldown stamp. The watcher has
 * `schedule: daily 06:00` beside its `when:`. Either one keeps the minute
 * tick, and so the clock the cooldown is measured on, running (M53.26); the
 * next describe's watcher has the `when:` alone.
 */
describe('useJobRunner woken runs beside a schedule (AUTOMATION-2, M63.1)', () => {
  const IDENTITY = 'records/agents/watcher.md';
  const agentWith = (properties: Record<string, unknown>) =>
    makeEntry({
      path: IDENTITY,
      filename: 'watcher.md',
      folder: 'records/agents',
      title: 'Watcher',
      type: 'Agent',
      properties,
    });
  const watcher = agentWith({
    schedule: 'daily 06:00',
    when: [{ event: 'changed', in: 'inbox' }],
  });
  // Each version has new bytes, so its hash moves with its stamp (M55.2).
  const noteAt = (modifiedAt: string, path = 'inbox/a.md') =>
    makeEntry({
      path,
      filename: path.split('/').pop() ?? path,
      folder: 'inbox',
      title: path,
      modifiedAt,
      hash: `h:${path}:${modifiedAt}`,
    });

  let entries: Entry[] = [];
  /** A scan that finds these notes at new versions — new events. */
  function scan(next: Entry[]): void {
    entries = next;
    act(() => useVaultStore.setState({ entries }));
  }
  /** A scan, its admission and read, then the settle that starts a job. */
  async function wakeUp(next: Entry[]): Promise<void> {
    scan(next);
    await startJob();
    await startJob();
  }

  beforeEach(() => {
    handlers.length = 0;
    wokenRuns.length = 0;
    vi.useFakeTimers();
    // 10:30 — today's 06:00 is long past, and answered (hydrated below).
    vi.setSystemTime(new Date(2026, 6, 31, 10, 30));
    vi.mocked(agentIpc.runAgent).mockClear();
    wokenRunAgent();
    vi.mocked(ipc.readNote).mockClear();
    vi.mocked(ipc.readNote).mockImplementation(async () => '---\ntype: Agent\n---\nwatch');
    resetLedgerMocks();
    vi.mocked(ipc.jobLedgerRead).mockImplementation(async () => ({
      attempts: {},
      skillRuns: { [IDENTITY]: '2026-07-31 06:00' },
      triggerRuns: {},
    }));
    entries = [watcher, noteAt('2026-07-31T08:00:00Z')];
    useVaultStore.setState({
      vaultPath: '/vault',
      entriesVault: '/vault',
      entries,
      rescan: vi.fn(async () => undefined),
    });
    useUiStore.setState({
      autoLearn: true,
      learnAttempts: {},
      skillRuns: {},
      triggerRuns: {},
      runs: [],
      agentShell: 'off',
      agentConnectors: false,
      stdioApprovals: {},
    });
    useRunLogStore.getState().clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('a change wakes the agent once: one offer, one wake, one run that claims it', async () => {
    renderHook(() => useJobRunner());
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();

    await wakeUp([watcher, noteAt('2026-07-31T10:30:00Z')]);
    expect(vi.mocked(ipc.admitWakes)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);
    const [, options] = vi.mocked(agentIpc.runAgent).mock.calls[0];
    const [pending] = await mockIpc.wakesPending('/vault');
    expect(pending).toBeUndefined();
    // The run claims its wake, on lane agent, and names no cause of its own:
    // the wake's, stored at admission, is what Rust records and quotes.
    expect(options.wake).toEqual({ claim: expect.any(String), coalesce: [] });
    expect(options.lane).toBe('agent');
    expect(options.cause).toBeNull();
    expect(options.message).not.toContain('inbox/a.md');
    // No job ledger claim: a woken run's record is its wake.
    expect(vi.mocked(ipc.jobLedgerClaim)).not.toHaveBeenCalled();
    expect(useUiStore.getState().skillRuns['/vault']).toEqual({ [IDENTITY]: '2026-07-31 06:00' });
    jobDone();
    expect(wakeRows()).toEqual(['inbox/a.md finished succeeded']);
    const words = triggerWords(parseTriggers(watcher.properties.when)[0]);
    expect(useRunLogStore.getState().entries[0]?.trigger).toBe(`event: ${words}`);

    // A quiet vault: nothing is pending, the clock ticks past the cooldown
    // and on into the evening, and neither the schedule nor the wake re-runs.
    await advance(20 * MINUTE);
    await advance(8 * 60 * MINUTE, 30 * MINUTE);
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ipc.admitWakes)).toHaveBeenCalledTimes(1);
  });

  it('a failed admission keeps its offers and is retried on the next scan', async () => {
    renderHook(() => useJobRunner());
    await startJob();
    vi.mocked(ipc.admitWakes).mockImplementationOnce(async () => {
      throw new Error('no runtime database');
    });
    await wakeUp([watcher, noteAt('2026-07-31T10:30:00Z')]);
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
    // The next scan offers its own change and the one that failed.
    await wakeUp([
      watcher,
      noteAt('2026-07-31T10:30:00Z'),
      noteAt('2026-07-31T10:31:00Z', 'inbox/b.md'),
    ]);
    const batch = vi.mocked(ipc.admitWakes).mock.calls[1][1];
    expect(batch.map((o) => o.cause.subject)).toEqual(['inbox/a.md']);
    // b.md was created, which this trigger does not watch: only a.md wakes.
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);
  });

  it('stamps the cooldown where the derivation reads it; changes in the window wait, then run together', async () => {
    renderHook(() => useJobRunner());
    await startJob();
    await wakeUp([watcher, noteAt('2026-07-31T10:30:00Z')]);
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ipc.jobLedgerStamp)).toHaveBeenCalledWith(
      '/vault',
      IDENTITY,
      expect.any(String),
    );
    expect(Object.keys(useUiStore.getState().triggerRuns['/vault'] ?? {})).toEqual([IDENTITY]);
    jobDone();

    // Two more changes inside the window: admitted, waiting, never dropped.
    await advance(5 * MINUTE);
    await wakeUp([watcher, noteAt('2026-07-31T10:35:00Z')]);
    await wakeUp([watcher, noteAt('2026-07-31T10:36:00Z')]);
    await advance(7 * MINUTE);
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);
    expect((await mockIpc.wakesPending('/vault')).length).toBe(2);

    // Past the window one run takes both — a cooldown, not a ban.
    await advance(4 * MINUTE);
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(2);
    const [, options] = vi.mocked(agentIpc.runAgent).mock.calls[1];
    expect(options.wake?.coalesce).toHaveLength(1);
    jobDone();
    expect(wakeRows()).toEqual([
      'inbox/a.md finished succeeded',
      'inbox/a.md finished succeeded',
      'inbox/a.md finished coalesced',
    ]);
    expect(useRunLogStore.getState().entries[0]?.trigger).toMatch(/\(\+1 more\)$/);
  });

  it('a budget deferral logs one row, holds nothing, and runs once its time has come', async () => {
    wokenRunAgent({ deferred: ['daily_runs'] });
    renderHook(() => useJobRunner());
    await startJob();
    await wakeUp([watcher, noteAt('2026-07-31T10:30:00Z')]);
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);
    expect(useRunLogStore.getState().entries.map((row) => [row.trigger, row.status])).toEqual([
      ['event', 'deferred'],
    ]);
    // Still pending in Rust, with its own time to try again: not given back
    // to a job ledger, and no cooldown started.
    const [waiting] = await mockIpc.wakesPending('/vault');
    expect(waiting.deferred).toBe('daily_runs');
    expect(vi.mocked(ipc.jobLedgerUnclaim)).not.toHaveBeenCalled();
    expect(vi.mocked(ipc.jobLedgerStamp)).not.toHaveBeenCalled();

    // Asked again once it is due, ten minutes on, and not before; deferred
    // again, it writes no second row.
    await advance(8 * MINUTE);
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);
    await advance(3 * MINUTE);
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(2);
    expect(useRunLogStore.getState().entries).toHaveLength(1);

    // The gate lifts: the next time it is due, it runs.
    wokenRunAgent();
    await advance(11 * MINUTE);
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(3);
    jobDone();
    expect(wakeRows()).toEqual(['inbox/a.md finished succeeded']);
  });

  it.each([
    ['pausing the record', () => [agentWith({ ...watcher.properties, paused: true })], 'paused'],
    [
      'editing its trigger',
      () => [agentWith({ ...watcher.properties, when: [{ event: 'created' }] })],
      'trigger_changed',
    ],
    ['deleting the agent', () => [], 'agent_gone'],
    ['deleting the page', () => [watcher], 'page_gone'],
  ])('%s cancels its pending wake, naming why', async (_, after, why) => {
    // Inside the cooldown, so the wake waits pending rather than running.
    vi.mocked(ipc.jobLedgerRead).mockImplementation(async () => ({
      attempts: {},
      skillRuns: { [IDENTITY]: '2026-07-31 06:00' },
      triggerRuns: { [IDENTITY]: new Date(2026, 6, 31, 10, 29).toISOString() },
    }));
    renderHook(() => useJobRunner());
    await startJob();
    const page = noteAt('2026-07-31T10:30:00Z');
    await wakeUp([watcher, page]);
    expect(wakeRows()).toEqual(['inbox/a.md pending']);
    const next = after();
    await wakeUp(why === 'page_gone' ? next : [...next, page]);
    expect(wakeRows()).toEqual([`inbox/a.md finished cancelled superseded ${why}`]);
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
  });

  it('a landed wakes read bumps the revision the lobby list reads again on (M63.1b)', async () => {
    useUiStore.setState({ wakesRevision: 0 });
    renderHook(() => useJobRunner());
    await startJob();
    const first = useUiStore.getState().wakesRevision;
    expect(first).toBeGreaterThan(0);
    await wakeUp([watcher, noteAt('2026-07-31T10:30:00Z')]);
    const afterWake = useUiStore.getState().wakesRevision;
    expect(afterWake).toBeGreaterThan(first);
    // A failed read lands too: the list reads for itself, and says so.
    vi.mocked(ipc.wakesPending).mockImplementation(async () => {
      throw new Error('runtime db unreadable');
    });
    await advance(MINUTE);
    expect(useUiStore.getState().wakesRevision).toBeGreaterThan(afterWake);
  });

  it('a failed wakes read derives no woken run and cancels nothing', async () => {
    renderHook(() => useJobRunner());
    await startJob();
    vi.mocked(ipc.wakesPending).mockImplementation(async () => {
      throw new Error('runtime db unreadable');
    });
    await wakeUp([watcher, noteAt('2026-07-31T10:30:00Z')]);
    // Admitted, but unread: no run, and deleting the page cancels nothing.
    expect(wakeRows()).toEqual(['inbox/a.md pending']);
    await wakeUp([watcher]);
    await advance(20 * MINUTE);
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
    expect(vi.mocked(ipc.cancelWakes)).not.toHaveBeenCalled();
    expect(wakeRows()).toEqual(['inbox/a.md pending']);
  });

  it('a scheduled run starts no cooldown: its own write wakes one run, and that run starts it', async () => {
    // 06:00:30, today's fire unanswered. The run writes into the folder its
    // agent watches, and that write is a change like any other. Only a woken
    // run stamps the clock (TRIGGER_COOLDOWN_MS), so the write wakes the
    // agent once, after the run ends.
    vi.setSystemTime(new Date(2026, 6, 31, 6, 0, 30));
    vi.mocked(ipc.jobLedgerRead).mockImplementation(async () => ({
      attempts: {},
      skillRuns: {},
      triggerRuns: {},
    }));
    renderHook(() => useJobRunner());
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ipc.jobLedgerClaim)).toHaveBeenLastCalledWith(
      '/vault',
      'skillRuns',
      IDENTITY,
      '2026-07-31 06:00',
    );
    expect(vi.mocked(ipc.jobLedgerStamp)).not.toHaveBeenCalled();
    scan([watcher, noteAt('2026-07-31T06:00:40Z')]);
    jobDone();

    await startJob();
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(agentIpc.runAgent).mock.calls[1][1].wake).toBeDefined();
    // The woken run stamps, under the key the cooldown check reads.
    expect(vi.mocked(ipc.jobLedgerStamp).mock.calls).toEqual([
      ['/vault', IDENTITY, expect.any(String)],
    ]);
    jobDone();

    // Then neither lane re-fires the other, through the window and on into
    // the afternoon.
    await advance(20 * MINUTE);
    await advance(8 * 60 * MINUTE, 30 * MINUTE);
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(2);
  });

  it('a woken run whose record cannot be read is read once, not in a loop', async () => {
    vi.mocked(ipc.readNote).mockImplementation(async () => {
      throw new Error('EIO');
    });
    renderHook(() => useJobRunner());
    await startJob();
    await wakeUp([watcher, noteAt('2026-07-31T10:30:00Z')]);
    for (let settle = 0; settle < 10; settle += 1) await startJob();
    expect(vi.mocked(ipc.readNote)).toHaveBeenCalledTimes(1);
    expect(useRunLogStore.getState().entries.map((row) => [row.trigger, row.status])).toEqual([
      ['event', 'failed'],
    ]);
    // Not a run: the wake still waits, for the next launch.
    expect(wakeRows()).toEqual(['inbox/a.md pending']);
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
  });

  it('a wake its claim found gone writes no row and runs nothing', async () => {
    renderHook(() => useJobRunner());
    await startJob();
    // Cancelled behind the runner's back, as a pause on the fleet does.
    vi.mocked(agentIpc.runAgent).mockImplementation(async () => ({ settled: 'gone' }));
    await wakeUp([watcher, noteAt('2026-07-31T10:30:00Z')]);
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);
    expect(useRunLogStore.getState().entries).toEqual([]);
    expect(vi.mocked(ipc.jobLedgerStamp)).not.toHaveBeenCalled();
  });
});

/**
 * An agent with a `when:` and no `schedule:` (M53.26). `now` moves only on
 * the minute tick, and the tick used to start only for a parseable
 * `schedule:`. So a trigger-only agent's first woken run stamped its
 * cooldown after a `now` frozen at mount, the window never closed, and the
 * agent ran once a session instead of up to four times an hour.
 */
describe('useJobRunner in a trigger-only vault (AUTOMATION-2)', () => {
  const IDENTITY = 'records/agents/watcher.md';
  const agentWith = (properties: Record<string, unknown>) =>
    makeEntry({
      path: IDENTITY,
      filename: 'watcher.md',
      folder: 'records/agents',
      title: 'Watcher',
      type: 'Agent',
      properties,
    });
  const watcher = agentWith({ when: [{ event: 'changed', in: 'inbox' }] });
  // Each version has new bytes, so its hash moves with its stamp (M55.2).
  const noteAt = (modifiedAt: string) =>
    makeEntry({
      path: 'inbox/a.md',
      filename: 'a.md',
      folder: 'inbox',
      title: 'A',
      modifiedAt,
      hash: `h:${modifiedAt}`,
    });

  /** A scan that finds inbox/a.md at a new version — a new change. */
  async function edit(modifiedAt: string): Promise<void> {
    act(() => useVaultStore.setState({ entries: [watcher, noteAt(modifiedAt)] }));
    await startJob();
  }

  beforeEach(() => {
    handlers.length = 0;
    wokenRuns.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 31, 10, 30));
    vi.mocked(agentIpc.runAgent).mockClear();
    wokenRunAgent();
    vi.mocked(ipc.readNote).mockClear();
    vi.mocked(ipc.readNote).mockImplementation(async () => '---\ntype: Agent\n---\nwatch');
    // Empty ledgers: nothing ever ran, and no cooldown is open at launch.
    resetLedgerMocks();
    useVaultStore.setState({
      vaultPath: '/vault',
      entriesVault: '/vault',
      entries: [watcher, noteAt('2026-07-31T08:00:00Z')],
      rescan: vi.fn(async () => undefined),
    });
    useUiStore.setState({
      autoLearn: true,
      learnAttempts: {},
      skillRuns: {},
      triggerRuns: {},
      runs: [],
      agentShell: 'off',
      agentConnectors: false,
      stdioApprovals: {},
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('the cooldown runs out, so a new change waits out the window and then runs', async () => {
    renderHook(() => useJobRunner());
    await startJob();
    await edit('2026-07-31T10:30:00Z');
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);
    jobDone();

    // The run stamped near 10:30. Five minutes on, a new version of the note
    // waits to the edge of the window…
    await advance(5 * MINUTE);
    await edit('2026-07-31T10:35:00Z');
    await advance(8 * MINUTE);
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);

    // …and runs past it. With no tick, `now` stayed at 10:30:00, before the
    // stamp, and held it for the rest of the session.
    await advance(3 * MINUTE);
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(agentIpc.runAgent).mock.calls[1][1].wake).toBeDefined();
  });

  it('a when: alone keeps the minute tick', async () => {
    renderHook(() => useJobRunner());
    await startJob();
    // Nothing is due, so no settle timer is pending: the one timer is the tick.
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each([
    ['an agent with neither schedule: nor when:', agentWith({})],
    // A typo for `changed`: it parses to no trigger, so the queue never fires
    // it, and nothing waits on the clock.
    ['an agent whose when: names no event', agentWith({ when: 'edited' })],
  ])('%s keeps no interval', async (_, agent) => {
    useVaultStore.setState({ entries: [agent, noteAt('2026-07-31T08:00:00Z')] });
    renderHook(() => useJobRunner());
    await startJob();
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * The trigger diff across a vault switch (AUTOMATION-2b). Its baseline was
 * whatever the runner saw last, so the first scan of a newly opened vault
 * was diffed against the vault it replaced: a scratch run fired `created` on
 * a 2025 inbox note.
 */
describe('useJobRunner across a vault switch (AUTOMATION-2b)', () => {
  // Every vault's watcher wakes on any create or change anywhere.
  const watcherIn = (name: string) =>
    makeEntry({
      path: `records/agents/${name}.md`,
      filename: `${name}.md`,
      folder: 'records/agents',
      title: name,
      type: 'Agent',
      properties: { when: ['created', 'changed'] },
    });
  const note = (path: string, modifiedAt: string, createdAt = '2026-07-01T00:00:00Z') =>
    makeEntry({
      path,
      filename: path.split('/').pop() ?? path,
      folder: 'inbox',
      title: path,
      createdAt,
      modifiedAt,
      hash: `h:${modifiedAt}`,
    });
  const aWatcher = watcherIn('a-watcher');
  const vaultA = [aWatcher, note('inbox/a1.md', '2026-07-01T09:00:00Z')];
  // Diffed against A, all of this is an event: a 2025 capture A never held
  // (created) and A's own path at another version (changed).
  const vaultB = [
    watcherIn('b-watcher'),
    note('inbox/2025-03-02-call.md', '2025-03-02T10:00:00Z', '2025-03-02T10:00:00Z'),
    note('inbox/a1.md', '2026-06-15T09:00:00Z'),
  ];

  /** An open as the store performs one: `vaultPath` moves at once, and the
   * new vault's entries land, under its name, only after the scan. */
  async function open(vault: string, entries: Entry[]): Promise<void> {
    act(() => useVaultStore.setState({ vaultPath: vault }));
    await startJob();
    act(() => useVaultStore.setState({ entries, entriesVault: vault }));
    await startJob();
  }

  beforeEach(() => {
    handlers.length = 0;
    wokenRuns.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 31, 10, 30));
    vi.mocked(agentIpc.runAgent).mockClear();
    wokenRunAgent();
    vi.mocked(ipc.readNote).mockClear();
    vi.mocked(ipc.readNote).mockImplementation(async () => '---\ntype: Agent\n---\nwatch');
    resetLedgerMocks();
    useVaultStore.setState({
      vaultPath: '/a',
      entriesVault: '/a',
      entries: vaultA,
      rescan: vi.fn(async () => undefined),
    });
    useUiStore.setState({
      autoLearn: true,
      learnAttempts: {},
      skillRuns: {},
      triggerRuns: {},
      runs: [],
      agentShell: 'off',
      agentConnectors: false,
      stdioApprovals: {},
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("offers nothing for the new vault's notes, nor for the old one's on the way back", async () => {
    renderHook(() => useJobRunner());
    await startJob();

    await open('/b', vaultB);
    expect(vi.mocked(ipc.admitWakes)).not.toHaveBeenCalled();
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();

    // A changed while B was open — a1 edited, a note added. Nobody saw it
    // happen, just as nobody sees what happens while the app is closed.
    const awayA = [
      aWatcher,
      note('inbox/a1.md', '2026-07-20T09:00:00Z'),
      note('inbox/a2.md', '2026-07-20T10:00:00Z'),
    ];
    await open('/a', awayA);
    expect(vi.mocked(ipc.admitWakes)).not.toHaveBeenCalled();
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();

    // …and from here on A is observed again: a real edit wakes its watcher,
    // admitted in A.
    act(() =>
      useVaultStore.setState({
        entries: [aWatcher, note('inbox/a1.md', '2026-07-31T10:00:00Z'), awayA[2]],
      }),
    );
    await startJob();
    await startJob();
    expect(vi.mocked(ipc.admitWakes)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ipc.admitWakes).mock.calls[0][0]).toBe('/a');
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(agentIpc.runAgent).mock.calls[0][0]).toBe('/a');
  });

  it('a batch left unadmitted when the vault was left is dropped, never offered in another', async () => {
    renderHook(() => useJobRunner());
    await startJob();
    vi.mocked(ipc.admitWakes).mockImplementation(async () => {
      throw new Error('busy');
    });
    act(() =>
      useVaultStore.setState({ entries: [aWatcher, note('inbox/a1.md', '2026-07-31T10:30:00Z')] }),
    );
    await startJob();
    expect(vi.mocked(ipc.admitWakes)).toHaveBeenCalledTimes(1);

    vi.mocked(ipc.admitWakes).mockImplementation((vault, wakes) =>
      mockIpc.admitWakes(vault, wakes),
    );
    await open('/b', vaultB);
    await advance(5 * MINUTE);
    // B never hears A's change, and A's batch went with the switch.
    expect(vi.mocked(ipc.admitWakes).mock.calls.slice(1)).toEqual([]);
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
  });

  it("derives nothing from the last vault's snapshot while an open is in flight", async () => {
    // A's daily digest is answered in A's ledger, and unanswered in B's —
    // fire keys are calendar values. Between `vaultPath` moving and B's
    // entries landing (up to a minute, M49), deriving from A's entries ran
    // A's skill against B: read under B's path, claimed in B's ledger.
    const digest = makeEntry({
      path: 'records/skills/digest.md',
      filename: 'digest.md',
      folder: 'records/skills',
      title: 'Digest',
      type: 'Skill',
      properties: { schedule: 'daily 09:00' },
    });
    const answeredInA: Record<string, string> = { [digest.path]: '2026-07-31 09:00' };
    vi.mocked(ipc.jobLedgerRead).mockImplementation(async (vault) => ({
      attempts: {},
      skillRuns: vault === '/a' ? answeredInA : {},
      triggerRuns: {},
    }));
    useVaultStore.setState({ entries: [digest] });
    renderHook(() => useJobRunner());
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();

    // The open is in flight: B's ledgers hydrate, B's entries have not landed.
    act(() => useVaultStore.setState({ vaultPath: '/b' }));
    await startJob();
    await advance(MINUTE);
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
    expect(vi.mocked(ipc.readNote)).not.toHaveBeenCalled();
  });

  /** A daily digest, due at 09:00 — answered in neither vault's ledger. */
  const digest = makeEntry({
    path: 'records/skills/digest.md',
    filename: 'digest.md',
    folder: 'records/skills',
    title: 'Digest',
    type: 'Skill',
    properties: { schedule: 'daily 09:00' },
  });
  const DIGEST_FIRE = '2026-07-31 09:00';

  it('a job in a vault switched to runs in that vault', async () => {
    // Each run's bearer carries the vault it was started in (mcp.rs
    // `RunGrant::vault`). The job runner used to point the one loopback
    // server at its vault first, through a shared pointer every tool call
    // read; now it hands `runAgent` the vault, and that is all.
    const wire: string[] = [];
    vi.mocked(agentIpc.runAgent).mockImplementation(async (vault) => {
      wire.push(`run ${vault}`);
      return { run: JOB_RUN, durableId: JOB_DURABLE };
    });
    useVaultStore.setState({ entries: [digest] });
    renderHook(() => useJobRunner());
    await startJob();
    act(() => handlers.forEach((h) => h({ run: JOB_RUN, kind: 'Done' })));
    // Due in B as well: fire keys are calendar values, and B's ledger is empty.
    await open('/b', [digest]);
    expect(wire).toEqual(['run /a', 'run /b']);
  });

  it('a job whose start-up spans a vault switch claims nothing and spawns nothing in the old vault', async () => {
    // Parked on its record's read when the window moves to B (M53.10). On
    // resume it must neither consume A's fire key nor spawn a run in A, a
    // vault nobody is looking at any more.
    let releaseRead: (body: string) => void = () => undefined;
    vi.mocked(ipc.readNote).mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          releaseRead = resolve;
        }),
    );
    useVaultStore.setState({ entries: [digest] });
    renderHook(() => useJobRunner());
    await startJob();
    expect(useUiStore.getState().runs[0]?.path).toBe(digest.path);

    act(() => useVaultStore.setState({ vaultPath: '/b' }));
    await act(async () => {
      releaseRead('---\ntype: Skill\n---\nplaybook');
      await Promise.resolve();
    });
    // The start-up resumed and ended: its registry entry is gone.
    expect(useUiStore.getState().runs).toEqual([]);
    expect(vi.mocked(ipc.jobLedgerClaim)).not.toHaveBeenCalled();
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
    expect(useUiStore.getState().skillRuns['/a'] ?? {}).toEqual({});
  });

  it('a run that spawned as the vault switched is stopped and its fire key surrendered', async () => {
    // Opening B stops A's runs in Rust (`start_watcher`), but a spawn that
    // lands after that sweep is still A's. The runner stops it by id and
    // gives its claim back, durable and local: it never got to run.
    let spawned: (start: Awaited<ReturnType<typeof agentIpc.runAgent>>) => void = () => undefined;
    vi.mocked(agentIpc.runAgent).mockImplementation(
      () =>
        new Promise((resolve) => {
          spawned = resolve;
        }),
    );
    vi.mocked(agentIpc.stopAgent).mockClear();
    useVaultStore.setState({ entries: [digest] });
    renderHook(() => useJobRunner());
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledWith('/a', expect.anything());
    expect(useUiStore.getState().skillRuns['/a']).toEqual({ [digest.path]: DIGEST_FIRE });

    act(() => useVaultStore.setState({ vaultPath: '/b' }));
    await act(async () => {
      spawned({ run: JOB_RUN, durableId: JOB_DURABLE });
      await Promise.resolve();
    });
    expect(vi.mocked(agentIpc.stopAgent)).toHaveBeenCalledWith(JOB_RUN);
    expect(vi.mocked(ipc.jobLedgerUnclaim)).toHaveBeenCalledWith(
      '/a',
      'skillRuns',
      digest.path,
      DIGEST_FIRE,
    );
    expect(useUiStore.getState().skillRuns['/a']).toEqual({});
    expect(useUiStore.getState().runs).toEqual([]);
    // No cooldown and no subscription: the run is not this window's to follow.
    expect(vi.mocked(ipc.jobLedgerStamp)).not.toHaveBeenCalled();
    expect(handlers).toHaveLength(0);
  });
});
