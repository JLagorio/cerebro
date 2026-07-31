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
      activeRef.current = assistantId;
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
          // mid-turn, stop its child deliberately and let its finish() (on
          // the resulting Done, which the runner still owns) release the
          // stream before this turn's child speaks.
          if (useUiStore.getState().learningPath !== null) {
            await stopAgent().catch(() => undefined);
          }
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

  const stop = useCallback(() => {
    void stopAgent().catch(() => undefined);
    patchActive((m) => ({ ...m, streaming: false }));
    activeRef.current = null;
    setStreaming(false);
    setAgentBusy(false);
  }, [patchActive, setAgentBusy]);

  const reset = useCallback(() => {
    void stopAgent().catch(() => undefined);
    sessionRef.current = null;
    setSessionId(null);
    activeRef.current = null;
    setStreaming(false);
    setAgentBusy(false);
    setMessages([]);
  }, [setAgentBusy]);

  /** Load a stored conversation. Stops any turn first: the events already in
   * flight belong to the transcript being replaced. */
  const restore = useCallback(
    (restored: ChatMessage[], restoredSession: string | null) => {
      void stopAgent().catch(() => undefined);
      activeRef.current = null;
      setStreaming(false);
      setAgentBusy(false);
      sessionRef.current = restoredSession;
      setSessionId(restoredSession);
      setMessages(restored);
    },
    [setAgentBusy],
  );

  return { messages, streaming, send, stop, reset, sessionId, restore };
}

/** Tools that change disk — the ones that make a rescan necessary. */
export function isWriteTool(name: string): boolean {
  return /create_note|update_frontmatter|append_to_note|write_concept|^Write$|^Edit$/.test(name);
}
