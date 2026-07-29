import { useCallback, useEffect, useRef, useState } from 'react';
import { onAgentEvent, runAgent, startMcp, stopAgent } from './agentIpc';
import type { AgentEvent, ChatMessage, McpInfo, PermissionMode } from './types';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

let messageCounter = 0;
const nextId = (): string => `m-${++messageCounter}`;

export interface AgentChat {
  messages: ChatMessage[];
  streaming: boolean;
  send(text: string): void;
  stop(): void;
  reset(): void;
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
  permissionMode: PermissionMode,
  model: string | null,
): AgentChat {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const toast = useUiStore((s) => s.toast);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const sessionRef = useRef<string | null>(null);
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
      switch (event.kind) {
        case 'Init':
          sessionRef.current = event.session_id;
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
                done: false,
              },
            ],
          }));
          break;
        case 'ToolDone':
          patchActive((m) => ({
            ...m,
            tools: m.tools.map((t) => (t.id === event.tool_id ? { ...t, done: true } : t)),
          }));
          break;
        case 'Result':
          if (event.session_id) sessionRef.current = event.session_id;
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
          if (touchedFiles.current) {
            touchedFiles.current = false;
            void rescan().catch(() => undefined);
          }
          break;
      }
    });
  }, [patchActive, rescan]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed === '' || vaultPath === null) return;
      const assistantId = nextId();
      activeRef.current = assistantId;
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'user', text: trimmed, tools: [] },
        { id: assistantId, role: 'assistant', text: '', tools: [], streaming: true },
      ]);
      setStreaming(true);

      void (async () => {
        try {
          mcpRef.current ??= await startMcp(vaultPath);
          await runAgent(vaultPath, {
            message: trimmed,
            systemPrompt,
            sessionId: sessionRef.current,
            model,
            permissionMode,
            mcp: mcpRef.current,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, error: message, streaming: false } : m)),
          );
          activeRef.current = null;
          setStreaming(false);
          toast(message);
        }
      })();
    },
    [model, permissionMode, systemPrompt, toast, vaultPath],
  );

  const stop = useCallback(() => {
    void stopAgent().catch(() => undefined);
    patchActive((m) => ({ ...m, streaming: false }));
    activeRef.current = null;
    setStreaming(false);
  }, [patchActive]);

  const reset = useCallback(() => {
    void stopAgent().catch(() => undefined);
    sessionRef.current = null;
    activeRef.current = null;
    setStreaming(false);
    setMessages([]);
  }, []);

  return { messages, streaming, send, stop, reset };
}

/** Tools that change disk — the ones that make a rescan necessary. */
export function isWriteTool(name: string): boolean {
  return /create_note|update_frontmatter|append_to_note|write_concept|^Write$|^Edit$/.test(name);
}
