import { useCallback, useEffect, useRef, useState } from 'react';
import { onAgentEvent, runAgent, startMcp, stopAgent } from './agentIpc';
import type { AgentEvent, ChatMessage, McpInfo } from './types';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

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
   * falls back to sending `text` as typed. */
  send(text: string, message?: string | (() => Promise<string>)): void;
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
  systemPrompt: string,
  { shell, connectors }: { shell: boolean; connectors: boolean },
  model: string | null,
  /** Fires after a turn that wrote files, with a one-line summary (M9.5). */
  onWroteFiles?: (summary: string) => void,
): AgentChat {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const toast = useUiStore((s) => s.toast);
  // Still raised while a typed turn is in flight, but no longer a lock: the
  // background runner yields to it as a courtesy (don't start a distill while
  // someone is waiting on an answer), not because the two would collide.
  const setAgentBusy = useUiStore((s) => s.setAgentBusy);
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
    setAgentBusy(false);
  }, [releaseRun, setAgentBusy]);

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
    (text: string, message?: string | (() => Promise<string>)) => {
      const trimmed = text.trim();
      if (trimmed === '' || vaultPath === null) return;
      // Callers gate on `streaming`; this closes the same-tick window where
      // that render state is still stale. Dropped, not queued — the caller
      // that hit it kept its draft, so nothing is lost.
      if (turnInFlight.current) return;
      turnInFlight.current = true;
      const assistantId = nextId();
      lastPrompt.current = trimmed;
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'user', text: trimmed, tools: [] },
        { id: assistantId, role: 'assistant', text: '', tools: [], streaming: true },
      ]);
      setStreaming(true);
      setAgentBusy(true);

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
          const outgoing = expanded === undefined || expanded === '' ? trimmed : expanded;
          mcpRef.current ??= await startMcp(vaultPath);
          if (cancelled()) return;
          const run = await runAgent(vaultPath, {
            message: outgoing,
            systemPrompt,
            sessionId: sessionRef.current,
            model,
            shell,
            connectors,
            // A person typed this turn and is watching it stream — the one
            // kind of run allowed to fall back to their global MCP config
            // when the vault has no connectors.json (PR #5 security review).
            attended: true,
            approvedStdio: useUiStore.getState().stdioApprovals[vaultPath] ?? [],
            mcp: mcpRef.current,
          });
          // Cancelled during the spawn itself: the child exists now, so it has
          // to be killed by id rather than abandoned.
          if (cancelled()) {
            void stopAgent(run).catch(() => undefined);
            turnInFlight.current = false;
            setStreaming(false);
            setAgentBusy(false);
            return;
          }
          // The subscription is scoped to THIS run, so no event from any other
          // conversation, background job or killed child can reach this turn.
          // The mock and the Rust reader both emit asynchronously, so the id
          // is always in hand before the first event.
          runRef.current = run;
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
      connectors,
      endTurn,
      handleEvent,
      model,
      nextId,
      patchMessage,
      setAgentBusy,
      shell,
      systemPrompt,
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
      useUiStore.getState().setAgentBusy(false);
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
