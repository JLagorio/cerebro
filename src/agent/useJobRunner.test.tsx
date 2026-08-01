import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const handlers: Array<(event: unknown) => void> = [];
vi.mock('./agentIpc', () => ({
  runAgent: vi.fn(async () => undefined),
  startMcp: vi.fn(async () => ({ port: 1, token: 't' })),
  stopAgent: vi.fn(async () => undefined),
  onAgentEvent: vi.fn((handler: (event: unknown) => void) => {
    handlers.push(handler);
    return () => {
      const i = handlers.indexOf(handler);
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

    act(() => handlers.forEach((h) => h({ kind: 'Done' })));
    expect(useUiStore.getState().learningPath).toBeNull();
    expect(useUiStore.getState().agentBusy).toBe(false);
  });

  it("a late Done after a timeout takeover drops the claim without touching the chat's busy flag", async () => {
    renderHook(() => useJobRunner());
    await startJob();
    expect(useUiStore.getState().learningPath).toBe('items/note.md');

    // The chat's streamReleased timed out: it cleared learningPath and took
    // the stream; its send() holds agentBusy for the turn now in flight.
    act(() => useUiStore.getState().setLearningPath(null));
    expect(useUiStore.getState().agentBusy).toBe(true);

    // The killed background child's terminal Done lands mid-chat-turn.
    act(() => handlers.forEach((h) => h({ kind: 'Done' })));

    // Busy is the chat's — the runner must not clear it and start a run
    // that replaces the chat's child mid-answer.
    expect(useUiStore.getState().agentBusy).toBe(true);

    // But the claim IS dropped: once the chat's turn ends, the runner can
    // pick up the next job rather than sitting wedged on a stale flag.
    act(() => {
      useUiStore.getState().setAgentBusy(false);
      // The first attempt consumed the filing and recorded the ledger; put
      // both back so the same note derives a fresh job.
      useUiStore.setState({ learnAttempts: {}, filedForLearning: ['items/note.md'] });
    });
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(2);
  });

  it('a takeover whose killed child never emits Done still frees the runner', async () => {
    renderHook(() => useJobRunner());
    await startJob();
    expect(useUiStore.getState().learningPath).toBe('items/note.md');

    // The chat's streamReleased timed out BECAUSE the killed child's terminal
    // Done was lost — so no terminal event for this run will ever arrive.
    // The takeover transition alone must drop the runner's claim.
    act(() => useUiStore.getState().setLearningPath(null));

    // The chat's turn ends; the note is refiled. If the runner were still
    // waiting on the lost Done to clear `running`, no job would ever be
    // scheduled again this session.
    act(() => {
      useUiStore.getState().setAgentBusy(false);
      useUiStore.setState({ learnAttempts: {}, filedForLearning: ['items/note.md'] });
    });
    await startJob();
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(2);
  });

  it('a takeover while start-up is parked on an await never spawns the stale job', async () => {
    // Between claiming the stream and runAgent, start-up awaits readNote and
    // startMcp. A chat takeover in that window drops the claim — and the
    // resumed start-up must quit, because a spawn now would replace the
    // chat's child mid-answer through the single shared AgentState (PR #5
    // review).
    let releaseMcp: (value: Awaited<ReturnType<typeof agentIpc.startMcp>>) => void = () =>
      undefined;
    vi.mocked(agentIpc.startMcp).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseMcp = resolve;
        }),
    );
    renderHook(() => useJobRunner());
    await startJob();
    // The claim is up but no child exists yet — start-up is parked.
    expect(useUiStore.getState().learningPath).toBe('items/note.md');
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();

    // The chat takes the stream by timeout; the subscriber drops the claim.
    act(() => useUiStore.getState().setLearningPath(null));

    await act(async () => {
      releaseMcp({ url: 'mock://cerebro', token: 't' });
      await Promise.resolve();
    });
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
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

    act(() => handlers.forEach((h) => h({ kind: 'Done' })));
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

  it('a preempted scheduled job keeps its fire key — a takeover is not a run', async () => {
    // The key is consumed after the read AND only while the runner still
    // owns the stream (PR #5 review): a job whose start-up was preempted
    // mid-read never ran, so it must retry when the agent is next idle
    // rather than silently skipping the whole period.
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

    // Chat takeover lands while the record's body is still being read.
    act(() => useUiStore.getState().setLearningPath(null));
    await act(async () => {
      releaseRead('---\ntype: Skill\n---\nplaybook');
      await Promise.resolve();
    });

    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
    expect(useUiStore.getState().skillRuns).toEqual({});
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
      properties: tools === undefined ? { schedule: 'daily 09:00' } : { schedule: 'daily 09:00', tools },
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
    act(() => handlers.forEach((h) => h({ kind: 'Done' })));
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
