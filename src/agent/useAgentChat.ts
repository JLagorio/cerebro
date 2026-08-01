import { useCallback, useEffect, useRef, useState } from 'react';
import { onAgentEvent, runAgent, startMcp, stopAgent } from './agentIpc';
import type { AgentEvent, ChatMessage, McpInfo } from './types';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

let messageCounter = 0;
const nextId = (): string => `m-${++messageCounter}`;

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
  // Shared with the background distiller so the two never run at once — there
  // is one agent process, and a typed question outranks a background read.
  const setAgentBusy = useUiStore((s) => s.setAgentBusy);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  // The prompt that started the in-flight turn, so a write checkpoint can say
  // what the agent was asked to do rather than just that it wrote.
  const lastPrompt = useRef<string>('');
  const onWrote = useRef(onWroteFiles);
  onWrote.current = onWroteFiles;
  const activeRef = useRef<string | null>(null);
  const mcpRef = useRef<McpInfo | null>(null);
  // Runs this hook has killed (PR #5 review). A killed child's trailing
  // events — its terminal Done above all — must be recognizable as dead
  // history, because they can land in the same dispatch that hands the
  // stream over OR seconds after a timeout takeover, and timing alone
  // cannot tell them from the live turn's.
  const deadRuns = useRef<Set<number>>(new Set());
  // The agent writes straight to disk; a turn that touched files must end
  // with a rescan or the UI keeps showing the pre-agent vault.
  const touchedFiles = useRef(false);

  const patchActive = useCallback((update: (m: ChatMessage) => ChatMessage) => {
    const id = activeRef.current;
    if (id === null) return;
    setMessages((prev) => prev.map((m) => (m.id === id ? update(m) : m)));
  }, []);

  useEffect(() => {
    return onAgentEvent((event: AgentEvent) => {
      // A run this hook killed is dead history: drop everything it emits,
      // and forget it once its terminal Done — the last event a run can
      // produce — has been swallowed (PR #5 review).
      if (deadRuns.current.has(event.run)) {
        if (event.kind === 'Done') deadRuns.current.delete(event.run);
        return;
      }
      // The stream is shared with the background runner (M8.6/M13.2), which
      // runs whole turns of its own. With no active message this conversation
      // is not the one being answered, and `Init` in particular must not land
      // — adopting the runner's session id would make your next question
      // resume its transcript instead of yours.
      if (activeRef.current === null) return;
      // While learningPath is set, the runner OWNS the stream — including the
      // terminal Done of a background child this send just killed. Without
      // this, that stray Done ends the chat's turn before it begins: the
      // bubble freezes empty and every real event is dropped (M13.2 review).
      if (useUiStore.getState().learningPath !== null) return;
      switch (event.kind) {
        case 'Init':
          sessionRef.current = event.session_id;
          setSessionId(event.session_id);
          break;
        case 'TextDelta':
          patchActive((m) => ({ ...m, text: m.text + event.text }));
          break;
        case 'ThinkingDelta':
          // Reasoning is not shown as prose — it would read as the answer.
          // Only its arrival matters, as a "working" signal.
          break;
        case 'ToolStart':
          if (isWriteTool(event.tool_name)) touchedFiles.current = true;
          patchActive((m) => ({
            ...m,
            tools: [
              ...m.tools,
              {
                id: event.tool_id,
                name: event.tool_name,
                input: event.input ?? null,
                output: null,
                done: false,
                failed: false,
              },
            ],
          }));
          break;
        case 'ToolDone':
          patchActive((m) => ({
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
          patchActive((m) => ({
            ...m,
            text: event.text.trim() !== '' ? event.text : m.text,
          }));
          break;
        case 'Error':
          patchActive((m) => ({ ...m, error: event.message }));
          break;
        case 'Done':
          patchActive((m) => ({ ...m, streaming: false }));
          activeRef.current = null;
          setStreaming(false);
          setAgentBusy(false);
          if (touchedFiles.current) {
            touchedFiles.current = false;
            void rescan().catch(() => undefined);
            // M9.5/M9.4: a turn that wrote files gets its own checkpoint, so
            // the assistant's work is revertible on its own rather than
            // tangled into the user's next one.
            onWrote.current?.(lastPrompt.current);
          }
          break;
      }
    });
  }, [patchActive, rescan, setAgentBusy]);

  const send = useCallback(
    (text: string, message?: string | (() => Promise<string>)) => {
      const trimmed = text.trim();
      if (trimmed === '' || vaultPath === null) return;
      const assistantId = nextId();
      lastPrompt.current = trimmed;
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'user', text: trimmed, tools: [] },
        { id: assistantId, role: 'assistant', text: '', tools: [], streaming: true },
      ]);
      setStreaming(true);
      setAgentBusy(true);

      void (async () => {
        try {
          // A typed question outranks a background read: if the runner is
          // mid-turn, stop its child deliberately, then WAIT for its finish()
          // (on the resulting Done, which the runner still owns) to release
          // the stream. Running before that handoff lands would put this
          // turn's events on a stream the handler above is still ignoring —
          // the bubble would stay empty (PR #5 review).
          if (useUiStore.getState().learningPath !== null) {
            const dead = await stopAgent().catch(() => null);
            if (typeof dead === 'number') deadRuns.current.add(dead);
            await streamReleased(RELEASE_TIMEOUT_MS);
            // The runner's finish() dropped agentBusy on its way out. Claim
            // it back before this turn's child starts, or the runner reads
            // the agent as idle and schedules a background run that would
            // replace the child mid-answer (PR #5 review).
            setAgentBusy(true);
          }
          // The stream is claimed only NOW, after the handoff: the killed
          // child's terminal events can be delivered in the very dispatch
          // that released the stream — before its dead-run id is even
          // knowable — and an earlier claim would adopt them as this turn's
          // Done, freezing the bubble empty (PR #5 review).
          activeRef.current = assistantId;
          const expanded =
            typeof message === 'function'
              ? await message().catch(() => trimmed)
              : message?.trim();
          const outgoing = expanded === undefined || expanded === '' ? trimmed : expanded;
          mcpRef.current ??= await startMcp(vaultPath);
          await runAgent(vaultPath, {
            message: outgoing,
            systemPrompt,
            sessionId: sessionRef.current,
            model,
            shell,
            connectors,
            approvedStdio: useUiStore.getState().stdioApprovals[vaultPath] ?? [],
            mcp: mcpRef.current,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, error: message, streaming: false } : m)),
          );
          activeRef.current = null;
          setStreaming(false);
          setAgentBusy(false);
          toast(message);
        }
      })();
    },
    [connectors, model, setAgentBusy, shell, systemPrompt, toast, vaultPath],
  );

  /** Kill the in-flight run and remember it as dead, so its trailing events
   * cannot end a turn started right after (PR #5 review). Fire-and-forget:
   * these callers null activeRef synchronously, which already ignores the
   * strays that beat the id back. */
  const killRun = useCallback(() => {
    void stopAgent()
      .then((dead) => {
        if (typeof dead === 'number') deadRuns.current.add(dead);
      })
      .catch(() => undefined);
  }, []);

  const stop = useCallback(() => {
    killRun();
    patchActive((m) => ({ ...m, streaming: false }));
    activeRef.current = null;
    setStreaming(false);
    setAgentBusy(false);
  }, [killRun, patchActive, setAgentBusy]);

  const reset = useCallback(() => {
    killRun();
    sessionRef.current = null;
    setSessionId(null);
    activeRef.current = null;
    setStreaming(false);
    setAgentBusy(false);
    setMessages([]);
  }, [killRun, setAgentBusy]);

  /** Load a stored conversation. Stops any turn first: the events already in
   * flight belong to the transcript being replaced. */
  const restore = useCallback(
    (restored: ChatMessage[], restoredSession: string | null) => {
      killRun();
      activeRef.current = null;
      setStreaming(false);
      setAgentBusy(false);
      sessionRef.current = restoredSession;
      setSessionId(restoredSession);
      setMessages(restored);
    },
    [killRun, setAgentBusy],
  );

  return { messages, streaming, send, stop, reset, sessionId, restore };
}

/** Tools that change disk — the ones that make a rescan necessary. */
export function isWriteTool(name: string): boolean {
  return /create_note|update_frontmatter|append_to_note|write_concept|^Write$|^Edit$/.test(name);
}

/** How long send() waits for the runner to hand the stream over. A killed
 * child's Done arrives within milliseconds; the bound exists so a lost event
 * degrades into taking the stream rather than a send that never runs. */
const RELEASE_TIMEOUT_MS = 5_000;

/** Resolves once the job runner has released the shared event stream — its
 * finish(), riding the killed child's terminal Done, clears learningPath.
 * On timeout the stream is taken anyway; clearing learningPath here is how
 * the runner's finish() knows the takeover happened, so the child's late
 * terminal event drops the runner's claim without touching the busy flag
 * this send is about to raise (PR #5 review). */
function streamReleased(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (useUiStore.getState().learningPath === null) {
      resolve();
      return;
    }
    let timer = 0;
    const unsubscribe = useUiStore.subscribe((s) => {
      if (s.learningPath !== null) return;
      window.clearTimeout(timer);
      unsubscribe();
      resolve();
    });
    timer = window.setTimeout(() => {
      unsubscribe();
      useUiStore.getState().setLearningPath(null);
      resolve();
    }, timeoutMs);
  });
}
