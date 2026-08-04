import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const handlers: Array<(event: unknown) => void> = [];
vi.mock('./agentIpc', () => ({
  runAgent: vi.fn(async () => 8),
  startMcp: vi.fn(async () => ({ port: 1, token: 't' })),
  stopAgent: vi.fn(async () => true),
  // Mirrors the real fan-out (M17.3): a subscriber that names a run sees only
  // that run's events. Wrapping here rather than filtering in each test is
  // the point — the scoping is the behaviour under test, so the harness must
  // not be more permissive than production.
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
        () =>
          new Promise<string>((r) => {
            release = r;
          }),
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
        () =>
          new Promise<string>((r) => {
            release = r;
          }),
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
 * Concurrency (M17.3).
 *
 * Two describes used to live here — one for the preempt handshake, one for
 * recognising a killed run's trailing events — and both described the same
 * underlying fact: the backend held ONE child, so a turn could have its
 * process taken out from under it and had to refuse other runs' events by
 * hand. Children are keyed by run id now, and a turn subscribes to its own,
 * so neither situation can arise.
 */
describe('useAgentChat runs beside the background runner', () => {
  const opts = { shell: false, connectors: false };

  beforeEach(() => {
    handlers.length = 0;
    vi.mocked(agentIpc.runAgent).mockClear();
    vi.mocked(agentIpc.stopAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault' });
    useUiStore.setState({ learningPath: null, agentBusy: false });
  });

  it('starts immediately while a background job runs, and kills nothing', async () => {
    // The runner owns a job. The chat used to stop that child and wait up to
    // five seconds for the single slot to be handed over; now both simply run.
    useUiStore.setState({ learningPath: 'notes/reading.md', agentBusy: true });
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => result.current.send('question'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    expect(vi.mocked(agentIpc.stopAgent)).not.toHaveBeenCalled();
  });

  it('never sees another run’s events, including its terminal Done', async () => {
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => result.current.send('question'));
    await vi.waitFor(() => expect(handlers.length).toBeGreaterThan(0));

    // A foreign run reports finished — a background distill, another
    // conversation, or a child killed a moment ago. None of it is this turn's
    // business, and no bookkeeping is needed to know that.
    act(() => handlers.forEach((h) => h({ run: 999, kind: 'Done' })));
    expect(result.current.streaming).toBe(true);
    act(() => handlers.forEach((h) => h({ run: 999, kind: 'TextDelta', text: 'not mine' })));
    expect(result.current.messages[1].text).toBe('');

    // Its own run still drives it.
    act(() => handlers.forEach((h) => h({ run: 8, kind: 'TextDelta', text: 'answer' })));
    expect(result.current.messages[1].text).toBe('answer');
    act(() => handlers.forEach((h) => h({ run: 8, kind: 'Done' })));
    expect(result.current.streaming).toBe(false);
  });

  it('stops its OWN run by id, not whatever happens to be running', async () => {
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => result.current.send('question'));
    await vi.waitFor(() => expect(handlers.length).toBeGreaterThan(0));

    act(() => result.current.stop());
    expect(vi.mocked(agentIpc.stopAgent)).toHaveBeenCalledWith(8);
    expect(result.current.streaming).toBe(false);
  });

  it('unsubscribes when the turn ends, so a later run cannot reach it', async () => {
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => result.current.send('question'));
    await vi.waitFor(() => expect(handlers.length).toBeGreaterThan(0));
    act(() => handlers.forEach((h) => h({ run: 8, kind: 'Done' })));
    expect(handlers.length).toBe(0);
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

/**
 * Closing the panel mid-answer (M15).
 *
 * `App` renders the assistant conditionally, so ⌘J tears this hook down
 * instantly. Nothing used to run on the way out: the child kept going and
 * `agentBusy` stayed true forever, which made useJobRunner's own guard bail
 * for the rest of the session — the background distiller silently stopped.
 */
describe('useAgentChat unmounted mid-turn', () => {
  const opts = { shell: false, connectors: false };

  beforeEach(() => {
    handlers.length = 0;
    vi.mocked(agentIpc.runAgent).mockClear();
    vi.mocked(agentIpc.stopAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault' });
    useUiStore.setState({ learningPath: null, agentBusy: false });
  });

  it('stops the run and releases the shared busy flag', async () => {
    const { result, unmount } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => result.current.send('question'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    expect(useUiStore.getState().agentBusy).toBe(true);

    unmount();
    expect(vi.mocked(agentIpc.stopAgent)).toHaveBeenCalled();
    expect(useUiStore.getState().agentBusy).toBe(false);
  });

  it('leaves an idle agent alone', () => {
    const { unmount } = renderHook(() => useAgentChat('sys', opts, null));
    unmount();
    expect(vi.mocked(agentIpc.stopAgent)).not.toHaveBeenCalled();
  });
});

/**
 * A tool_id is unique within a turn, so a repeat of it is a REDELIVERY of one
 * call, never a second call (M15). Appending it blindly put duplicate React
 * keys in shipped transcripts; rebuilding the row from the start event alone
 * traded that for a finished tool that goes back to running (PR #7 review).
 */
describe('useAgentChat and a redelivered ToolStart', () => {
  const opts = { shell: false, connectors: false };

  beforeEach(() => {
    handlers.length = 0;
    vi.mocked(agentIpc.runAgent).mockClear();
    vi.mocked(agentIpc.stopAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault' });
    useUiStore.setState({ learningPath: null, agentBusy: false });
  });

  it('keeps a finished tool finished', async () => {
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => result.current.send('question'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());

    const start = { run: 8, kind: 'ToolStart', tool_id: 't-1', tool_name: 'Read', input: 'a.md' };
    act(() => handlers.forEach((h) => h(start)));
    act(() =>
      handlers.forEach((h) => h({ run: 8, kind: 'ToolDone', tool_id: 't-1', output: 'contents' })),
    );
    expect(result.current.messages[1].tools[0]).toMatchObject({
      done: true,
      output: 'contents',
      failed: false,
    });

    // The same start event again: still one row, and still the result the
    // user already read — not a blank tool spinning a second time.
    act(() => handlers.forEach((h) => h(start)));
    expect(result.current.messages[1].tools).toHaveLength(1);
    expect(result.current.messages[1].tools[0]).toMatchObject({
      done: true,
      output: 'contents',
      failed: false,
    });
  });

  it('still collapses a redelivery that arrives before the tool finishes', async () => {
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() => result.current.send('question'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());

    const start = { run: 8, kind: 'ToolStart', tool_id: 't-1', tool_name: 'Read', input: 'a.md' };
    act(() => handlers.forEach((h) => h(start)));
    act(() => handlers.forEach((h) => h(start)));
    expect(result.current.messages[1].tools).toHaveLength(1);
    expect(result.current.messages[1].tools[0]).toMatchObject({ done: false, input: 'a.md' });

    // And the completion still lands on it.
    act(() =>
      handlers.forEach((h) => h({ run: 8, kind: 'ToolDone', tool_id: 't-1', is_error: true })),
    );
    expect(result.current.messages[1].tools[0]).toMatchObject({ done: true, failed: true });
  });
});

/**
 * Restored ids and fresh ids never collide (M15). The counter used to reset
 * to 0 per page load while conversations.ts persisted `m-1`/`m-2`, so the
 * first send after a reload minted ids the restored transcript already used
 * and one reply was written into two bubbles.
 */
describe('useAgentChat message ids', () => {
  const opts = { shell: false, connectors: false };

  beforeEach(() => {
    handlers.length = 0;
    vi.mocked(agentIpc.runAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault' });
    useUiStore.setState({ learningPath: null, agentBusy: false });
  });

  it('mints ids that a restored transcript cannot already hold', () => {
    const { result } = renderHook(() => useAgentChat('sys', opts, null));
    act(() =>
      result.current.restore(
        [
          { id: 'm-1', role: 'user', text: 'old question', tools: [] },
          { id: 'm-2', role: 'assistant', text: 'old answer', tools: [] },
        ],
        'sess-old',
      ),
    );
    act(() => result.current.send('new question'));
    const ids = result.current.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);

    // And a reset does not rewind the sequence either.
    act(() => result.current.reset());
    act(() => result.current.send('after reset'));
    expect(result.current.messages.every((m) => !ids.slice(0, 2).includes(m.id))).toBe(true);
  });
});
