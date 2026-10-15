import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const handlers: Array<(event: unknown) => void> = [];
/** The runs' journals (M57.6), by run: what `journalEmit` numbered and held,
 * from `first`, and whether the run said Done. A run with none is followed
 * live only, as the tests before M57.6 emit. */
const journals = new Map<
  number,
  { events: Array<Record<string, unknown>>; first: number; done: boolean }
>();
/** Runs the journal no longer knows. */
const unknownRuns = new Set<number>();
vi.mock('./agentIpc', () => ({
  // M33.7: the pair, not the bare tag; M57.6: and the key a re-attach and
  // the host name the run by.
  runAgent: vi.fn(async () => ({ run: 8, durableId: 'durable-chat-8', attach: 'durable-chat-8' })),
  // The real narrowing (M34.2.4): a scripted deferral must throw here the
  // way production would, not slip through a permissive stub.
  startedOrThrow: (start: { run: number } | { deferred: string[] }) => {
    if ('deferred' in start) throw new Error(`run deferred: ${start.deferred.join(', ')}`);
    return start;
  },
  stopAgent: vi.fn(async () => true),
  // M57.1: the answer command and its book. Nothing waits unless a test
  // says so.
  answerInteraction: vi.fn(async () => ({
    resumed: {
      run: 9,
      durableId: 'durable-chat-9',
      sessionId: 'session-1',
      attach: 'durable-chat-9',
    },
  })),
  cancelInteraction: vi.fn(async () => true),
  listInteractions: vi.fn(async () => []),
  // M56.3/M57.6: the session file a gap or an unknown run rebuilds from.
  readCliTranscript: vi.fn(async () => ({
    state: 'unavailable',
    reason: 'not_recorded',
    retention_days: 30,
  })),
  // M57.6: the real adapter's order, over the journals above: subscribe,
  // answer, then the journal after the cursor, each event once.
  attachRun: vi.fn(
    async (
      handle: { run: number; attach?: string },
      after: number,
      deliver: (event: unknown) => void,
      onState?: (state: string, done: boolean) => void,
    ) => {
      if (unknownRuns.has(handle.run)) {
        onState?.('unknown', false);
        return { state: 'unknown' };
      }
      let cursor = after;
      const take = (event: unknown) => {
        const seq = (event as { seq?: unknown }).seq;
        if (typeof seq === 'number') {
          if (seq <= cursor) return;
          cursor = seq;
        }
        deliver(event);
      };
      const scoped = (event: unknown) => {
        if ((event as { run?: number }).run === handle.run) take(event);
      };
      handlers.push(scoped);
      const detach = () => {
        const i = handlers.indexOf(scoped);
        if (i >= 0) handlers.splice(i, 1);
      };
      const journal = journals.get(handle.run);
      const state = journal !== undefined && after + 1 < journal.first ? 'gap' : 'held';
      const done = journal?.done ?? false;
      onState?.(state, done);
      for (const event of journal?.events ?? []) take(event);
      return { state, done, detach };
    },
  ),
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
// An addressed turn reads its agent's record through the app's own door
// (M53.5). Mocked at the wire, as useJobRunner's tests do, so each test says
// what the record holds without sharing mockIpc's fake disk.
vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return { ...actual, readNote: vi.fn() };
});

import * as agentIpc from './agentIpc';
import { STOP_CONFIRM_MS, useAgentChat, type TurnContext } from './useAgentChat';
import type { ChatMessage, LiveTurn, PendingInteraction } from './types';
import { registerFlush } from '@/editor/openPages';
import { makeEntry } from '@/engine/testHelpers';
import { mentionedTools, type PromptGrant } from '@/engine/toolGrant';
import * as ipc from '@/lib/ipc';
import type { ShellCeiling } from '@/lib/policy/toolApproval';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

afterEach(cleanup);

/** What an addressed agent's record holds, unless a test says otherwise. */
const RECORD_BODY = '# Release scout\n\nKeep a running brief on what threatens the next release.';
beforeEach(() => {
  vi.mocked(ipc.readNote).mockReset();
  vi.mocked(ipc.readNote).mockResolvedValue(RECORD_BODY);
});

/** A turn's context (M17.6/M17.7). Most tests care only about the prompt,
 * which is a composer the hook calls with the turn's grant (M54.7). */
const turnOf = (systemPrompt: string): TurnContext => ({
  systemPrompt: () => systemPrompt,
  place: null,
  conversationId: 'c-1',
});
const turn = (systemPrompt: string) => () => turnOf(systemPrompt);

/**
 * The seam that makes skills real (M13.1): the transcript shows what was
 * typed while the agent runs the expanded message. Reverting `message:
 * outgoing` to the typed text — one word — kept every other test green, which
 * is exactly why these exist.
 */
describe('useAgentChat send expansion', () => {
  const opts = { shell: 'off' as const, connectors: false };

  beforeEach(() => {
    vi.mocked(agentIpc.runAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault' });
  });

  it('freezes the context the question was asked in (M17.6)', async () => {
    // The prompt is a getter because the panel rebuilds it from context chips,
    // the vault, and the open record — all of which move while a send is
    // parked on a skill expansion. Reading it after that await would send the
    // context the user drifted INTO, which is the whole complaint: "it
    // confuses the AI".
    let context = 'context: Roadmap';
    let release = (_: string) => {};
    const expansion = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { result } = renderHook(() => useAgentChat(() => turnOf(context), opts));

    act(() => result.current.send('revise this', () => expansion));
    // The user walks somewhere else while the expansion is still in flight.
    context = 'context: Inbox';
    await act(async () => {
      release('EXPANDED');
      await expansion;
    });

    await vi.waitFor(() =>
      expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledWith(
        '/vault',
        expect.objectContaining({ systemPrompt: 'context: Roadmap' }),
      ),
    );
  });

  it('pushes no CURRENT STATE block — a person is watching this one (M33.8)', async () => {
    // The block exists for runs nobody is watching, which may be carrying
    // weeks-old notes about the vault. The panel pushes its own live context
    // every turn, so a second copy here would be duplication the user pays
    // for on every message.
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.send('what is at risk?', undefined));

    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    const [, options] = vi.mocked(agentIpc.runAgent).mock.calls[0];
    expect(options.message).not.toContain('CURRENT STATE');
    expect(options.systemPrompt).not.toContain('CURRENT STATE');
  });

  it('shows the typed text but runs the expanded message', async () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
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
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.send('/gone', () => Promise.reject(new Error('unreadable'))));
    await vi.waitFor(() =>
      expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledWith(
        '/vault',
        expect.objectContaining({ message: '/gone' }),
      ),
    );
  });

  it('appends the turn synchronously — a pending expansion leaves no window to interleave', () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.send('/slow', () => new Promise<string>(() => undefined)));
    // Both bubbles exist and streaming is up before the expansion resolves,
    // so a second send sees a busy conversation rather than an idle one.
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.streaming).toBe(true);
  });

  it('still accepts a plain pre-expanded string', async () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.send('shown', 'sent'));
    expect(result.current.messages[0].text).toBe('shown');
    await vi.waitFor(() =>
      expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledWith(
        '/vault',
        expect.objectContaining({ message: 'sent' }),
      ),
    );
  });

  // M52.4 — a surface's labelled ask shows its label and sends its prompt.
  // Retrying a failed one sent the label: the agent was asked "Ask to revise ·
  // Sync error rate" with none of the instructions behind it.
  it('keeps a labelled ask’s prompt on its bubble, and a retry sends the prompt again', async () => {
    const label = 'Ask to revise · Sync error rate';
    const prompt = 'Revise the knowledge concept at knowledge/metrics/sync-error-rate.md.';
    vi.mocked(agentIpc.runAgent).mockRejectedValueOnce(new Error('spawn failed'));
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.send(label, prompt));
    const question = result.current.messages[0];
    expect(question).toMatchObject({ role: 'user', text: label, prompt });
    await vi.waitFor(() => expect(result.current.messages[1].error).toBe('spawn failed'));

    // What the panel's Retry does with the failed turn's question.
    act(() => result.current.send(question.text, question.prompt));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(agentIpc.runAgent).mock.calls[1][1].message).toBe(prompt);
    expect(result.current.messages[2]).toMatchObject({ text: label, prompt });
  });

  it('keeps no prompt when the bubble is what was sent', () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.send('what is at risk?', ' what is at risk? '));
    expect(result.current.messages[0]).not.toHaveProperty('prompt');
  });

  it('a panel turn runs attended — the one run allowed the legacy MCP fallback', async () => {
    // `attended` gates connector_context's absent-file branch (PR #5
    // security review): a person typed this turn and is watching it, which
    // is what makes inheriting their global MCP config defensible at all.
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.send('hello'));
    await vi.waitFor(() =>
      expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledWith(
        '/vault',
        expect.objectContaining({ attended: true }),
      ),
    );
  });

  it('a turn hands the backend no endpoint and no bearer (M53.10)', async () => {
    // Rust sets both for every run, and binds the bearer to the vault the run
    // works in; the wire cannot carry either. The panel used to fetch the
    // endpoint's address and its base token once, and hand them back on
    // every turn, in whichever vault was open by then.
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.send('hello'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    const [, options] = vi.mocked(agentIpc.runAgent).mock.calls[0];
    expect(Object.keys(options).filter((key) => key.toLowerCase().includes('mcp'))).toEqual([]);
  });

  it('stop() during a pending expansion cancels the send — no child for a cancelled turn', async () => {
    // Stop ends the turn, but the send that started it may still be parked
    // on a skill expansion (or the preempt handoff) — and without the epoch
    // it would resume, re-claim the stream, and spawn a child the user
    // already cancelled (PR #5 review).
    let release: (body: string) => void = () => undefined;
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
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

  /* M53.6 — a save that lands after the agent's write puts the old text back,
     so the open pages' pending saves land before the child is spawned. */
  it('lands every open page’s pending save before the child starts', async () => {
    let land = () => {};
    const unregister = registerFlush(
      () =>
        new Promise<void>((resolve) => {
          land = resolve;
        }),
    );
    try {
      const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
      act(() => result.current.send('append to the page I am typing in'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
      await act(async () => land());
      await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce());
    } finally {
      unregister();
    }
  });

  it('a cancelled send does not wedge the next one', async () => {
    let release: (body: string) => void = () => undefined;
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
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
  const opts = { shell: 'off' as const, connectors: false };

  beforeEach(() => {
    handlers.length = 0;
    vi.mocked(agentIpc.runAgent).mockClear();
    vi.mocked(agentIpc.stopAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault' });
    useUiStore.setState({ runs: [] });
  });

  it('starts immediately while a background job runs, and kills nothing', async () => {
    // The runner owns a job. The chat used to stop that child and wait up to
    // five seconds for the single slot to be handed over; now both simply run.
    useUiStore.setState({
      runs: [
        {
          id: 'job-1',
          owner: 'job',
          label: 'reading',
          place: null,
          path: 'notes/reading.md',
          conversationId: null,
          run: 7,
          startedAt: 0,
        },
      ],
    });
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.send('question'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    expect(vi.mocked(agentIpc.stopAgent)).not.toHaveBeenCalled();
  });

  it('never sees another run’s events, including its terminal Done', async () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
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
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.send('question'));
    await vi.waitFor(() => expect(handlers.length).toBeGreaterThan(0));

    act(() => result.current.stop());
    expect(vi.mocked(agentIpc.stopAgent)).toHaveBeenCalledWith(8);
    // M57.5: the turn ends with its run's Done, not with the click.
    expect(result.current.streaming).toBe(true);
    act(() => handlers.forEach((h) => h({ run: 8, kind: 'Cancelled' })));
    act(() => handlers.forEach((h) => h({ run: 8, kind: 'Done' })));
    expect(result.current.streaming).toBe(false);
  });

  it('unsubscribes when the turn ends, so a later run cannot reach it', async () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
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
  const opts = { shell: 'off' as const, connectors: false };

  beforeEach(() => {
    handlers.length = 0;
    vi.mocked(agentIpc.runAgent).mockClear();
    vi.mocked(agentIpc.stopAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault' });
    useUiStore.setState({ runs: [] });
  });

  it('drops a send fired while a turn is in flight', async () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => {
      result.current.send('first');
      // Same tick: callers route mid-turn text to Up next by `busy()`
      // (M57.5); the guard only stops a second dispatch slipping through.
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
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.send('doomed'));
    await vi.waitFor(() => expect(result.current.streaming).toBe(false));
    act(() => result.current.send('retry'));
    expect(result.current.messages).toHaveLength(4);
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(2));
  });

  it('stop() releases the guard for the next send once its run’s Done comes', async () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.send('first'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(handlers.length).toBeGreaterThan(0));
    act(() => result.current.stop());
    // M57.5: the stopped child is still in its grace, so nothing else may
    // write its session yet.
    act(() => result.current.send('second'));
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce();
    act(() => handlers.forEach((h) => h({ run: 8, kind: 'Cancelled' })));
    act(() => handlers.forEach((h) => h({ run: 8, kind: 'Done' })));
    act(() => result.current.send('second'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(2));
  });
});

/**
 * Closing the panel mid-answer (M15, M57.6).
 *
 * `App` renders the assistant conditionally, so ⌘J tears this hook down
 * instantly. That used to stop the run; since M57.6 it detaches: the run
 * goes on, its registry record stays for ChatTurnsHost to settle, and the
 * thread saves `live` to re-attach from.
 */
/** The unmount's detach waits a tick, so StrictMode's pretend unmount can
 * take it back. */
const afterUnmount = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));

describe('useAgentChat unmounted mid-turn', () => {
  const opts = { shell: 'off' as const, connectors: false };

  beforeEach(() => {
    handlers.length = 0;
    vi.mocked(agentIpc.runAgent).mockClear();
    vi.mocked(agentIpc.stopAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault' });
    useUiStore.setState({ runs: [] });
  });

  it('closing the panel mid-turn detaches and never stops the run', async () => {
    const { result, unmount } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.send('question'));
    await vi.waitFor(() => expect(handlers.length).toBeGreaterThan(0));
    // M17.7: a task exists from the moment Send is pressed, and carries the
    // question as its label — a run list saying "Assistant working" and
    // nothing else was the thing that could not answer "working on what?".
    const task = useUiStore.getState().runs[0];
    expect(task.owner).toBe('chat');
    expect(task.label).toBe('question');
    expect(task.run).toBe(8);
    expect(task.attach).toBe('durable-chat-8');
    expect(result.current.live).toEqual({
      run: 8,
      attach: 'durable-chat-8',
      assistantId: result.current.messages[1].id,
    });

    unmount();
    await afterUnmount();
    expect(vi.mocked(agentIpc.stopAgent)).not.toHaveBeenCalled();
    // The record is the host's to end, at the run's Done, panel or not.
    expect(useUiStore.getState().runs).toEqual([task]);
    expect(handlers).toHaveLength(0);
  });

  it('cancels a send still parked before its child, and ends its task', async () => {
    let release = (_: string) => {};
    const expansion = new Promise<string>((resolve) => (release = resolve));
    const { result, unmount } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.send('/skill', () => expansion));
    unmount();
    await afterUnmount();
    expect(useUiStore.getState().runs).toEqual([]);
    await act(async () => {
      release('BODY');
      await expansion;
    });
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
  });

  it('leaves an idle agent alone', () => {
    const { unmount } = renderHook(() => useAgentChat(turn('sys'), opts));
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
  const opts = { shell: 'off' as const, connectors: false };

  beforeEach(() => {
    handlers.length = 0;
    vi.mocked(agentIpc.runAgent).mockClear();
    vi.mocked(agentIpc.stopAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault' });
    useUiStore.setState({ runs: [] });
  });

  it('keeps a finished tool finished', async () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
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
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
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
 * M33b.6 — `@agent-slug` routes the turn.
 *
 * The capability is entirely a routing one: everything it hands the run —
 * `actor`, `scope`, `allowedTools`, `connectorNames` — is a field `runAgent`
 * has taken since M17.13/M18.4, and every one of them can only SUBTRACT.
 * These tests are about which values arrive, and about the fact that nothing
 * about the thread moves when one does (D8).
 */
describe('useAgentChat addressed by name (M33b.6)', () => {
  const agentEntry = (properties: Record<string, unknown>) =>
    makeEntry({
      path: 'records/agents/scout.md',
      title: 'Release scout',
      type: 'Agent',
      properties: { slug: 'release-scout', ...properties } as never,
    });

  /** Settings says yes to everything; the record is what narrows. */
  const wideOpen = { shell: 'on' as const, connectors: true };

  const optionsOfLastRun = () => {
    const calls = vi.mocked(agentIpc.runAgent).mock.calls;
    return calls[calls.length - 1][1];
  };

  beforeEach(() => {
    handlers.length = 0;
    vi.mocked(agentIpc.runAgent).mockClear();
    useUiStore.setState({ runs: [] });
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        agentEntry({ tools: 'safe', scope: ['records/risks'] }),
        makeEntry({ path: 'work/ship.md', title: 'Ship the beta', type: 'Work item' }),
      ],
    });
  });

  it('routes the turn to the named agent’s identity and scope', async () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), wideOpen));
    act(() => result.current.send('@release-scout what is slipping?'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());

    const options = optionsOfLastRun();
    // M13.4: attribution rides the bearer token, so this is also what the
    // `runs` row records — an addressed turn is a run the fleet can see.
    expect(options.actor).toBe('process:release-scout');
    expect(options.scope).toEqual(['records/risks']);
  });

  it('carries the agent’s memory into the turn, corrections first', async () => {
    useVaultStore.setState({
      entries: [agentEntry({ recent: 'MY OWN NOTES', preferences: 'HUMAN CORRECTION' })],
    });
    const { result } = renderHook(() => useAgentChat(turn('sys'), wideOpen));
    act(() => result.current.send('@release-scout status?'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());

    const { message } = optionsOfLastRun();
    expect(message).toContain('HUMAN CORRECTION');
    expect(message).toContain('MY OWN NOTES');
    // The same assembly the scheduled path uses, so the priority order cannot
    // drift apart between the two.
    expect(message.indexOf('HUMAN CORRECTION')).toBeLessThan(message.indexOf('MY OWN NOTES'));
    // The block LEADS. A recipient's brief arriving after the question would
    // read as a footnote to it.
    expect(message.indexOf('Release scout')).toBeLessThan(message.indexOf('status?'));
    expect(message.endsWith('@release-scout status?')).toBe(true);
  });

  it('leaves the thread exactly where it was — a recipient is not a place (D8)', async () => {
    const place = { kind: 'inbox' } as const;
    const { result } = renderHook(() =>
      useAgentChat(() => ({ systemPrompt: () => 'sys', place, conversationId: 'c-7' }), wideOpen),
    );
    act(() => result.current.send('@release-scout look here'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());

    // The turn is filed under the conversation and the place it was already
    // in. Addressing someone is not going somewhere, and this phase must not
    // grow a second thread list to prove it.
    const task = useUiStore.getState().runs[0];
    expect(task.place).toEqual(place);
    expect(task.conversationId).toBe('c-7');
    expect(task.owner).toBe('chat');
  });

  /** M56.5: a turn context carrying the conversation's pick. */
  const picked = (model: string | null, effort: string | null) => () => ({
    ...turnOf('sys'),
    model,
    effort,
  });

  it('sends the conversation’s model and effort (M56.5)', async () => {
    const { result } = renderHook(() => useAgentChat(picked('opus', 'high'), wideOpen));
    act(() => result.current.send('what is slipping?'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    expect(optionsOfLastRun()).toMatchObject({ model: 'opus', effort: 'high' });
  });

  it('sends Claude Code’s default when nothing picks one (M56.5)', async () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), wideOpen));
    act(() => result.current.send('what is slipping?'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    expect(optionsOfLastRun()).toMatchObject({ model: null, effort: null });
  });

  it('applies an addressed agent’s record when the conversation picks nothing (M56.5)', async () => {
    useVaultStore.setState({ entries: [agentEntry({ model: 'sonnet', effort: 'low' })] });
    const { result } = renderHook(() => useAgentChat(picked(null, null), wideOpen));
    act(() => result.current.send('@release-scout status?'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    expect(optionsOfLastRun()).toMatchObject({ model: 'sonnet', effort: 'low' });
  });

  it('lets the conversation’s pick beat the record, field by field (M56.5, Q11)', async () => {
    useVaultStore.setState({ entries: [agentEntry({ model: 'sonnet', effort: 'low' })] });
    const { result } = renderHook(() => useAgentChat(picked('opus', null), wideOpen));
    act(() => result.current.send('@release-scout status?'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    expect(optionsOfLastRun()).toMatchObject({ model: 'opus', effort: 'low' });
  });

  it('an unresolvable @name is text, and says so on the message it was typed in', async () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), wideOpen));
    act(() => result.current.send('@nobody-here are you there?'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());

    const options = optionsOfLastRun();
    // Nothing routed, and nothing was invented on the agent's behalf: the
    // message reaches the assistant exactly as typed.
    expect(options.actor).toBeNull();
    expect(options.scope).toBeNull();
    expect(options.message).toBe('@nobody-here are you there?');
    // But the person is not left guessing. Quiet, on the turn, not a toast.
    expect(result.current.messages[0].addressed).toEqual({
      handle: 'nobody-here',
      title: null,
    });
  });

  it('marks a routed turn with who it went to', async () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), wideOpen));
    act(() => result.current.send('@release-scout hi'));
    expect(result.current.messages[0].addressed).toEqual({
      handle: 'release-scout',
      title: 'Release scout',
    });
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
  });

  it('says nothing at all about a turn that named nobody', async () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), wideOpen));
    act(() => result.current.send('what is at risk?'));
    expect(result.current.messages[0].addressed).toBeUndefined();
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
  });
});

/**
 * The narrowing contract (M33b.6, task 5).
 *
 * Addressing an agent must never be a way to WIDEN a turn. A record is
 * vault-authored content — the same trust boundary as any `CLAUDE.md` — so it
 * may subtract from what Settings granted and can never add to it.
 *
 * Where each half is enforced, verified in the Rust rather than assumed:
 *
 * - `shell` is real and complete. `agent/mod.rs:626 build_args` builds argv
 *   from `tool_policy(req.shell)`, so a false here means Bash and the CLI's
 *   file tools are never in `--allowedTools` at all. The value asserted below
 *   is the whole boundary.
 * - `allowedTools` is enforced at argv the same way (`narrow()`, an
 *   intersection, mod.rs:586) AND, since M34.1.1, by the bearer grant:
 *   `run_agent` passes the request's tools into `run_token`, so
 *   `ungranted_tool_refusal` (mcp.rs) refuses what the intersection below
 *   withheld. The assertion here stays about what the ROUTING hands the run;
 *   the refusal end of it is the Rust side's to test, and it does.
 */
describe('useAgentChat cannot be widened by who it is addressed to', () => {
  const agentEntry = (properties: Record<string, unknown>) =>
    makeEntry({
      path: 'records/agents/scout.md',
      title: 'Release scout',
      type: 'Agent',
      properties: { slug: 'release-scout', ...properties } as never,
    });

  const shellOf = async (settings: ShellCeiling, declared: string) => {
    vi.mocked(agentIpc.runAgent).mockClear();
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [agentEntry({ tools: declared })],
    });
    const { result } = renderHook(() =>
      useAgentChat(turn('sys'), { shell: settings, connectors: false }),
    );
    act(() => result.current.send('@release-scout run it'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    return vi.mocked(agentIpc.runAgent).mock.calls[0][1].shell;
  };

  beforeEach(() => {
    handlers.length = 0;
    useUiStore.setState({ runs: [] });
  });

  it('refuses a record that declares MORE shell than Settings permits', async () => {
    // The case this test exists for. `tools: shell` under a Settings ceiling
    // of off gets off, exactly as it does on a schedule (useJobRunner), and
    // for the same reason: a record cannot grant itself what Settings
    // denies, and being spoken to does not change that.
    expect(await shellOf('off', 'shell')).toBe('off');
  });

  it('still narrows DOWN from a Settings grant the record does not want', async () => {
    // An addressed agent without `tools: shell` sends off, whatever the
    // ceiling (M57.2).
    expect(await shellOf('on', 'safe')).toBe('off');
    expect(await shellOf('ask', 'safe')).toBe('off');
  });

  it('passes the ceiling through when both agree', async () => {
    expect(await shellOf('on', 'shell')).toBe('on');
    expect(await shellOf('ask', 'shell')).toBe('ask');
  });

  it('leaves an unaddressed turn on the Settings ceiling', async () => {
    vi.mocked(agentIpc.runAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault', entries: [] });
    const { result } = renderHook(() =>
      useAgentChat(turn('sys'), { shell: 'on', connectors: false }),
    );
    act(() => result.current.send('plain question'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    expect(vi.mocked(agentIpc.runAgent).mock.calls[0][1].shell).toBe('on');
  });

  it('intersects the agent’s tool narrowing with the skill’s, never unions them', async () => {
    vi.mocked(agentIpc.runAgent).mockClear();
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [agentEntry({ 'allowed-tools': 'get_note, search_notes' })],
    });
    const { result } = renderHook(() =>
      useAgentChat(turn('sys'), { shell: 'off', connectors: false }),
    );
    // A skill invoked while addressing an agent: two vault files each drawing
    // a boundary, and the answer is the narrower of the two.
    act(() =>
      result.current.send('/audit @release-scout', 'AUDIT BODY', ['search_notes', 'create_note']),
    );
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    expect(vi.mocked(agentIpc.runAgent).mock.calls[0][1].allowedTools).toEqual(['search_notes']);
  });

  it('hands the run the connectors the record named, and no others', async () => {
    vi.mocked(agentIpc.runAgent).mockClear();
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [agentEntry({ connectors: 'atlassian' })],
    });
    const { result } = renderHook(() =>
      useAgentChat(turn('sys'), { shell: 'off', connectors: true }),
    );
    act(() => result.current.send('@release-scout fetch it'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    // M18.4's contract, unchanged: a name the vault has not enabled is dropped
    // in Rust rather than conjured, so this is a request to narrow, not a grant.
    expect(vi.mocked(agentIpc.runAgent).mock.calls[0][1].connectorNames).toEqual(['atlassian']);
  });

  it('hands the run the connector tools the record denies (M54.9)', async () => {
    vi.mocked(agentIpc.runAgent).mockClear();
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [
        agentEntry({
          connectors: ['gmail'],
          'disallowed-tools': ['mcp__gmail__trash_thread', 'mcp__gmail__send_message'],
        }),
      ],
    });
    const { result } = renderHook(() =>
      useAgentChat(turn('sys'), { shell: 'off', connectors: true }),
    );
    act(() => result.current.send('@release-scout tidy my inbox'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    // A subtraction Rust applies to the run's argv: what it names, the run
    // never calls, whatever the person's own allow rules say.
    expect(vi.mocked(agentIpc.runAgent).mock.calls[0][1].disallowedTools).toEqual([
      'mcp__gmail__trash_thread',
      'mcp__gmail__send_message',
    ]);
  });

  it('denies nothing on a turn nobody is addressed in', async () => {
    vi.mocked(agentIpc.runAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault', entries: [] });
    const { result } = renderHook(() =>
      useAgentChat(turn('sys'), { shell: 'off', connectors: true }),
    );
    act(() => result.current.send('plain question'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    expect(vi.mocked(agentIpc.runAgent).mock.calls[0][1].disallowedTools).toBeNull();
  });

  it('hands the run the read scope the record declared (M34.4)', async () => {
    vi.mocked(agentIpc.runAgent).mockClear();
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [agentEntry({ 'read-scope': ['sources/'] })],
    });
    const { result } = renderHook(() =>
      useAgentChat(turn('sys'), { shell: 'off', connectors: false }),
    );
    act(() => result.current.send('@release-scout what is stale'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    // The read axis rides the same bearer the write scope does — an addressed
    // agent reads what its record says it reads, not what the panel can.
    expect(vi.mocked(agentIpc.runAgent).mock.calls[0][1].readScope).toEqual(['sources']);
  });
});

/**
 * M53.5 — an addressed turn carries its agent's standing instructions.
 *
 * build_args withdraws the CLI's Read, Glob and Grep from a read-scoped run,
 * and get_note holds the agent's own record to its read limit like any other
 * note, so a turn told to read its own instructions could lose them. The app
 * reads the record instead, and its body closes the system prompt, where
 * useJobRunner (M34.1.4) and hand_to put it.
 */
describe('useAgentChat hands an addressed turn its standing instructions (M53.5)', () => {
  const agentEntry = (properties: Record<string, unknown>) =>
    makeEntry({
      path: 'records/agents/scout.md',
      title: 'Release scout',
      type: 'Agent',
      properties: { slug: 'release-scout', ...properties } as never,
    });
  const opts = { shell: 'off' as const, connectors: false };
  const BLOCK = `\n\nYour standing instructions, from records/agents/scout.md:\n\n${RECORD_BODY}`;

  /** Send one turn and hand back what the run was started with. */
  const sendAndRun = async (text: string) => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.send(text));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce());
    return vi.mocked(agentIpc.runAgent).mock.calls[0][1];
  };

  beforeEach(() => {
    handlers.length = 0;
    vi.mocked(agentIpc.runAgent).mockClear();
    useUiStore.setState({ runs: [] });
    useVaultStore.setState({ vaultPath: '/vault', entries: [agentEntry({})] });
  });

  it('closes the system prompt with the record’s body, and keeps it out of the message', async () => {
    const options = await sendAndRun('@release-scout what is slipping?');
    expect(vi.mocked(ipc.readNote)).toHaveBeenCalledWith('/vault', 'records/agents/scout.md');
    expect(options.systemPrompt).toBe(`sys${BLOCK}`);
    // Standing, not said: folded into the message, the charter would read
    // as something the person had just typed.
    expect(options.message).not.toContain('Keep a running brief');
  });

  it('keeps a read-scoped agent’s instructions when its record sits outside that scope', async () => {
    // The turn the read-it-yourself prompt lost: get_note refuses a record
    // outside `sources/`, and the CLI's Read is withdrawn from this run.
    useVaultStore.setState({ entries: [agentEntry({ 'read-scope': ['sources/'] })] });
    const options = await sendAndRun('@release-scout what is stale?');
    expect(options.readScope).toEqual(['sources']);
    expect(options.systemPrompt).toBe(`sys${BLOCK}`);
  });

  it.each([
    ['an unscoped agent', {}],
    ['a read-scoped agent', { 'read-scope': ['sources/'] }],
  ])('asks %s for no read of its own record', async (_label, properties) => {
    useVaultStore.setState({ entries: [agentEntry(properties)] });
    const { message } = await sendAndRun('@release-scout status?');
    expect(message).not.toMatch(/read it/);
    expect(message).not.toContain('get_note refuses');
    expect(message).not.toContain('standing instructions');
  });

  it('adds no block for a record with no body', async () => {
    // A heading over no instructions would tell the agent it has some.
    vi.mocked(ipc.readNote).mockResolvedValue('\n  \n');
    const options = await sendAndRun('@release-scout hello');
    expect(options.systemPrompt).toBe('sys');
  });

  it('reads nothing for a turn addressed to nobody', async () => {
    // The common case costs nothing, and an @name nothing answers to was
    // only ever text.
    for (const text of ['what is slipping?', '@nobody-here are you there?']) {
      vi.mocked(agentIpc.runAgent).mockClear();
      const options = await sendAndRun(text);
      expect(options.systemPrompt).toBe('sys');
    }
    expect(vi.mocked(ipc.readNote)).not.toHaveBeenCalled();
  });

  it('spawns nothing when the record cannot be read, and says why on the turn', async () => {
    // The Tauri wire rejects with a string, not an Error.
    vi.mocked(ipc.readNote).mockRejectedValue(
      'records/agents/scout.md: No such file or directory (os error 2)',
    );
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    // Every step after the send is a microtask, so one timer turn settles it.
    await act(async () => {
      result.current.send('@release-scout what is slipping?');
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(result.current.streaming).toBe(false);
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
    const { error } = result.current.messages[1];
    expect(error).toContain(
      "Could not read Release scout's instructions at records/agents/scout.md",
    );
    expect(error).toContain('No such file or directory');
    // No child, and nothing left in the registry the status bar reads.
    expect(useUiStore.getState().runs).toEqual([]);
  });

  it('stop() while the record is being read spawns nothing', async () => {
    let release: (body: string) => void = () => undefined;
    vi.mocked(ipc.readNote).mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.send('@release-scout what is slipping?'));
    await vi.waitFor(() => expect(vi.mocked(ipc.readNote)).toHaveBeenCalled());
    act(() => result.current.stop());
    await act(async () => {
      release(RECORD_BODY);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
    expect(result.current.messages[1].streaming).toBe(false);
  });

  it('a read that fails after stop() leaves the next turn alone', async () => {
    // The cancelled send must quit, not report: its failure reaching the
    // shared catch would end whichever turn is in flight by then.
    let fail: (reason: unknown) => void = () => undefined;
    vi.mocked(ipc.readNote).mockImplementationOnce(
      () =>
        new Promise<string>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.send('@release-scout what is slipping?'));
    await vi.waitFor(() => expect(vi.mocked(ipc.readNote)).toHaveBeenCalled());
    act(() => result.current.stop());
    act(() => result.current.send('next question'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce());

    await act(async () => {
      fail(new Error('gone'));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(result.current.messages[1].error).toBeUndefined();
    expect(result.current.streaming).toBe(true);
    expect(useUiStore.getState().runs).toHaveLength(1);
  });
});

/**
 * M54.7 — the turn's prompt is composed for what the turn holds. The skill's
 * narrowing and the recipient's meet first, and the composer hears the result,
 * so a narrowed turn is told only about tools it can call.
 */
// M56.6 — Settings binds the panel to an Agent record, which answers every
// turn that names nobody.
describe('useAgentChat answers as the agent the panel is bound to (M56.6)', () => {
  const SCOUT = makeEntry({
    path: 'records/agents/scout.md',
    title: 'Release scout',
    type: 'Agent',
    properties: {
      slug: 'release-scout',
      tools: 'shell',
      scope: ['records/risks'],
      'read-scope': ['records'],
      'allowed-tools': ['get_note', 'search_notes', 'append'],
      connectors: ['jira'],
      'disallowed-tools': ['mcp__jira__delete_issue'],
      model: 'sonnet',
      effort: 'high',
      preferences: 'HUMAN CORRECTION',
      recent: 'MY OWN NOTES',
    } as never,
  });
  const DIGEST = makeEntry({
    path: 'records/agents/digest.md',
    title: 'Digest',
    type: 'Agent',
    properties: { scope: ['records/digests'] } as never,
  });
  const boundTo = (handle: string | null) => (): TurnContext => ({
    ...turnOf('sys'),
    boundAgent: handle,
  });

  const optionsOfLastRun = () => {
    const calls = vi.mocked(agentIpc.runAgent).mock.calls;
    return calls[calls.length - 1][1];
  };

  beforeEach(() => {
    handlers.length = 0;
    vi.mocked(agentIpc.runAgent).mockClear();
    useUiStore.setState({ runs: [] });
    useVaultStore.setState({ vaultPath: '/vault', entries: [SCOUT, DIGEST] });
  });

  it('runs with the record’s identity and limits, and sends the message as typed', async () => {
    const { result } = renderHook(() =>
      useAgentChat(boundTo('release-scout'), { shell: 'on', connectors: true }),
    );
    act(() => result.current.send('what is slipping?'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());

    const options = optionsOfLastRun();
    expect(options.message).toBe('what is slipping?');
    expect(options.actor).toBe('process:release-scout');
    expect(options.scope).toEqual(['records/risks']);
    expect(options.readScope).toEqual(['records']);
    expect(options.allowedTools).toEqual(['get_note', 'search_notes', 'append']);
    expect(options.connectorNames).toEqual(['jira']);
    expect(options.disallowedTools).toEqual(['mcp__jira__delete_issue']);
    expect(options.shell).toBe('on');
    expect(options.model).toBe('sonnet');
    expect(options.effort).toBe('high');
    expect(options.attended).toBe(true);
    // The record's body is read through the app's own door, once.
    expect(vi.mocked(ipc.readNote)).toHaveBeenCalledWith('/vault', 'records/agents/scout.md');

    // Preferences first, instructions last, all in the system prompt.
    const sys = options.systemPrompt ?? '';
    expect(sys.startsWith('sys\n\n')).toBe(true);
    const prefs = sys.indexOf('HUMAN CORRECTION');
    const notes = sys.indexOf('MY OWN NOTES');
    const body = sys.indexOf('Your standing instructions, from records/agents/scout.md:');
    expect(prefs).toBeGreaterThan(0);
    expect(prefs).toBeLessThan(notes);
    expect(notes).toBeLessThan(body);
    expect(sys.endsWith(RECORD_BODY)).toBe(true);
    // A bound turn draws no per-bubble label: the header names who answers.
    expect(result.current.messages[0].addressed).toBeUndefined();
  });

  it('keeps the Settings shell ceiling over a record that declares shell', async () => {
    const { result } = renderHook(() =>
      useAgentChat(boundTo('release-scout'), { shell: 'off', connectors: false }),
    );
    act(() => result.current.send('run it'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    expect(optionsOfLastRun().shell).toBe('off');
  });

  it('lets @other win over the binding', async () => {
    const { result } = renderHook(() =>
      useAgentChat(boundTo('release-scout'), { shell: 'off', connectors: false }),
    );
    act(() => result.current.send('@digest what went out?'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    const options = optionsOfLastRun();
    expect(options.actor).toBe('process:digest');
    expect(options.scope).toEqual(['records/digests']);
    expect(options.systemPrompt).not.toContain('HUMAN CORRECTION');
    expect(result.current.messages[0].addressed).toEqual({ handle: 'digest', title: 'Digest' });
  });

  it('gives an unresolved @x to the bound agent, and says so on the turn', async () => {
    const { result } = renderHook(() =>
      useAgentChat(boundTo('release-scout'), { shell: 'off', connectors: false }),
    );
    act(() => result.current.send('@nobody are you there?'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    const options = optionsOfLastRun();
    expect(options.actor).toBe('process:release-scout');
    expect(options.message).toBe('@nobody are you there?');
    expect(result.current.messages[0].addressed).toEqual({
      handle: 'nobody',
      title: null,
      answeredBy: 'Release scout',
    });
  });

  it('sends a binding no record answers to as the plain assistant', async () => {
    const { result } = renderHook(() =>
      useAgentChat(boundTo('old-scout'), { shell: 'on', connectors: false }),
    );
    act(() => result.current.send('hello'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    const options = optionsOfLastRun();
    expect(options.actor).toBeNull();
    expect(options.scope).toBeNull();
    expect(options.systemPrompt).toBe('sys');
    expect(options.message).toBe('hello');
    expect(vi.mocked(ipc.readNote)).not.toHaveBeenCalled();
  });

  it('shows the run gate’s refusal for a paused bound agent (Q14)', async () => {
    // Rust refuses a paused actor in run_agent (and the browser mirrors it);
    // the turn shows those words rather than falling back to the plain
    // assistant, a wider grant than the person chose.
    const paused =
      'process:release-scout is paused, so this run did not start. Resume it on the fleet — a paused agent that still ran would make the pause a lie.';
    vi.mocked(agentIpc.runAgent).mockRejectedValueOnce(new Error(paused));
    const { result } = renderHook(() =>
      useAgentChat(boundTo('release-scout'), { shell: 'off', connectors: false }),
    );
    await act(async () => {
      result.current.send('what is slipping?');
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(optionsOfLastRun().actor).toBe('process:release-scout');
    expect(result.current.messages[1].error).toBe(paused);
    expect(result.current.streaming).toBe(false);
  });

  it('spawns nothing when the bound record cannot be read, naming its path', async () => {
    vi.mocked(ipc.readNote).mockRejectedValue('No such file or directory (os error 2)');
    const { result } = renderHook(() =>
      useAgentChat(boundTo('release-scout'), { shell: 'off', connectors: false }),
    );
    await act(async () => {
      result.current.send('what is slipping?');
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
    expect(result.current.streaming).toBe(false);
    expect(result.current.messages[1].error).toContain(
      "Could not read Release scout's instructions at records/agents/scout.md",
    );
    expect(useUiStore.getState().runs).toEqual([]);
  });
});

describe('useAgentChat composes the prompt for the turn’s grant (M54.7)', () => {
  const agentEntry = (properties: Record<string, unknown>) =>
    makeEntry({
      path: 'records/agents/scout.md',
      title: 'Release scout',
      type: 'Agent',
      properties: { slug: 'release-scout', ...properties } as never,
    });

  /** Send one turn with Settings' shell `shell`, and hand back the grant the
   * composer heard and what the run was started with. */
  const sendAndCompose = async (
    text: string,
    options: { message?: string; allowedTools?: string[] | null; shell?: ShellCeiling } = {},
  ) => {
    const compose = vi.fn((_grant: PromptGrant) => 'sys');
    const { result } = renderHook(() =>
      useAgentChat(() => ({ systemPrompt: compose, place: null, conversationId: 'c-1' }), {
        shell: options.shell ?? 'on',
        connectors: false,
      }),
    );
    act(() => result.current.send(text, options.message, options.allowedTools));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce());
    expect(compose).toHaveBeenCalledOnce();
    return {
      grant: compose.mock.calls[0][0],
      options: vi.mocked(agentIpc.runAgent).mock.calls[0][1],
    };
  };

  beforeEach(() => {
    handlers.length = 0;
    vi.mocked(agentIpc.runAgent).mockClear();
    useUiStore.setState({ runs: [] });
    useVaultStore.setState({ vaultPath: '/vault', entries: [] });
  });

  it('composes a skill turn narrowed to nothing with no tools, for a person watching', async () => {
    const { grant, options } = await sendAndCompose('/tidy', {
      message: 'TIDY BODY',
      allowedTools: [],
    });
    expect([...grant.tools]).toEqual([]);
    expect(grant.attended).toBe(true);
    expect(options.allowedTools).toEqual([]);
    expect(options.systemPrompt).toBe('sys');
  });

  it('composes an unnarrowed turn with every tool and the Settings shell', async () => {
    const { grant } = await sendAndCompose('what is at risk?');
    expect(grant.tools.has('get_note')).toBe(true);
    expect(grant.tools.has('propose_organize')).toBe(true);
    expect(grant.shell).toBe(true);
  });

  it('sends the panel’s ceiling as it is, Ask included, and composes Ask as holding the shell', async () => {
    const { grant, options } = await sendAndCompose('what is at risk?', { shell: 'ask' });
    expect(options.shell).toBe('ask');
    // An attended Ask turn can change files, after a card.
    expect(grant.shell).toBe(true);
  });

  it('composes an Off turn without the shell', async () => {
    const { grant, options } = await sendAndCompose('what is at risk?', { shell: 'off' });
    expect(options.shell).toBe('off');
    expect(grant.shell).toBe(false);
  });

  it('composes an addressed turn with the agent’s narrowed tools', async () => {
    useVaultStore.setState({ entries: [agentEntry({ 'allowed-tools': ['search_notes'] })] });
    const { grant, options } = await sendAndCompose('@release-scout what is slipping?');
    expect([...grant.tools]).toEqual(['search_notes']);
    expect(options.allowedTools).toEqual(['search_notes']);
  });

  it('composes a read-scoped agent’s turn without the shell its read limit withdraws', async () => {
    useVaultStore.setState({
      entries: [
        agentEntry({
          tools: 'shell',
          'allowed-tools': ['search_notes', 'create_note'],
          scope: ['records/risks'],
          'read-scope': ['sources/'],
        }),
      ],
    });
    const { grant, options } = await sendAndCompose('@release-scout what is stale?');
    expect(grant.shell).toBe(false);
    // The table withdraws it (M53.5); the ceiling asked for is still passed
    // through.
    expect(options.shell).toBe('on');
    // And the message the turn leads with names no tool the grant lacks.
    const named = mentionedTools(options.message);
    expect(named).toEqual(['search_notes']);
    for (const tool of named) expect(grant.tools.has(tool), tool).toBe(true);
    expect(options.message).not.toContain('write_concept');
  });
});

/**
 * Restored ids and fresh ids never collide (M15). The counter used to reset
 * to 0 per page load while conversations.ts persisted `m-1`/`m-2`, so the
 * first send after a reload minted ids the restored transcript already used
 * and one reply was written into two bubbles.
 */
describe('useAgentChat message ids', () => {
  const opts = { shell: 'off' as const, connectors: false };

  beforeEach(() => {
    handlers.length = 0;
    vi.mocked(agentIpc.runAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault' });
    useUiStore.setState({ runs: [] });
  });

  it('mints ids that a restored transcript cannot already hold', () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
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

/**
 * The live half of the one reducer (M56.3): the hook keeps the side effects
 * and hands every content event to `transcript.ts`, so a watched turn ends
 * the way its rebuild from the session file reads.
 */
describe('useAgentChat reduces through the transcript reducer', () => {
  const opts = { shell: 'off' as const, connectors: false };
  const SESSION = '00000000-0000-4000-8000-000000000001';
  const emit = (event: Record<string, unknown>) =>
    act(() => handlers.forEach((h) => h({ run: 8, ...event })));

  beforeEach(() => {
    handlers.length = 0;
    vi.mocked(agentIpc.runAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault' });
    useUiStore.setState({ runs: [] });
  });

  const started = async () => {
    const hook = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => hook.result.current.send('question'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    await vi.waitFor(() => expect(handlers.length).toBeGreaterThan(0));
    return hook;
  };

  const minting = () =>
    vi.mocked(agentIpc.runAgent).mockResolvedValueOnce({
      run: 8,
      durableId: 'durable-chat-8',
      sessionId: SESSION,
    });

  it('stores a minted session once the stream names it, not before', async () => {
    minting();
    const { result } = await started();
    // Claude Code writes the session file after its init: until then the
    // thread has no session to resume.
    expect(result.current.sessionId).toBeNull();
    expect(result.current.messages[1].streaming).toBe(true);
    emit({ kind: 'Init', session_id: SESSION });
    expect(result.current.sessionId).toBe(SESSION);
    emit({ kind: 'Done' });
    act(() => result.current.send('again'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(agentIpc.runAgent).mock.calls[1][1].sessionId).toBe(SESSION);
  });

  it('mints afresh after a turn stopped before its stream named the session', async () => {
    minting();
    const { result } = await started();
    act(() => result.current.stop());
    emit({ kind: 'Cancelled' });
    emit({ kind: 'Done' });
    expect(result.current.sessionId).toBeNull();
    act(() => result.current.send('again'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(agentIpc.runAgent).mock.calls[1][1].sessionId).toBeNull();
  });

  it('mints afresh after a run that died before its init', async () => {
    minting();
    const { result } = await started();
    emit({ kind: 'Error', message: 'boom' });
    emit({ kind: 'Done' });
    act(() => result.current.send('again'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(agentIpc.runAgent).mock.calls[1][1].sessionId).toBeNull();
  });

  it('names the turn’s model from ModelChanged', async () => {
    const { result } = await started();
    emit({ kind: 'ModelChanged', model: 'claude-haiku-4-5-20251001' });
    expect(result.current.model).toBe('claude-haiku-4-5-20251001');
    expect(result.current.messages[1].model).toBe('claude-haiku-4-5-20251001');
  });

  it('sets the final text through the reducer on Text then TurnEnded', async () => {
    const { result } = await started();
    emit({ kind: 'TextDelta', text: 'Reading. ' });
    emit({ kind: 'Text', message_id: 'm1', text: 'Reading.' });
    emit({ kind: 'TextDelta', text: 'done' });
    emit({ kind: 'Text', message_id: 'm2', text: 'done' });
    expect(result.current.messages[1].text).toBe('Reading. done');
    emit({ kind: 'TurnEnded', stop_reason: 'end_turn' });
    emit({ kind: 'Done' });
    expect(result.current.messages[1]).toMatchObject({ text: 'done', streaming: false });
    expect(result.current.messages[1].interrupted).toBeUndefined();
    expect(result.current.turnEndedAt).not.toBeNull();
  });

  it('marks a turn interrupted when Done comes without TurnEnded', async () => {
    const { result } = await started();
    emit({ kind: 'TextDelta', text: 'Half' });
    emit({ kind: 'Done' });
    expect(result.current.messages[1]).toMatchObject({
      text: 'Half',
      streaming: false,
      interrupted: true,
    });
  });

  it('marks the stopped reply cancelled when its run says so, and keeps its text', async () => {
    const { result } = await started();
    emit({ kind: 'TextDelta', text: 'Half' });
    act(() => result.current.stop());
    expect(result.current.messages[1]).toMatchObject({ streaming: true });
    emit({ kind: 'Cancelled' });
    emit({ kind: 'Done' });
    expect(result.current.messages[1]).toMatchObject({
      text: 'Half',
      streaming: false,
      interrupted: true,
      cancelled: true,
    });
  });

  it('collects the session’s pull requests once each, and restore sets or clears them', async () => {
    const { result } = await started();
    const link = {
      number: 7,
      url: 'https://github.com/example/notes/pull/7',
      repository: 'example/notes',
    };
    emit({ kind: 'PrLink', ...link });
    emit({ kind: 'PrLink', ...link });
    expect(result.current.prLinks).toEqual([link]);
    act(() => result.current.restore([], SESSION, { model: 'm', prLinks: [] }));
    expect(result.current).toMatchObject({ model: 'm', prLinks: [], sessionId: SESSION });
    act(() => result.current.restore([], null));
    expect(result.current.model).toBeNull();
  });
});

/**
 * A turn that waits on the person (M57.1): the card the run's own gate
 * raised, the answer that resumes it in the same bubble, and what Stop, a
 * late click, a failure, a restore and closing the panel do to it.
 */
describe('useAgentChat waits on a card (M57.1)', () => {
  const opts = { shell: 'off' as const, connectors: false };
  const card = {
    id: 'c'.repeat(32),
    kind: 'permission',
    tool_name: 'mcp__cerebro__append_to_note',
    tool_id: 't-1',
    session_id: 'session-1',
    summary: 'Append to a note · notes/inbox.md',
    input: '{}',
    asked_at: '2026-10-14T12:00:00.000Z',
  };

  beforeEach(() => {
    handlers.length = 0;
    vi.mocked(agentIpc.runAgent).mockClear();
    vi.mocked(agentIpc.stopAgent).mockClear();
    vi.mocked(agentIpc.answerInteraction).mockClear();
    vi.mocked(agentIpc.cancelInteraction).mockClear();
    vi.mocked(agentIpc.listInteractions).mockReset();
    vi.mocked(agentIpc.listInteractions).mockResolvedValue([]);
    useVaultStore.setState({ vaultPath: '/vault' });
    useUiStore.setState({ runs: [], toasts: [] });
  });

  const emit = (event: Record<string, unknown>) =>
    act(() => [...handlers].forEach((h) => h(event)));

  /** A turn whose run asked and stopped: the card, its deferral, Done. */
  async function held(shown: PendingInteraction = card) {
    const hook = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => hook.result.current.send('append it'));
    await vi.waitFor(() => expect(handlers.length).toBeGreaterThan(0));
    emit({
      run: 8,
      kind: 'ToolStart',
      tool_name: shown.tool_name,
      tool_id: 't-1',
      input: '{"path":"notes/inbox.md"}',
    });
    emit({ run: 8, kind: 'Interaction', interaction: shown });
    emit({ run: 8, kind: 'ToolDeferred', tool_id: 't-1', tool_name: shown.tool_name });
    emit({ run: 8, kind: 'Done' });
    return hook;
  }

  it('keeps the turn in flight past its run’s Done, waiting', async () => {
    const { result } = await held();
    expect(result.current.waiting).toBe(true);
    expect(result.current.interaction?.card).toEqual(card);
    expect(result.current.streaming).toBe(true);
    const bubble = result.current.messages[1];
    expect(bubble.streaming).toBe(false);
    expect(bubble.interrupted).toBeUndefined();
    expect(bubble.tools[0]).toMatchObject({ id: 't-1', deferred: true, done: false });
    expect(result.current.interaction?.messageId).toBe(bubble.id);
    // The run is over, and so is its subscription; a send is still refused.
    expect(handlers).toHaveLength(0);
    act(() => result.current.send('another'));
    expect(result.current.messages).toHaveLength(2);
  });

  it('attaches the resume to the same bubble and task', async () => {
    const { result } = await held();
    const bubble = result.current.messages[1].id;
    act(() => result.current.answer({ kind: 'allow' }));
    await vi.waitFor(() => expect(handlers.length).toBeGreaterThan(0));
    expect(vi.mocked(agentIpc.answerInteraction)).toHaveBeenCalledWith('/vault', card.id, {
      kind: 'allow',
    });
    expect(result.current.interaction).toBeNull();
    expect(useUiStore.getState().runs[0]?.run).toBe(9);
    emit({ run: 9, kind: 'ToolDone', tool_id: 't-1', output: 'Appended to notes/inbox.md' });
    emit({ run: 9, kind: 'TextDelta', text: 'Done.' });
    emit({ run: 9, kind: 'TurnEnded', stop_reason: 'end_turn' });
    emit({ run: 9, kind: 'Done' });
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1].id).toBe(bubble);
    expect(result.current.messages[1].tools[0]).toMatchObject({ done: true });
    expect(result.current.messages[1].text).toBe('Done.');
    expect(result.current.streaming).toBe(false);
    // M57.6: the resume's record is ChatTurnsHost's to end at its Done.
    expect(useUiStore.getState().runs).toEqual([
      expect.objectContaining({ run: 9, attach: 'durable-chat-9' }),
    ]);
    expect(result.current.live).toBeNull();
  });

  it('cancels the card on Stop, and the row reads cancelled', async () => {
    const { result } = await held();
    act(() => result.current.stop());
    expect(vi.mocked(agentIpc.cancelInteraction)).toHaveBeenCalledWith(card.id);
    expect(result.current.interaction).toBeNull();
    expect(result.current.streaming).toBe(false);
    expect(result.current.messages[1].tools[0].cancelled).toBe(true);
    expect(result.current.messages[1].interrupted).toBeUndefined();
    // M57.5: a card has no child, so Stop ends at once, and the reply reads
    // cancelled.
    expect(vi.mocked(agentIpc.stopAgent)).not.toHaveBeenCalled();
    expect(result.current.messages[1].cancelled).toBe(true);
    expect(result.current.stopping).toBe(false);
    // And the next send goes.
    act(() => result.current.send('next'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(2));
  });

  it('leaves the card waiting on New conversation (M57.6)', async () => {
    const { result } = await held();
    act(() => result.current.reset());
    expect(vi.mocked(agentIpc.cancelInteraction)).not.toHaveBeenCalled();
    expect(vi.mocked(agentIpc.stopAgent)).not.toHaveBeenCalled();
    expect(result.current.interaction).toBeNull();
  });

  it('shows a late answer’s line, with no toast', async () => {
    vi.mocked(agentIpc.answerInteraction).mockResolvedValueOnce({
      refused: {
        code: 'no_longer_waiting',
        message: 'No longer waiting: this request was already answered or cancelled.',
      },
    });
    const { result } = await held();
    act(() => result.current.answer({ kind: 'deny' }));
    await vi.waitFor(() => expect(result.current.interaction?.stale).not.toBeNull());
    expect(result.current.interaction?.stale).toBe(
      'No longer waiting: this request was already answered or cancelled.',
    );
    expect(result.current.waiting).toBe(false);
    expect(result.current.streaming).toBe(false);
    expect(useUiStore.getState().toasts).toEqual([]);
  });

  it('keeps a write card whose edited draft Rust refused, saying why (M57.4b)', async () => {
    const message = 'This run is scoped to records/risks and cannot write to notes.';
    vi.mocked(agentIpc.answerInteraction).mockResolvedValueOnce({
      refused: { code: 'write_outside_scope', message },
    });
    const { result } = await held({ ...card, kind: 'write', family: 'confirmable' });
    const updatedInput = { folder: 'notes', slug: 's', body: '# S\n' };
    act(() => result.current.answer({ kind: 'allow', remember: 'once', updatedInput }));
    await vi.waitFor(() => expect(result.current.interaction?.refused).toBe(message));
    expect(vi.mocked(agentIpc.answerInteraction)).toHaveBeenLastCalledWith(
      expect.any(String),
      card.id,
      { kind: 'allow', remember: 'once', updatedInput },
    );
    expect(result.current.interaction?.stale).toBeNull();
    expect(result.current.interaction?.answering).toBe(false);
    expect(result.current.waiting).toBe(true);
    expect(useUiStore.getState().toasts).toEqual([]);
  });

  it('toasts any other failure and keeps the card to answer again', async () => {
    vi.mocked(agentIpc.answerInteraction).mockRejectedValueOnce(new Error('the CLI is gone'));
    const { result } = await held();
    act(() => result.current.answer({ kind: 'allow' }));
    await vi.waitFor(() => expect(useUiStore.getState().toasts.length).toBeGreaterThan(0));
    expect(JSON.stringify(useUiStore.getState().toasts)).toContain('the CLI is gone');
    expect(result.current.waiting).toBe(true);
    expect(result.current.interaction?.answering).toBe(false);
    act(() => result.current.answer({ kind: 'allow' }));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.answerInteraction)).toHaveBeenCalledTimes(2));
  });

  it('brings a pending card back on restore, and on mount', async () => {
    vi.mocked(agentIpc.listInteractions).mockResolvedValue([card]);
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    const restored = [
      { id: 'u-1', role: 'user' as const, text: 'append it', tools: [] },
      {
        id: 'a-1',
        role: 'assistant' as const,
        text: '',
        tools: [
          {
            id: 't-1',
            name: card.tool_name,
            input: '{}',
            output: null,
            done: false,
            failed: false,
          },
        ],
      },
    ];
    act(() => result.current.restore(restored, 'session-1'));
    await vi.waitFor(() => expect(result.current.waiting).toBe(true));
    expect(vi.mocked(agentIpc.listInteractions)).toHaveBeenCalledWith('/vault');
    expect(result.current.interaction?.messageId).toBe('a-1');
    expect(result.current.messages[1].tools[0].deferred).toBe(true);
    expect(result.current.streaming).toBe(true);
    // Another thread's card is not this one's.
    act(() => result.current.restore([], 'session-2'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.interaction).toBeNull();
    expect(vi.mocked(agentIpc.cancelInteraction)).not.toHaveBeenCalled();
  });

  it('leaves the card pending when the panel closes or the thread switches', async () => {
    const { result, unmount } = await held();
    act(() => result.current.restore([], 'session-other'));
    expect(vi.mocked(agentIpc.cancelInteraction)).not.toHaveBeenCalled();
    unmount();
    expect(vi.mocked(agentIpc.cancelInteraction)).not.toHaveBeenCalled();
    expect(vi.mocked(agentIpc.stopAgent)).not.toHaveBeenCalled();
  });

  it('marks a call a hook outside Cerebro held as paused, and ends the turn', async () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.send('append it'));
    await vi.waitFor(() => expect(handlers.length).toBeGreaterThan(0));
    emit({ run: 8, kind: 'ToolStart', tool_name: 'Bash', tool_id: 't-1', input: '{}' });
    emit({ run: 8, kind: 'ToolDeferred', tool_id: 't-1', tool_name: 'Bash' });
    emit({ run: 8, kind: 'Done' });
    await vi.waitFor(() => expect(result.current.streaming).toBe(false));
    expect(vi.mocked(agentIpc.listInteractions)).toHaveBeenCalled();
    expect(result.current.messages[1].tools[0]).toMatchObject({ deferred: true, paused: true });
    expect(result.current.messages[1].interrupted).toBeUndefined();
    expect(result.current.interaction).toBeNull();
  });
});

describe('useAgentChat sends the recipient’s ask-first (M57.4)', () => {
  const opts = { shell: 'off' as const, connectors: false };
  const scout = (askFirst: unknown) =>
    makeEntry({
      path: 'records/agents/scout.md',
      title: 'Release scout',
      type: 'Agent',
      properties: {
        slug: 'release-scout',
        scope: ['records/risks'],
        ...(askFirst === undefined ? {} : { 'ask-first': askFirst }),
      } as never,
    });
  const lastOptions = () => {
    const calls = vi.mocked(agentIpc.runAgent).mock.calls;
    return calls[calls.length - 1][1];
  };
  const sent = async (text: string, context: () => TurnContext = turn('sys')) => {
    const { result } = renderHook(() => useAgentChat(context, opts));
    act(() => result.current.send(text));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    return result;
  };

  beforeEach(() => {
    handlers.length = 0;
    vi.mocked(agentIpc.runAgent).mockClear();
    vi.mocked(agentIpc.answerInteraction).mockClear();
    useUiStore.setState({ runs: [] });
  });

  it('an addressed ask-first agent sends askFirst: true', async () => {
    useVaultStore.setState({ vaultPath: '/vault', entries: [scout(true)] });
    await sent('@release-scout create "Vendor delay" in records/risks');
    expect(lastOptions()).toMatchObject({ askFirst: true, actor: 'process:release-scout' });
  });

  it('an odd value fails closed, and a bound agent sends its own', async () => {
    useVaultStore.setState({ vaultPath: '/vault', entries: [scout('yes')] });
    await sent('@release-scout hello');
    expect(lastOptions().askFirst).toBe(true);
    vi.mocked(agentIpc.runAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault', entries: [scout(true)] });
    await sent('hello', () => ({ ...turnOf('sys'), boundAgent: 'release-scout' }));
    expect(lastOptions()).toMatchObject({ askFirst: true, actor: 'process:release-scout' });
  });

  it('the plain panel and an agent that writes without asking send false', async () => {
    useVaultStore.setState({ vaultPath: '/vault', entries: [scout(undefined)] });
    await sent('what is slipping?');
    expect(lastOptions().askFirst).toBe(false);
    vi.mocked(agentIpc.runAgent).mockClear();
    await sent('@release-scout hello');
    expect(lastOptions().askFirst).toBe(false);
  });

  it('the resume re-derives nothing: the answer names only its card', async () => {
    // Rust (and the mock) resume the run they froze, actor, scopes, tools
    // and ask-first included; a resume that re-read them from the panel
    // could drop the actor and run unscoped.
    useVaultStore.setState({ vaultPath: '/vault', entries: [scout(true)] });
    const result = await sent('@release-scout create "Vendor delay" in records/risks');
    const card = {
      id: 'w'.repeat(32),
      kind: 'write',
      tool_name: 'mcp__cerebro__create_note',
      tool_id: 't-1',
      session_id: 'session-1',
      summary: 'Create a note · records/risks',
      family: 'confirmable',
      title: 'Create a note',
      target: 'records/risks',
      actor: 'process:release-scout',
      input: '{}',
      asked_at: '2026-10-14T12:00:00.000Z',
    };
    act(() =>
      [...handlers].forEach((h) => {
        h({ run: 8, kind: 'Interaction', interaction: card });
        h({ run: 8, kind: 'ToolDeferred', tool_id: 't-1', tool_name: card.tool_name });
        h({ run: 8, kind: 'Done' });
      }),
    );
    expect(result.current.interaction?.card.kind).toBe('write');
    vi.mocked(agentIpc.runAgent).mockClear();
    act(() => result.current.answer({ kind: 'allow', remember: 'once' }));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.answerInteraction)).toHaveBeenCalled());
    expect(vi.mocked(agentIpc.answerInteraction)).toHaveBeenCalledWith('/vault', card.id, {
      kind: 'allow',
      remember: 'once',
    });
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
  });
});

/**
 * Stop waits for Done (M57.5). Ending the turn at the click left the child in
 * its 2 s grace while the next turn could resume the same session: two Claude
 * Code processes on one session file. The turn now stays, stopping, until its
 * run says Cancelled and Done.
 */
describe('useAgentChat stops, and sends a frozen turn (M57.5)', () => {
  const opts = { shell: 'off' as const, connectors: false };
  const emit = (event: Record<string, unknown>) =>
    act(() => [...handlers].forEach((h) => h({ run: 8, ...event })));

  beforeEach(() => {
    handlers.length = 0;
    vi.mocked(agentIpc.runAgent).mockReset();
    vi.mocked(agentIpc.runAgent).mockResolvedValue({ run: 8, durableId: 'durable-chat-8' });
    vi.mocked(agentIpc.stopAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault', entries: [] });
    useUiStore.setState({ runs: [], toasts: [] });
  });

  const started = async (getTurn = turn('sys')) => {
    const hook = renderHook(() => useAgentChat(getTurn, opts));
    act(() => hook.result.current.send('question'));
    await vi.waitFor(() => expect(handlers.length).toBeGreaterThan(0));
    return hook;
  };

  it('keeps the turn, stopping, until Done, and marks the reply cancelled', async () => {
    const { result } = await started();
    act(() => result.current.stop());
    expect(vi.mocked(agentIpc.stopAgent)).toHaveBeenCalledWith(8);
    expect(result.current.stopping).toBe(true);
    expect(result.current.streaming).toBe(true);
    expect(result.current.busy()).toBe(true);
    // A second Stop while one is on its way does nothing more.
    act(() => result.current.stop());
    expect(vi.mocked(agentIpc.stopAgent)).toHaveBeenCalledOnce();
    emit({ kind: 'Cancelled' });
    emit({ kind: 'Done' });
    expect(result.current.stopping).toBe(false);
    expect(result.current.streaming).toBe(false);
    expect(result.current.busy()).toBe(false);
    expect(result.current.messages[1].cancelled).toBe(true);
    expect(useUiStore.getState().runs).toEqual([]);
  });

  it('ends at once, cancelled, when stopped before the child exists', async () => {
    let spawn = (_: { run: number; durableId: string }) => {};
    vi.mocked(agentIpc.runAgent).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          spawn = resolve;
        }),
    );
    let release = (_: string) => {};
    const expansion = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.send('/skill', () => expansion));
    act(() => result.current.stop());
    expect(result.current.streaming).toBe(false);
    expect(result.current.stopping).toBe(false);
    expect(result.current.messages[1]).toMatchObject({ streaming: false, cancelled: true });
    await act(async () => {
      release('EXPANDED');
      await expansion;
    });
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
    spawn({ run: 8, durableId: 'unused' });
  });

  it('waits for the child a stop caught inside the spawn', async () => {
    let spawn = (_: { run: number; durableId: string }) => {};
    vi.mocked(agentIpc.runAgent).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          spawn = resolve;
        }),
    );
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.send('question'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    act(() => result.current.stop());
    expect(result.current.stopping).toBe(true);
    await act(async () => spawn({ run: 8, durableId: 'durable-chat-8' }));
    expect(vi.mocked(agentIpc.stopAgent)).toHaveBeenCalledWith(8);
    expect(result.current.busy()).toBe(true);
    emit({ kind: 'Cancelled' });
    emit({ kind: 'Done' });
    expect(result.current.busy()).toBe(false);
    expect(result.current.messages[1].cancelled).toBe(true);
  });

  it('is busy while a turn streams, and idle before and after', async () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    expect(result.current.busy()).toBe(false);
    act(() => result.current.send('question'));
    // True in the same tick the send started, before any render.
    expect(result.current.busy()).toBe(true);
    await vi.waitFor(() => expect(handlers.length).toBeGreaterThan(0));
    emit({ kind: 'TurnEnded', stop_reason: 'end_turn' });
    emit({ kind: 'Done' });
    expect(result.current.busy()).toBe(false);
  });

  it('sends a frozen turn as it was queued, not the context now', async () => {
    let now = 'context: Inbox';
    const { result } = renderHook(() => useAgentChat(() => turnOf(now), opts));
    const frozen = turnOf('context: Roadmap');
    now = 'context: Settings';
    act(() => result.current.send('queued earlier', undefined, null, frozen));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    expect(vi.mocked(agentIpc.runAgent).mock.calls[0][1].systemPrompt).toBe('context: Roadmap');
  });

  it('reads the shell ceiling in force when a queued turn starts', async () => {
    let shell: ShellCeiling = 'on';
    const { result, rerender } = renderHook(() =>
      useAgentChat(turn('sys'), { shell, connectors: false }),
    );
    const frozen = turnOf('queued with on');
    // Settings lowers the ceiling while the entry waits.
    shell = 'off';
    rerender();
    act(() => result.current.send('queued earlier', undefined, null, frozen));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    expect(vi.mocked(agentIpc.runAgent).mock.calls[0][1].shell).toBe('off');
  });

  it('marks the reply cancelled when the run list stopped it', async () => {
    const { result } = await started();
    emit({ kind: 'TextDelta', text: 'Partly' });
    emit({ kind: 'Cancelled' });
    emit({ kind: 'Done' });
    expect(result.current.messages[1]).toMatchObject({ text: 'Partly', cancelled: true });
    expect(result.current.streaming).toBe(false);
  });

  it('ends a turn whose Done never came after STOP_CONFIRM_MS, with one toast', async () => {
    const { result } = await started();
    vi.useFakeTimers();
    try {
      act(() => result.current.stop());
      act(() => vi.advanceTimersByTime(STOP_CONFIRM_MS - 1));
      expect(result.current.stopping).toBe(true);
      act(() => vi.advanceTimersByTime(1));
      expect(result.current.stopping).toBe(false);
      expect(result.current.streaming).toBe(false);
      expect(result.current.messages[1].cancelled).toBe(true);
      expect(useUiStore.getState().toasts).toHaveLength(1);
      // A Done that turns up after all changes nothing more.
      emit({ kind: 'Done' });
      expect(useUiStore.getState().toasts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * A turn outlives its panel (M57.6). Closing, switching threads and New
 * conversation detach; reopening re-attaches through the run's journal from
 * the cursor the reply carries, so each event lands once. The journal here
 * is the harness's (`journals`), numbered as Rust's reader numbers events.
 */
describe('useAgentChat detaches and re-attaches (M57.6)', () => {
  const opts = { shell: 'off' as const, connectors: false };
  const SESSION = '00000000-0000-4000-8000-0000000000aa';
  const storeRescan = useVaultStore.getState().rescan;
  const rescan = vi.fn(async () => undefined);

  beforeEach(() => {
    handlers.length = 0;
    journals.clear();
    unknownRuns.clear();
    vi.mocked(agentIpc.runAgent).mockClear();
    vi.mocked(agentIpc.stopAgent).mockClear();
    vi.mocked(agentIpc.answerInteraction).mockClear();
    vi.mocked(agentIpc.listInteractions).mockReset();
    vi.mocked(agentIpc.listInteractions).mockResolvedValue([]);
    vi.mocked(agentIpc.readCliTranscript).mockReset();
    vi.mocked(agentIpc.readCliTranscript).mockResolvedValue({
      state: 'unavailable',
      reason: 'not_recorded',
      retention_days: 30,
    });
    rescan.mockClear();
    vi.mocked(agentIpc.runAgent).mockReset();
    vi.mocked(agentIpc.runAgent).mockResolvedValue({
      run: 8,
      durableId: 'durable-chat-8',
      attach: 'durable-chat-8',
    });
    useVaultStore.setState({ vaultPath: '/vault', rescan });
    useUiStore.setState({ runs: [], toasts: [] });
  });

  afterEach(() => {
    cleanup();
    useVaultStore.setState({ rescan: storeRescan });
  });

  /** Number and hold one event of `run`, then hand it to whoever listens. */
  function journalEmit(run: number, event: Record<string, unknown>) {
    const journal = journals.get(run) ?? { events: [], first: 1, done: false };
    journals.set(run, journal);
    const tagged = { ...event, run, seq: journal.first + journal.events.length };
    journal.events.push(tagged);
    if (event.kind === 'Done') journal.done = true;
    act(() => [...handlers].forEach((h) => h(tagged)));
  }

  async function sent() {
    const hook = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => hook.result.current.send('question'));
    await vi.waitFor(() => expect(hook.result.current.live).not.toBeNull());
    return hook;
  }

  const thread = (reply: Partial<ChatMessage> = {}): ChatMessage[] => [
    { id: 'u-1', role: 'user', text: 'question', tools: [] },
    { id: 'a-1', role: 'assistant', text: '', tools: [], ...reply },
  ];
  const LIVE: LiveTurn = { run: 8, attach: 'durable-chat-8', assistantId: 'a-1' };

  it('a thread switch detaches, and switching back re-attaches with no duplicate text', async () => {
    const { result } = await sent();
    journalEmit(8, { kind: 'TextDelta', text: 'Hel' });
    journalEmit(8, { kind: 'TextDelta', text: 'lo' });
    const saved = result.current.messages;
    const live = result.current.live;
    expect(saved[1].seq).toBe(2);

    act(() => result.current.restore([], null));
    expect(vi.mocked(agentIpc.stopAgent)).not.toHaveBeenCalled();
    expect(handlers).toHaveLength(0);
    expect(result.current.streaming).toBe(false);
    expect(useUiStore.getState().runs).toHaveLength(1);
    // The run goes on while nobody watches.
    journalEmit(8, { kind: 'TextDelta', text: ' there' });

    act(() => result.current.restore(saved, null, undefined, live));
    await vi.waitFor(() => expect(result.current.messages[1].text).toBe('Hello there'));
    expect(result.current.streaming).toBe(true);
    expect(result.current.messages[1].streaming).toBe(true);
    journalEmit(8, { kind: 'TextDelta', text: '.' });
    journalEmit(8, { kind: 'Done' });
    expect(result.current.messages[1].text).toBe('Hello there.');
    expect(result.current.streaming).toBe(false);
    expect(result.current.live).toBeNull();
    expect(vi.mocked(agentIpc.stopAgent)).not.toHaveBeenCalled();
  });

  it('New conversation detaches and never stops the run', async () => {
    const { result } = await sent();
    act(() => result.current.reset());
    expect(vi.mocked(agentIpc.stopAgent)).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([]);
    expect(result.current.live).toBeNull();
    expect(handlers).toHaveLength(0);
    expect(useUiStore.getState().runs).toEqual([
      expect.objectContaining({ run: 8, attach: 'durable-chat-8' }),
    ]);
  });

  it('re-attach restores streaming and continues from reply.seq', async () => {
    journals.set(8, {
      events: [1, 2, 3].map((seq) => ({ run: 8, seq, kind: 'TextDelta', text: String(seq) })),
      first: 1,
      done: false,
    });
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.restore(thread({ text: '1', seq: 1 }), SESSION, undefined, LIVE));
    await vi.waitFor(() => expect(result.current.messages[1].text).toBe('123'));
    expect(result.current.streaming).toBe(true);
    expect(result.current.messages[1].seq).toBe(3);
    expect(result.current.live).toEqual(LIVE);
  });

  it('re-attaching to a live run with no record registers it', async () => {
    journals.set(8, { events: [], first: 1, done: false });
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.restore(thread(), SESSION, undefined, LIVE));
    await vi.waitFor(() => expect(useUiStore.getState().runs).toHaveLength(1));
    expect(useUiStore.getState().runs[0]).toMatchObject({
      owner: 'chat',
      label: 'question',
      run: 8,
      attach: 'durable-chat-8',
      conversationId: 'c-1',
    });
  });

  it('a Done replayed after the host settled it causes no side effect', async () => {
    journals.set(8, {
      events: [
        { run: 8, seq: 1, kind: 'TextDelta', text: 'all of it' },
        { run: 8, seq: 2, kind: 'TurnEnded' },
        { run: 8, seq: 3, kind: 'Done' },
      ],
      first: 1,
      done: true,
    });
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.restore(thread(), SESSION, undefined, LIVE));
    await vi.waitFor(() => expect(result.current.streaming).toBe(false));
    expect(result.current.messages[1].text).toBe('all of it');
    expect(result.current.live).toBeNull();
    expect(useUiStore.getState().runs).toEqual([]);
    expect(rescan).not.toHaveBeenCalled();
  });

  it('unknown rebuilds the last turn from the session file', async () => {
    unknownRuns.add(8);
    vi.mocked(agentIpc.readCliTranscript).mockResolvedValueOnce({
      state: 'read',
      lines: 3,
      unclassified: [],
      events: [
        { kind: 'UserPrompt', text: 'question' },
        { kind: 'Text', message_id: 'm-1', text: 'The whole answer.' },
        { kind: 'TurnEnded', stop_reason: 'end_turn' },
      ],
    });
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() =>
      result.current.restore(thread({ text: 'The who', seq: 4 }), SESSION, undefined, LIVE),
    );
    await vi.waitFor(() => expect(result.current.messages[1].text).toBe('The whole answer.'));
    expect(vi.mocked(agentIpc.readCliTranscript)).toHaveBeenCalledWith('/vault', SESSION, null);
    expect(result.current.messages[1].id).toBe('a-1');
    expect(result.current.messages[1].streaming).toBeUndefined();
    expect(result.current.streaming).toBe(false);
    expect(result.current.live).toBeNull();
  });

  it('unknown with no session file keeps the cached reply, interrupted', async () => {
    unknownRuns.add(8);
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.restore(thread({ text: 'The who' }), SESSION, undefined, LIVE));
    await vi.waitFor(() => expect(result.current.messages[1].interrupted).toBe(true));
    expect(result.current.messages[1].text).toBe('The who');
    expect(result.current.messages[1].streaming).toBe(false);
  });

  it('gap shows its line and rebuilds at Done', async () => {
    journals.set(8, {
      events: [{ run: 8, seq: 5, kind: 'TextDelta', text: ' lost' }],
      first: 5,
      done: false,
    });
    vi.mocked(agentIpc.readCliTranscript).mockResolvedValueOnce({
      state: 'read',
      lines: 2,
      unclassified: [],
      events: [
        { kind: 'UserPrompt', text: 'question' },
        { kind: 'Text', message_id: 'm-1', text: 'Every word, from the file.' },
      ],
    });
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.restore(thread({ text: 'Every', seq: 2 }), SESSION, undefined, LIVE));
    await vi.waitFor(() => expect(result.current.messages[1].gap).toBe(true));
    // Only Cancelled, Error, Changeset and Done change a gap reply; the
    // cursor moves.
    expect(result.current.messages[1].text).toBe('Every');
    expect(result.current.messages[1].seq).toBe(5);
    // M58.3: the session file never holds a Changeset, so it lands now and
    // outlives the rebuild.
    const changeset = { state: 'nothing', run_id: 'run-0008', shell_unrecorded: true } as const;
    journalEmit(8, { kind: 'Changeset', changeset });
    await vi.waitFor(() => expect(result.current.messages[1].changesets).toEqual([changeset]));
    journalEmit(8, { kind: 'Done' });
    await vi.waitFor(() =>
      expect(result.current.messages[1].text).toBe('Every word, from the file.'),
    );
    expect(result.current.messages[1].gap).toBeUndefined();
    expect(result.current.messages[1].changesets).toEqual([changeset]);
    expect(result.current.streaming).toBe(false);
  });

  it('a card left open across a close still waits on reopen, and Allow moves live to the resume', async () => {
    const card: PendingInteraction = {
      id: 'd'.repeat(32),
      kind: 'permission',
      tool_name: 'mcp__cerebro__append_to_note',
      tool_id: 't-1',
      session_id: 'session-1',
      summary: 'Append to a note',
      input: '{}',
      asked_at: '2026-10-14T12:00:00.000Z',
    };
    const first = await sent();
    journalEmit(8, { kind: 'ToolStart', tool_name: card.tool_name, tool_id: 't-1', input: '{}' });
    journalEmit(8, { kind: 'Interaction', interaction: card });
    journalEmit(8, { kind: 'ToolDeferred', tool_id: 't-1', tool_name: card.tool_name });
    journalEmit(8, { kind: 'Done' });
    expect(first.result.current.waiting).toBe(true);
    const saved = first.result.current.messages;
    const live = first.result.current.live;
    expect(live?.run).toBe(8);
    first.unmount();
    expect(vi.mocked(agentIpc.stopAgent)).not.toHaveBeenCalled();
    // The card still waits in Rust's book; the reply's cursor already covers
    // the run's Done, so the book is where reopening finds it.
    vi.mocked(agentIpc.listInteractions).mockResolvedValue([card]);

    const { result } = renderHook(() => useAgentChat(turn('sys'), opts));
    act(() => result.current.restore(saved, 'session-1', undefined, live));
    await vi.waitFor(() => expect(result.current.waiting).toBe(true));
    expect(result.current.interaction?.card).toEqual(card);
    act(() => result.current.answer({ kind: 'allow' }));
    await vi.waitFor(() => expect(result.current.live?.run).toBe(9));
    expect(result.current.live).toEqual({
      run: 9,
      attach: 'durable-chat-9',
      assistantId: saved[1].id,
    });
    expect(result.current.messages[1].seq).toBeUndefined();
    journalEmit(9, { kind: 'ToolDone', tool_id: 't-1', output: 'Appended' });
    journalEmit(9, { kind: 'TextDelta', text: 'Done.' });
    journalEmit(9, { kind: 'TurnEnded', stop_reason: 'end_turn' });
    journalEmit(9, { kind: 'Done' });
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1].text).toBe('Done.');
    expect(result.current.streaming).toBe(false);
  });
});
