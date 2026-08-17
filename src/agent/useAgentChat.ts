import { useCallback, useEffect, useRef, useState } from 'react';
import { onAgentEvent, runAgent, startMcp, stopAgent } from './agentIpc';
import { newRunId } from './runs';
import type { AgentEvent, ChatMessage, McpInfo } from './types';
import { narrowTools, readAddress } from '@/engine/agents';
import type { Place } from '@/engine/place';
import { addressedAgentPrompt } from '@/lib/prompts';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * Everything about a turn that comes from OUTSIDE this hook (M17.6, M17.7).
 *
 * Read once, synchronously, at the top of each send, and it has to be a getter
 * rather than values for two reasons. The panel builds the prompt from the
 * conversation's context chips, and the conversation list is built on top of
 * this hook — so none of this exists yet when the hook is called. And a send
 * parks on a skill expansion and the MCP handshake before it spawns, so
 * reading afterwards would describe the context the user drifted INTO.
 */
export interface TurnContext {
  systemPrompt: string;
  /** Where this turn is happening, for the run list. */
  place: Place | null;
  /** Which conversation, so the run list can open it. */
  conversationId: string | null;
}

/**
 * Message ids are unique per HOOK INSTANCE, not per sequence (M15).
 *
 * A module counter reset to 0 on every page load, while `conversations.ts`
 * persists every message WITH its id: after a reload the first send minted
 * `m-1`/`m-2`, ids the restored transcript already used, so `patchActive`
 * wrote one reply into two bubbles and React saw duplicate keys. The prefix
 * is drawn once per hook instance, so no id this instance mints can collide
 * with one from a previous load — or with one it minted before a reset.
 */
let hookInstances = 0;
function newIdPrefix(): string {
  hookInstances += 1;
  return `m${Date.now().toString(36)}${hookInstances.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export interface AgentChat {
  messages: ChatMessage[];
  streaming: boolean;
  /** `message` is what the agent runs when it differs from what the transcript
   * shows — a skill invocation displays as `/name` but sends the body (M13.1).
   * As a FUNCTION it is awaited inside the turn, so the transcript appends and
   * the busy flag rises synchronously on send — an async expansion must not
   * open a window where a second send can interleave. If it rejects, the turn
   * falls back to sending `text` as typed.
   *
   * `text` is also where a RECIPIENT comes from (M33b.6): `@agent-slug` in it
   * routes the turn to that agent. Read off the typed text rather than passed
   * as an argument, so every path that sends — the composer, a suggestion, a
   * retry, a handoff from elsewhere in the app — addresses the same way
   * without four call sites remembering to. */
  send(
    text: string,
    message?: string | (() => Promise<string>),
    /** Narrow THIS turn's tools — a skill's `allowed-tools:` (M17.8). Per
     * invocation rather than per conversation, because it belongs to the
     * thing being invoked, not to the thread it was invoked in. Intersected
     * with the addressed agent's own narrowing, if the turn named one. */
    allowedTools?: string[] | null,
  ): void;
  stop(): void;
  reset(): void;
  /** M9.5: the CLI session behind this transcript, so a conversation can be
   * resumed after a reload rather than starting over. */
  sessionId: string | null;
  /** Restore a persisted conversation into the hook. */
  restore(messages: ChatMessage[], sessionId: string | null): void;
}

/**
 * Drives one conversation with the local agent (M6).
 *
 * The transcript is assembled from a stream of small events, so the assistant
 * message is created up front and mutated in place as deltas arrive — that is
 * what makes the reply appear as it is written rather than in one jump at the
 * end.
 *
 * M17.3 deleted most of this hook's coordination machinery. `deadRuns`, the
 * preempt handoff, `streamReleased` and the `learningPath` event gate all
 * existed for one reason: the backend held ONE child, so a second run anywhere
 * in the app silently killed this one, and the only defence was to recognise
 * other runs' events and refuse them by hand. The backend now keys children by
 * run id, so a turn subscribes to ITS run and is structurally incapable of
 * seeing another's — including the terminal `Done` that used to freeze a
 * brand-new bubble the moment a question was asked.
 */
export function useAgentChat(
  /** This turn's context — see TurnContext for why it is a getter. */
  getTurn: () => TurnContext,
  { shell, connectors }: { shell: boolean; connectors: boolean },
  model: string | null,
  /** Fires after a turn that wrote files, with a one-line summary (M9.5). */
  onWroteFiles?: (summary: string) => void,
): AgentChat {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const toast = useUiStore((s) => s.toast);
  // M17.7: a turn REGISTERS itself rather than raising a shared flag. The
  // background runner still yields to an attended run as a courtesy — don't
  // start a distill while someone is waiting on an answer — but that is now
  // read off the registry rather than off a boolean anybody could set.
  const startRun = useUiStore((s) => s.startRun);
  const attachChild = useUiStore((s) => s.attachChild);
  const endRun = useUiStore((s) => s.endRun);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const idPrefix = useRef<string>('');
  if (idPrefix.current === '') idPrefix.current = newIdPrefix();
  const idSeq = useRef(0);
  const nextId = useCallback(() => {
    idSeq.current += 1;
    return `${idPrefix.current}-${idSeq.current}`;
  }, []);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  // The prompt that started the in-flight turn, so a write checkpoint can say
  // what the agent was asked to do rather than just that it wrote.
  const lastPrompt = useRef<string>('');
  const onWrote = useRef(onWroteFiles);
  onWrote.current = onWroteFiles;
  // This turn's run and its subscription. Both are per-turn: the run id is
  // what stopAgent needs, and the unsubscribe is what guarantees a finished
  // turn stops listening.
  const runRef = useRef<number | null>(null);
  // This turn's entry in the run registry, which exists from the moment Send
  // is pressed — before the child does.
  const taskRef = useRef<string | null>(null);
  const unsubscribe = useRef<(() => void) | null>(null);
  // One turn at a time PER CONVERSATION (PR #5 review). Not a global lock any
  // more — other conversations and the background runner have their own runs.
  const turnInFlight = useRef(false);
  // Cancellation for send()'s async leg (PR #5 review). stop/reset/restore
  // end the TURN synchronously, but the send that started it may still be
  // parked on a skill expansion or the MCP handshake — and on resume it would
  // spawn a child for a turn the user already cancelled. Bumping the epoch
  // makes that pending work quit at its next checkpoint instead.
  const sendEpoch = useRef(0);
  const mcpRef = useRef<McpInfo | null>(null);
  // The agent writes straight to disk; a turn that touched files must end
  // with a rescan or the UI keeps showing the pre-agent vault.
  const touchedFiles = useRef(false);

  const patchMessage = useCallback((id: string, update: (m: ChatMessage) => ChatMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? update(m) : m)));
  }, []);

  /** Drop this turn's subscription and clear its run. Idempotent. */
  const releaseRun = useCallback(() => {
    unsubscribe.current?.();
    unsubscribe.current = null;
    runRef.current = null;
  }, []);

  const endTurn = useCallback(() => {
    releaseRun();
    turnInFlight.current = false;
    setStreaming(false);
    if (taskRef.current !== null) {
      endRun(taskRef.current);
      taskRef.current = null;
    }
  }, [endRun, releaseRun]);

  /** Kill THIS conversation's run, if it has one. Fire-and-forget: callers
   * end the turn synchronously, and a run that already finished answers
   * false rather than erroring. */
  const killRun = useCallback(() => {
    const run = runRef.current;
    if (run === null) return;
    void stopAgent(run).catch(() => undefined);
  }, []);

  const handleEvent = useCallback(
    (assistantId: string, event: AgentEvent) => {
      switch (event.kind) {
        case 'Init':
          sessionRef.current = event.session_id;
          setSessionId(event.session_id);
          break;
        case 'TextDelta':
          patchMessage(assistantId, (m) => ({ ...m, text: m.text + event.text }));
          break;
        case 'ThinkingDelta':
          // Reasoning is not shown as prose — it would read as the answer.
          // Only its arrival matters, as a "working" signal.
          break;
        case 'ToolStart':
          if (isWriteTool(event.tool_name)) touchedFiles.current = true;
          patchMessage(assistantId, (m) => {
            // A tool_id is unique within a turn by definition, so a repeat is a
            // redelivery of the same call — never a second call. Appending it
            // blindly is what put `["t-1","t-1","t-2","t-2"]` in shipped
            // transcripts: duplicate React keys (AiPanel keys rows by tool.id),
            // and every tool row drawn twice (M15).
            const at = m.tools.findIndex((t) => t.id === event.tool_id);
            if (at === -1) {
              const started = {
                id: event.tool_id,
                name: event.tool_name,
                input: event.input ?? null,
                output: null,
                done: false,
                failed: false,
              };
              return { ...m, tools: [...m.tools, started] };
            }
            // A redelivery must not un-finish a tool (PR #7 review). ToolDone
            // may already have landed for this id, and rebuilding the row from
            // the start event alone would blank the result and set the row
            // spinning again — so only what the start event actually knows is
            // refreshed, and the completion the row already has is kept.
            const tools = m.tools.slice();
            tools[at] = {
              ...tools[at],
              name: event.tool_name,
              input: event.input ?? tools[at].input,
            };
            return { ...m, tools };
          });
          break;
        case 'ToolDone':
          patchMessage(assistantId, (m) => ({
            ...m,
            tools: m.tools.map((t) =>
              t.id === event.tool_id
                ? {
                    ...t,
                    done: true,
                    output: event.output ?? null,
                    failed: event.is_error === true,
                  }
                : t,
            ),
          }));
          break;
        case 'Result':
          if (event.session_id) {
            sessionRef.current = event.session_id;
            setSessionId(event.session_id);
          }
          // The final result is authoritative: streamed deltas can be partial
          // when a turn is interrupted, so prefer it when it has content.
          patchMessage(assistantId, (m) => ({
            ...m,
            text: event.text.trim() !== '' ? event.text : m.text,
          }));
          break;
        case 'Error':
          patchMessage(assistantId, (m) => ({ ...m, error: event.message }));
          break;
        case 'Done':
          patchMessage(assistantId, (m) => ({ ...m, streaming: false }));
          endTurn();
          if (touchedFiles.current) {
            touchedFiles.current = false;
            void rescan();
            // M9.5/M9.4: a turn that wrote files gets its own checkpoint, so
            // the assistant's work is revertible on its own rather than
            // tangled into the user's next one.
            onWrote.current?.(lastPrompt.current);
          }
          break;
      }
    },
    [endTurn, patchMessage, rescan],
  );

  const send = useCallback(
    (text: string, message?: string | (() => Promise<string>), allowedTools?: string[] | null) => {
      const trimmed = text.trim();
      if (trimmed === '' || vaultPath === null) return;
      // Callers gate on `streaming`; this closes the same-tick window where
      // that render state is still stale. Dropped, not queued — the caller
      // that hit it kept its draft, so nothing is lost.
      if (turnInFlight.current) return;
      turnInFlight.current = true;
      // Frozen here, before anything can await: this turn's context is the
      // context the question was asked in.
      const turn = getTurn();
      // M33b.6 — who this turn is addressed to, read from the text the person
      // actually composed. Off the store synchronously rather than through a
      // subscription: the recipient belongs to THIS message, and a chat hook
      // that re-rendered on every vault scan to keep an agent list current
      // would pay for that on every keystroke of every conversation.
      //
      // D8: this changes who the turn goes to and nothing else. No new
      // conversation, no per-agent thread list, and the anchor `anchorNow`
      // stamps is untouched — addressing someone is not going somewhere.
      const address = readAddress(trimmed, useVaultStore.getState().entries);
      const recipient = address?.agent ?? null;
      const assistantId = nextId();
      lastPrompt.current = trimmed;
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'user',
          text: trimmed,
          tools: [],
          // Carried on the message rather than raised as a toast. A mention
          // that routed and one that did not are both facts about this turn,
          // they belong next to the turn, and neither is an interruption —
          // see ChatMessage.addressed.
          ...(address === null
            ? {}
            : { addressed: { handle: address.handle, title: recipient?.title ?? null } }),
        },
        { id: assistantId, role: 'assistant', text: '', tools: [], streaming: true },
      ]);
      setStreaming(true);
      // The task exists from now, not from when the child does: a first send
      // spends a whole MCP handshake before it has a run id, and a task list
      // that showed nothing for that window would be reporting "idle" while
      // the user waits.
      const taskId = newRunId();
      taskRef.current = taskId;
      startRun({
        id: taskId,
        owner: 'chat',
        label: trimmed,
        place: turn.place,
        path: null,
        conversationId: turn.conversationId,
        run: null,
        startedAt: Date.now(),
      });

      const epoch = sendEpoch.current;
      void (async () => {
        // stop/reset/restore bumped the epoch while this send was parked on
        // an await: the turn is over, so quit without spawning a child. The
        // bubble was appended synchronously, so un-spin it here.
        const cancelled = () => {
          if (sendEpoch.current === epoch) return false;
          patchMessage(assistantId, (m) => ({ ...m, streaming: false }));
          return true;
        };
        try {
          const expanded =
            typeof message === 'function' ? await message().catch(() => trimmed) : message?.trim();
          const composed = expanded === undefined || expanded === '' ? trimmed : expanded;
          // The recipient's block LEADS, like useJobRunner's CURRENT STATE
          // block and for the same reason. An unresolved mention adds nothing
          // here: `@nobody` was only ever text, and inventing a preamble about
          // an agent that does not exist would be the app answering for it.
          const outgoing =
            recipient === null
              ? composed
              : `${addressedAgentPrompt(recipient.path, recipient.title, recipient.actor, recipient.memory, recipient.scope)}\n\n${composed}`;
          mcpRef.current ??= await startMcp(vaultPath);
          if (cancelled()) return;
          const { run } = await runAgent(vaultPath, {
            message: outgoing,
            systemPrompt: turn.systemPrompt,
            sessionId: sessionRef.current,
            model,
            // M33b.6 — the addressed agent's grant, and it can only ever
            // SUBTRACT. `shell` here is the Settings ceiling; a record that
            // declares `tools: shell` in a vault whose owner never switched
            // shell on still gets false, exactly as it does on a schedule
            // (useJobRunner). No record grants itself what Settings denies,
            // and addressing one must never become the way around that.
            shell: shell && (recipient?.shell ?? true),
            connectors,
            connectorNames: recipient?.connectors ?? null,
            // A person typed this turn and is watching it stream — the one
            // kind of run allowed to fall back to their global MCP config
            // when the vault has no connectors.json (PR #5 security review).
            attended: true,
            approvedStdio: useUiStore.getState().stdioApprovals[vaultPath] ?? [],
            // Two narrowings can meet on one turn — a skill's `allowed-tools:`
            // and the addressed agent's — so they intersect. Never union.
            allowedTools: narrowTools(allowedTools ?? null, recipient?.allowedTools ?? null),
            // M17.13: enforced in Rust against the bearer the child presents,
            // so an addressed agent cannot talk its way out of its folders.
            scope: recipient?.scope ?? null,
            // M13.4: attribution rides the bearer token, so what this turn
            // writes is stamped as the agent — and, free, the `runs` row it
            // books carries the actor the fleet reads.
            actor: recipient?.actor ?? null,
            mcp: mcpRef.current,
          });
          // Cancelled during the spawn itself: the child exists now, so it has
          // to be killed by id rather than abandoned.
          if (cancelled()) {
            void stopAgent(run).catch(() => undefined);
            endTurn();
            return;
          }
          // The subscription is scoped to THIS run, so no event from any other
          // conversation, background job or killed child can reach this turn.
          // The mock and the Rust reader both emit asynchronously, so the id
          // is always in hand before the first event.
          runRef.current = run;
          attachChild(taskId, run);
          unsubscribe.current = onAgentEvent((event) => handleEvent(assistantId, event), run);
        } catch (err) {
          const failure = err instanceof Error ? err.message : String(err);
          patchMessage(assistantId, (m) => ({ ...m, error: failure, streaming: false }));
          endTurn();
          toast(failure);
        }
      })();
    },
    [
      attachChild,
      connectors,
      endTurn,
      getTurn,
      handleEvent,
      model,
      nextId,
      patchMessage,
      shell,
      startRun,
      toast,
      vaultPath,
    ],
  );

  /**
   * Unmounting mid-turn ends the turn (M15).
   *
   * The panel is rendered conditionally, so closing the assistant while an
   * answer streams tears this hook down. Nothing here used to run on the way
   * out: the child kept going, and `agentBusy` stayed true for the rest of the
   * session — which made the background distiller's own guard bail forever.
   *
   * M17.2 removed the case that made this fire by accident: `open_note` no
   * longer closes the panel, so an unmount now means the user actually closed
   * the assistant. Written against the store directly rather than the bound
   * action, because this runs while React is unmounting the tree that owns it.
   */
  useEffect(() => {
    return () => {
      // Reaches a send still parked on a skill expansion or the MCP
      // handshake, which killRun cannot: it has no child to kill yet.
      sendEpoch.current += 1;
      if (!turnInFlight.current) return;
      killRun();
      releaseRun();
      turnInFlight.current = false;
      if (taskRef.current !== null) {
        useUiStore.getState().endRun(taskRef.current);
        taskRef.current = null;
      }
    };
  }, [killRun, releaseRun]);

  const stop = useCallback(() => {
    killRun();
    // The epoch bump is what reaches a send still parked on a skill expansion
    // — killRun can only kill a child that already exists.
    sendEpoch.current += 1;
    // Un-spin whatever is still streaming. Not just the run's bubble: a send
    // parked before its child exists has a spinning message and no run at all.
    setMessages((prev) => prev.map((m) => (m.streaming === true ? { ...m, streaming: false } : m)));
    endTurn();
  }, [endTurn, killRun]);

  const reset = useCallback(() => {
    killRun();
    sendEpoch.current += 1;
    sessionRef.current = null;
    setSessionId(null);
    endTurn();
    setMessages([]);
  }, [endTurn, killRun]);

  /** Load a stored conversation. Ends this conversation's turn first: the
   * events still in flight belong to the transcript being replaced. */
  const restore = useCallback(
    (restored: ChatMessage[], restoredSession: string | null) => {
      killRun();
      sendEpoch.current += 1;
      endTurn();
      sessionRef.current = restoredSession;
      setSessionId(restoredSession);
      setMessages(restored);
    },
    [endTurn, killRun],
  );

  return { messages, streaming, send, stop, reset, sessionId, restore };
}

/** Tools that change disk — the ones that make a rescan necessary. */
export function isWriteTool(name: string): boolean {
  return /create_note|update_frontmatter|append_to_note|write_concept|cache_source|^Write$|^Edit$/.test(
    name,
  );
}
