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
 * the runner ever running finish(); the killed child's terminal Done arrives
 * later, mid-chat-turn. finish() firing whole would clear agentBusy — the
 * runner would read the agent as idle and start a background run that
 * replaces the chat's child mid-answer.
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

  it('a late Done after a timeout takeover drops the claim without touching the chat\'s busy flag', async () => {
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
});
