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

import * as agentIpc from './agentIpc';
import { useJobRunner } from './useJobRunner';
import { makeEntry } from '@/engine/testHelpers';
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
