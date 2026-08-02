import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const handlers: Array<(event: unknown) => void> = [];
vi.mock('./agentIpc', () => ({
  runAgent: vi.fn(async () => 8),
  startMcp: vi.fn(async () => ({ port: 1, token: 't' })),
  stopAgent: vi.fn(async () => null),
  onAgentEvent: vi.fn((handler: (event: unknown) => void) => {
    handlers.push(handler);
    return () => {
      const i = handlers.indexOf(handler);
      if (i >= 0) handlers.splice(i, 1);
    };
  }),
}));

import * as agentIpc from './agentIpc';
import { useAgentChat } from './useAgentChat';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

afterEach(cleanup);

/**
 * The seam that makes skills real (M13.1): the transcript shows what was
 * typed while the agent runs the expanded message. Reverting `message:
 * outgoing` to the typed text — one word — kept every other test green, which
 * is exactly why these exist.
 */
describe('useAgentChat send expansion', () => {
  const opts = { shell: false, connectors: false };

  beforeEach(() => {
    vi.mocked(agentIpc.runAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault' });
  });

  it('shows the typed text but runs the expanded message', async () => {
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => result.current.send('/weekly-review', () => Promise.resolve('EXPANDED BODY')));
    expect(result.current.messages[0].text).toBe('/weekly-review');
    await vi.waitFor(() =>
      expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledWith(
        '/vault',
        expect.objectContaining({ message: 'EXPANDED BODY' }),
      ),
    );
  });

  it('falls back to sending the typed text when the expansion rejects', async () => {
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => result.current.send('/gone', () => Promise.reject(new Error('unreadable'))));
    await vi.waitFor(() =>
      expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledWith(
        '/vault',
        expect.objectContaining({ message: '/gone' }),
      ),
    );
  });

  it('appends the turn synchronously — a pending expansion leaves no window to interleave', () => {
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => result.current.send('/slow', () => new Promise<string>(() => undefined)));
    // Both bubbles exist and streaming is up before the expansion resolves,
    // so a second send sees a busy conversation rather than an idle one.
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.streaming).toBe(true);
  });

  it('still accepts a plain pre-expanded string', async () => {
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => result.current.send('shown', 'sent'));
    expect(result.current.messages[0].text).toBe('shown');
    await vi.waitFor(() =>
      expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledWith(
        '/vault',
        expect.objectContaining({ message: 'sent' }),
      ),
    );
  });

  it('a panel turn runs attended — the one run allowed the legacy MCP fallback', async () => {
    // `attended` gates connector_context's absent-file branch (PR #5
    // security review): a person typed this turn and is watching it, which
    // is what makes inheriting their global MCP config defensible at all.
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => result.current.send('hello'));
    await vi.waitFor(() =>
      expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledWith(
        '/vault',
        expect.objectContaining({ attended: true }),
      ),
    );
  });

  it('stop() during a pending expansion cancels the send — no child for a cancelled turn', async () => {
    // Stop ends the turn, but the send that started it may still be parked
    // on a skill expansion (or the preempt handoff) — and without the epoch
    // it would resume, re-claim the stream, and spawn a child the user
    // already cancelled (PR #5 review).
    let release: (body: string) => void = () => undefined;
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() =>
      result.current.send(
        '/slow',
        () => new Promise<string>((r) => { release = r; }),
      ),
    );
    act(() => result.current.stop());
    await act(async () => {
      release('EXPANDED BODY');
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
      // The bubble was appended before the stream was ever claimed, so
      // stop()'s patchActive could not reach it — the cancelled send must
      // un-spin it on the way out.
      expect(result.current.messages[1].streaming).toBe(false);
      expect(result.current.streaming).toBe(false);
    });
  });

  it('a cancelled send does not wedge the next one', async () => {
    let release: (body: string) => void = () => undefined;
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() =>
      result.current.send(
        '/slow',
        () => new Promise<string>((r) => { release = r; }),
      ),
    );
    act(() => result.current.stop());
    act(() => result.current.send('next question'));
    await act(async () => {
      release('LATE BODY');
      await Promise.resolve();
    });
    // Only the live turn reaches the agent; the cancelled one stays dead.
    await vi.waitFor(() => {
      expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce();
      expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledWith(
        '/vault',
        expect.objectContaining({ message: 'next question' }),
      );
    });
  });
});

/**
 * Preempting the background runner (PR #5 review). Two races lived here:
 * send() fired runAgent before the runner's finish() released the stream
 * (the new turn's events were dropped while learningPath was set — empty
 * bubble), and finish() dropped agentBusy on its way out, letting the
 * runner read the agent as idle and schedule a background run that would
 * replace the chat's child mid-answer.
 */
describe('useAgentChat preempting the background runner', () => {
  const opts = { shell: false, connectors: false };

  beforeEach(() => {
    vi.mocked(agentIpc.runAgent).mockClear();
    vi.mocked(agentIpc.stopAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault' });
    useUiStore.setState({ learningPath: null, agentBusy: false });
  });

  it('waits for the runner to release the stream, then re-claims the busy flag', async () => {
    useUiStore.setState({ learningPath: 'notes/reading.md', agentBusy: true });
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => result.current.send('question'));

    // The kill was issued…
    await vi.waitFor(() => expect(vi.mocked(agentIpc.stopAgent)).toHaveBeenCalled());
    // …but the runner still owns the stream, so the new child must not
    // start: its events would land while the handler is ignoring them.
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();

    // The killed child's terminal Done lands: the runner's finish()
    // releases the stream and drops agentBusy on its way out.
    act(() => {
      useUiStore.getState().setLearningPath(null);
      useUiStore.getState().setAgentBusy(false);
    });

    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    // The chat re-claimed the agent — the runner cannot read it as idle
    // and schedule a background run over this turn.
    expect(useUiStore.getState().agentBusy).toBe(true);
  });

  it('starts immediately when no background run owns the stream', async () => {
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => result.current.send('question'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    expect(vi.mocked(agentIpc.stopAgent)).not.toHaveBeenCalled();
  });
});

/**
 * The killed child's terminal Done (PR #5 review, round four). Events are
 * tagged with their run and stopAgent names the run it killed, so the chat
 * drops a dead run's trailing events by IDENTITY. Timing cannot do it: the
 * stray Done can land in the same dispatch that released the stream — before
 * the new turn even starts — or seconds after a timeout takeover, mid-answer.
 */
describe('useAgentChat and the killed run’s trailing events', () => {
  const opts = { shell: false, connectors: false };

  beforeEach(() => {
    handlers.length = 0;
    vi.mocked(agentIpc.runAgent).mockClear();
    vi.mocked(agentIpc.stopAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault' });
    useUiStore.setState({ learningPath: null, agentBusy: false });
  });

  it('drops the dead run’s late Done instead of ending the new turn', async () => {
    useUiStore.setState({ learningPath: 'notes/reading.md', agentBusy: true });
    vi.mocked(agentIpc.stopAgent).mockResolvedValueOnce(7);
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => result.current.send('question'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.stopAgent)).toHaveBeenCalled());

    // The runner's finish() releases the stream; the new turn starts.
    act(() => {
      useUiStore.getState().setLearningPath(null);
      useUiStore.getState().setAgentBusy(false);
    });
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());

    // The killed child's Done lands late — after the new turn claimed the
    // stream. It belongs to dead history, not to this turn.
    act(() => handlers.forEach((h) => h({ run: 7, kind: 'Done' })));
    expect(result.current.streaming).toBe(true);
    expect(useUiStore.getState().agentBusy).toBe(true);

    // The live run's events still land, and its own Done still ends it.
    act(() => handlers.forEach((h) => h({ run: 8, kind: 'TextDelta', text: 'answer' })));
    expect(result.current.messages[1].text).toBe('answer');
    act(() => handlers.forEach((h) => h({ run: 8, kind: 'Done' })));
    expect(result.current.streaming).toBe(false);
  });

  it('ignores a stray Done delivered before the new turn claims the stream', async () => {
    useUiStore.setState({ learningPath: 'notes/reading.md', agentBusy: true });
    vi.mocked(agentIpc.stopAgent).mockResolvedValueOnce(7);
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => result.current.send('question'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.stopAgent)).toHaveBeenCalled());

    // The runner's listener ran FIRST for the killed child's Done, so the
    // stream is already released when the chat's listener sees the same
    // event — the ordering that used to adopt it as the new turn's Done.
    act(() => {
      useUiStore.getState().setLearningPath(null);
      useUiStore.getState().setAgentBusy(false);
    });
    act(() => handlers.forEach((h) => h({ run: 7, kind: 'Done' })));

    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    expect(result.current.streaming).toBe(true);
    expect(result.current.messages[1].streaming).toBe(true);
  });
});

/**
 * One turn at a time (PR #5 review, Bugbot). `activeRef` is claimed
 * deliberately late — after the preempt handoff — so it cannot double as
 * the guard: a second send fired in that gap would reach runAgent too, the
 * backend's replacement-kill would swap children mid-handoff, and the first
 * child's terminal Done — never named by any stopAgent, so never registered
 * dead — would be adopted as the second turn's, freezing its bubble before
 * its own child says a word.
 */
describe('useAgentChat one turn at a time', () => {
  const opts = { shell: false, connectors: false };

  beforeEach(() => {
    handlers.length = 0;
    vi.mocked(agentIpc.runAgent).mockClear();
    vi.mocked(agentIpc.stopAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault' });
    useUiStore.setState({ learningPath: null, agentBusy: false });
  });

  it('drops a send fired while a turn is in flight', async () => {
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => {
      result.current.send('first');
      // Same tick: `streaming` render state is still stale here, which is
      // exactly the window the ref guard exists for.
      result.current.send('second');
    });
    expect(result.current.messages).toHaveLength(2);
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce());

    // The turn's own Done reopens the conversation.
    act(() => handlers.forEach((h) => h({ run: 8, kind: 'Done' })));
    act(() => result.current.send('third'));
    expect(result.current.messages).toHaveLength(4);
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(2));
  });

  it('a turn that fails to start releases the guard for the next send', async () => {
    vi.mocked(agentIpc.runAgent).mockRejectedValueOnce(new Error('spawn failed'));
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => result.current.send('doomed'));
    await vi.waitFor(() => expect(result.current.streaming).toBe(false));
    act(() => result.current.send('retry'));
    expect(result.current.messages).toHaveLength(4);
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(2));
  });

  it('stop() releases the guard for the next send', async () => {
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => result.current.send('first'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce());
    act(() => result.current.stop());
    act(() => result.current.send('second'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(2));
  });
});
