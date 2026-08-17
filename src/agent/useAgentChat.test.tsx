import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const handlers: Array<(event: unknown) => void> = [];
vi.mock('./agentIpc', () => ({
  // M33.7: the pair, not the bare tag. The chat path uses only `run`.
  runAgent: vi.fn(async () => ({ run: 8, durableId: 'durable-chat-8' })),
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
import { useAgentChat, type TurnContext } from './useAgentChat';
import { makeEntry } from '@/engine/testHelpers';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

afterEach(cleanup);

/** A turn's context (M17.6/M17.7). Most tests care only about the prompt. */
const turnOf = (systemPrompt: string): TurnContext => ({
  systemPrompt,
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
  const opts = { shell: false, connectors: false };

  beforeEach(() => {
    vi.mocked(agentIpc.runAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault' });
  });

  it('freezes the context the question was asked in (M17.6)', async () => {
    // The prompt is a getter because the panel rebuilds it from context chips,
    // the vault, and the open record — all of which move while a send is
    // parked on a skill expansion and the MCP handshake. Reading it after
    // those awaits would send the context the user drifted INTO, which is the
    // whole complaint: "it confuses the AI".
    let context = 'context: Roadmap';
    let release = (_: string) => {};
    const expansion = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { result } = renderHook(() => useAgentChat(() => turnOf(context), opts, null));

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
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts, null));
    act(() => result.current.send('what is at risk?', undefined));

    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    const [, options] = vi.mocked(agentIpc.runAgent).mock.calls[0];
    expect(options.message).not.toContain('CURRENT STATE');
    expect(options.systemPrompt).not.toContain('CURRENT STATE');
  });

  it('shows the typed text but runs the expanded message', async () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts, null));
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
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts, null));
    act(() => result.current.send('/gone', () => Promise.reject(new Error('unreadable'))));
    await vi.waitFor(() =>
      expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledWith(
        '/vault',
        expect.objectContaining({ message: '/gone' }),
      ),
    );
  });

  it('appends the turn synchronously — a pending expansion leaves no window to interleave', () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts, null));
    act(() => result.current.send('/slow', () => new Promise<string>(() => undefined)));
    // Both bubbles exist and streaming is up before the expansion resolves,
    // so a second send sees a busy conversation rather than an idle one.
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.streaming).toBe(true);
  });

  it('still accepts a plain pre-expanded string', async () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts, null));
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
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts, null));
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
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts, null));
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
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts, null));
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
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts, null));
    act(() => result.current.send('question'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    expect(vi.mocked(agentIpc.stopAgent)).not.toHaveBeenCalled();
  });

  it('never sees another run’s events, including its terminal Done', async () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts, null));
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
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts, null));
    act(() => result.current.send('question'));
    await vi.waitFor(() => expect(handlers.length).toBeGreaterThan(0));

    act(() => result.current.stop());
    expect(vi.mocked(agentIpc.stopAgent)).toHaveBeenCalledWith(8);
    expect(result.current.streaming).toBe(false);
  });

  it('unsubscribes when the turn ends, so a later run cannot reach it', async () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts, null));
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
    useUiStore.setState({ runs: [] });
  });

  it('drops a send fired while a turn is in flight', async () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts, null));
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
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts, null));
    act(() => result.current.send('doomed'));
    await vi.waitFor(() => expect(result.current.streaming).toBe(false));
    act(() => result.current.send('retry'));
    expect(result.current.messages).toHaveLength(4);
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledTimes(2));
  });

  it('stop() releases the guard for the next send', async () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts, null));
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
    useUiStore.setState({ runs: [] });
  });

  it('stops the run and takes it out of the registry', async () => {
    const { result, unmount } = renderHook(() => useAgentChat(turn('sys'), opts, null));
    act(() => result.current.send('question'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    // M17.7: a task exists from the moment Send is pressed, and carries the
    // question as its label — a run list saying "Assistant working" and
    // nothing else was the thing that could not answer "working on what?".
    const task = useUiStore.getState().runs[0];
    expect(task.owner).toBe('chat');
    expect(task.label).toBe('question');
    expect(task.run).toBe(8);

    unmount();
    expect(vi.mocked(agentIpc.stopAgent)).toHaveBeenCalled();
    // The registry is what the status bar reads. A run left in it after its
    // child died is a spinner that never stops — which is exactly what the
    // old `agentBusy` did when the panel was closed mid-turn (M15).
    expect(useUiStore.getState().runs).toEqual([]);
  });

  it('leaves an idle agent alone', () => {
    const { unmount } = renderHook(() => useAgentChat(turn('sys'), opts, null));
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
    useUiStore.setState({ runs: [] });
  });

  it('keeps a finished tool finished', async () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts, null));
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
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts, null));
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
  const wideOpen = { shell: true, connectors: true };

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
    const { result } = renderHook(() => useAgentChat(turn('sys'), wideOpen, null));
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
    const { result } = renderHook(() => useAgentChat(turn('sys'), wideOpen, null));
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
      useAgentChat(() => ({ systemPrompt: 'sys', place, conversationId: 'c-7' }), wideOpen, null),
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

  it('an unresolvable @name is text, and says so on the message it was typed in', async () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), wideOpen, null));
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
    const { result } = renderHook(() => useAgentChat(turn('sys'), wideOpen, null));
    act(() => result.current.send('@release-scout hi'));
    expect(result.current.messages[0].addressed).toEqual({
      handle: 'release-scout',
      title: 'Release scout',
    });
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
  });

  it('says nothing at all about a turn that named nobody', async () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), wideOpen, null));
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
 *   intersection, mod.rs:586) — but NOT yet by the bearer grant:
 *   `lib.rs:1024-1029` passes `None` for the token's tools on every run started
 *   through `run_agent`, so `ungranted_tool_refusal` (mcp.rs:1278) refuses
 *   nothing for it. That is M34.1.1's fix, not this phase's, and it is why the
 *   assertion below is about what the ROUTING hands the run rather than about
 *   a tool call being refused end to end.
 */
describe('useAgentChat cannot be widened by who it is addressed to', () => {
  const agentEntry = (properties: Record<string, unknown>) =>
    makeEntry({
      path: 'records/agents/scout.md',
      title: 'Release scout',
      type: 'Agent',
      properties: { slug: 'release-scout', ...properties } as never,
    });

  const shellOf = async (settings: boolean, declared: string) => {
    vi.mocked(agentIpc.runAgent).mockClear();
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [agentEntry({ tools: declared })],
    });
    const { result } = renderHook(() =>
      useAgentChat(turn('sys'), { shell: settings, connectors: false }, null),
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
    // The case this test exists for. `tools: shell` in a vault whose owner
    // never switched shell access on gets nothing — exactly as it does on a
    // schedule (useJobRunner), and for the same reason: a record cannot grant
    // itself what Settings denies, and being spoken to does not change that.
    expect(await shellOf(false, 'shell')).toBe(false);
  });

  it('still narrows DOWN from a Settings grant the record does not want', async () => {
    expect(await shellOf(true, 'safe')).toBe(false);
  });

  it('passes the ceiling through when both agree', async () => {
    expect(await shellOf(true, 'shell')).toBe(true);
  });

  it('leaves an unaddressed turn on the Settings ceiling', async () => {
    vi.mocked(agentIpc.runAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault', entries: [] });
    const { result } = renderHook(() =>
      useAgentChat(turn('sys'), { shell: true, connectors: false }, null),
    );
    act(() => result.current.send('plain question'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    expect(vi.mocked(agentIpc.runAgent).mock.calls[0][1].shell).toBe(true);
  });

  it('intersects the agent’s tool narrowing with the skill’s, never unions them', async () => {
    vi.mocked(agentIpc.runAgent).mockClear();
    useVaultStore.setState({
      vaultPath: '/vault',
      entries: [agentEntry({ 'allowed-tools': 'get_note, search_notes' })],
    });
    const { result } = renderHook(() =>
      useAgentChat(turn('sys'), { shell: false, connectors: false }, null),
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
      useAgentChat(turn('sys'), { shell: false, connectors: true }, null),
    );
    act(() => result.current.send('@release-scout fetch it'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    // M18.4's contract, unchanged: a name the vault has not enabled is dropped
    // in Rust rather than conjured, so this is a request to narrow, not a grant.
    expect(vi.mocked(agentIpc.runAgent).mock.calls[0][1].connectorNames).toEqual(['atlassian']);
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
    useUiStore.setState({ runs: [] });
  });

  it('mints ids that a restored transcript cannot already hold', () => {
    const { result } = renderHook(() => useAgentChat(turn('sys'), opts, null));
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
