import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const handlers: Array<(event: unknown) => void> = [];
/** The run id the mocked runAgent hands back for every job. */
const JOB_RUN = 8;
/** M33.7: `runAgent` hands back BOTH ids — the process tag the stream is
 * filtered by, and the durable id the run's database row is keyed under. */
const JOB_DURABLE = 'durable-job-8';
vi.mock('./agentIpc', () => ({
  runAgent: vi.fn(async () => ({ run: JOB_RUN, durableId: JOB_DURABLE })),
  startMcp: vi.fn(async () => ({ port: 1, token: 't' })),
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
// The runner only needs the prompt string; importing the real panel drags the
// whole chat surface into a hook test.
vi.mock('./systemPrompt', () => ({ buildSystemPrompt: () => 'sys' }));
// Scheduled runs read their record's body before consuming the fire key.
// The durable ledgers (M34.2.3) are mocked at the wire so each test controls
// hydration and the claim verdict without sharing mockIpc's module state.
vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return {
    ...actual,
    readNote: vi.fn(async () => '---\ntype: Skill\n---\nplaybook'),
    jobLedgerRead: vi.fn(async () => ({ attempts: {}, skillRuns: {}, triggerRuns: {} })),
    jobLedgerClaim: vi.fn(async () => true),
    jobLedgerUnclaim: vi.fn(async () => true),
    jobLedgerStamp: vi.fn(async () => undefined),
    jobLedgerImport: vi.fn(async () => 0),
  };
});

import * as agentIpc from './agentIpc';
import { useJobRunner } from './useJobRunner';
import { makeEntry } from '@/engine/testHelpers';
import { loadRunLog } from '@/engine/runLog';
import * as ipc from '@/lib/ipc';
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

/** Restore the ledger wire mocks to their defaults: hydration finds an empty
 * table, every claim is fresh. Called from each describe's beforeEach — the
 * mocks are module-level and a verdict one test scripted must not leak. */
function resetLedgerMocks(): void {
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
      entries: [note],
      rescan: vi.fn(async () => undefined),
    });
    useUiStore.setState({
      autoLearn: true,
      learnAttempts: {},
      skillRuns: {},
      runs: [],
      agentShellAccess: false,
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
      entries: [skill('records/skills/digest.md', 'Digest')],
      rescan: vi.fn(async () => undefined),
    });
    useUiStore.setState({
      autoLearn: true,
      learnAttempts: {},
      skillRuns: {},
      runs: [],
      agentShellAccess: false,
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
    // must not reach across.
    act(() => useVaultStore.setState({ vaultPath: '/other' }));
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
 * vault-authored content, so the Settings toggle — the assistant's grant,
 * made for attended turns — is only a ceiling here. The one path to shell on
 * a schedule is an Agent record declaring `tools: shell` inside that ceiling.
 */
describe('useJobRunner shell gating', () => {
  const agentRecord = (path: string, title: string, tools?: string) =>
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
      entries: [],
      rescan: vi.fn(async () => undefined),
    });
    useUiStore.setState({
      autoLearn: true,
      learnAttempts: {},
      skillRuns: {},
      runs: [],
      agentShellAccess: true, // the ceiling is OPEN in every case below
      agentConnectors: false,
      stdioApprovals: {},
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('a scheduled skill never inherits the Settings shell toggle', async () => {
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
    expect(vi.mocked(agentIpc.runAgent).mock.calls[0][1]).toMatchObject({ shell: false });
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
    window.localStorage.removeItem('cerebro.runLog');
    useVaultStore.setState({
      entries: [agentRecord('records/agents/scout.md', 'Scout')],
    });
    renderHook(() => useJobRunner());
    await startJob();
    act(() => handlers.forEach((h) => h({ run: JOB_RUN, kind: 'Done' })));

    const [entry] = loadRunLog();
    expect(entry.dueAt).toBeDefined();
    const due = new Date(entry.dueAt!);
    expect([due.getHours(), due.getMinutes()]).toEqual([9, 0]);
  });

  it('logs a run that died before it started — could not tell is not found nothing (M34.2)', async () => {
    // An unreadable record used to end in pure silence: no run row, no log
    // entry, indistinguishable from "nothing was due". The absence of a row
    // reads as an empty state, and this surface is not allowed to say
    // "nothing happened" when it means "we could not tell".
    window.localStorage.removeItem('cerebro.runLog');
    vi.mocked(ipc.readNote).mockImplementationOnce(async () => {
      throw new Error('EACCES');
    });
    useVaultStore.setState({
      entries: [agentRecord('records/agents/scout.md', 'Scout')],
    });
    renderHook(() => useJobRunner());
    await startJob();

    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
    const [entry] = loadRunLog();
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
    expect(calls[0][1]).toMatchObject({ shell: true });
    expect(calls[1][1]).toMatchObject({ shell: false });
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
      entries: [skill],
      rescan: vi.fn(async () => undefined),
    });
    useUiStore.setState({
      autoLearn: true,
      learnAttempts: {},
      skillRuns: {},
      triggerRuns: {},
      runs: [],
      agentShellAccess: false,
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
    // claim is surrendered — a consumed key would make the deferral eat the
    // whole period — and the log row is DEFERRED, not failed: nothing went
    // wrong.
    window.localStorage.removeItem('cerebro.runLog');
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
    const [entry] = loadRunLog();
    expect(entry.status).toBe('deferred');
    expect(entry.error).toContain('daily_token_ceiling');
    // The runner is free again, and the local record suppresses a sixty-
    // deferrals-an-hour retry loop for the rest of the session.
    expect(useUiStore.getState().runs).toEqual([]);
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);
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
