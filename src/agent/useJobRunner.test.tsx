import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const handlers: Array<(event: unknown) => void> = [];
/** The run id the mocked runAgent hands back for every job. */
const JOB_RUN = 8;
vi.mock('./agentIpc', () => ({
  runAgent: vi.fn(async () => JOB_RUN),
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
vi.mock('./AiPanel', () => ({ buildSystemPrompt: () => 'sys' }));
// Scheduled runs read their record's body before consuming the fire key.
vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return { ...actual, readNote: vi.fn(async () => '---\ntype: Skill\n---\nplaybook') };
});

import * as agentIpc from './agentIpc';
import { useJobRunner } from './useJobRunner';
import { makeEntry } from '@/engine/testHelpers';
import * as ipc from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/** Mirrors the runner's SETTLE_MS — how long a burst of edits gets to settle. */
const SETTLE = 4_000;

const note = makeEntry({ path: 'items/note.md', title: 'Note', snippet: 'facts' });

/** Advance past the settle timer and flush the run's async start-up. */
async function startJob(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SETTLE);
  });
}

/**
 * Ownership of the shared event stream when chat preempts on TIMEOUT (PR #5
 * review). streamReleased clears learningPath and the chat proceeds without
 * the runner ever running finish(); the takeover transition itself drops the
 * runner's claim. The killed child's terminal Done may arrive later,
 * mid-chat-turn — it must not clear agentBusy (the runner would read the
 * agent as idle and start a run that replaces the chat's child mid-answer) —
 * or it may never arrive at all, and the runner must not stay wedged on it.
 */
describe('useJobRunner stream ownership', () => {
  beforeEach(() => {
    handlers.length = 0;
    vi.useFakeTimers();
    vi.mocked(agentIpc.runAgent).mockClear();
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [note],
      rescan: vi.fn(async () => undefined),
    });
    useUiStore.setState({
      autoLearn: true,
      filedForLearning: ['items/note.md'],
      learnAttempts: {},
      skillRuns: {},
      agentBusy: false,
      learningPath: null,
      agentShellAccess: false,
      agentConnectors: false,
      stdioApprovals: {},
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('finish() on the owned stream releases everything', async () => {
    renderHook(() => useJobRunner());
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().learningPath).toBe('items/note.md');
    expect(useUiStore.getState().agentBusy).toBe(true);

    act(() => handlers.forEach((h) => h({ run: JOB_RUN, kind: 'Done' })));
    expect(useUiStore.getState().learningPath).toBeNull();
    expect(useUiStore.getState().agentBusy).toBe(false);
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
    expect(useUiStore.getState().learningPath).toBe('items/note.md');

    // A chat turn starts beside it and raises the shared busy flag.
    act(() => useUiStore.getState().setAgentBusy(true));

    // The chat's own run finishes. Its Done is not this job's business.
    act(() => handlers.forEach((h) => h({ run: 99, kind: 'Done' })));
    expect(useUiStore.getState().learningPath).toBe('items/note.md');

    // The job ends on ITS terminal event, and releases what it claimed.
    act(() => handlers.forEach((h) => h({ run: JOB_RUN, kind: 'Done' })));
    expect(useUiStore.getState().learningPath).toBeNull();
    expect(useUiStore.getState().agentBusy).toBe(false);
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
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [skill('records/skills/digest.md', 'Digest')],
      rescan: vi.fn(async () => undefined),
    });
    useUiStore.setState({
      autoLearn: true,
      filedForLearning: [],
      learnAttempts: {},
      skillRuns: {},
      agentBusy: false,
      learningPath: null,
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
    expect(useUiStore.getState().agentBusy).toBe(false);
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
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
    expect(useUiStore.getState().skillRuns).toEqual({});

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
    expect(useUiStore.getState().learningPath).toBe('records/skills/digest.md');
    // Parked on the read: no child, and no key spent on a run that has not
    // happened.
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
    expect(useUiStore.getState().skillRuns).toEqual({});

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
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [],
      rescan: vi.fn(async () => undefined),
    });
    useUiStore.setState({
      autoLearn: true,
      filedForLearning: [],
      learnAttempts: {},
      skillRuns: {},
      agentBusy: false,
      learningPath: null,
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
