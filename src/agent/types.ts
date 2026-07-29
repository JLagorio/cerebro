/**
 * Local agent types (M6). Mirrors the normalized events emitted by
 * src-tauri/src/agent.rs — the CLI's own wire format is richer and changes
 * between versions, so the panel only ever sees this shape.
 */

export type AgentEvent =
  | { kind: 'Init'; session_id: string }
  | { kind: 'TextDelta'; text: string }
  | { kind: 'ThinkingDelta'; text: string }
  | { kind: 'ToolStart'; tool_name: string; tool_id: string; input?: string | null }
  | { kind: 'ToolDone'; tool_id: string }
  | { kind: 'Result'; text: string; session_id?: string | null }
  | { kind: 'Error'; message: string }
  | { kind: 'Done' };

export interface AgentStatus {
  installed: boolean;
  version: string | null;
  path: string | null;
}

export interface McpInfo {
  url: string;
  token: string;
}

/** What the agent did, shown inline in the transcript as a chip. */
export interface ToolCall {
  id: string;
  name: string;
  input: string | null;
  done: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Assistant only: tool calls made while producing this message. */
  tools: ToolCall[];
  /** Assistant only: set when the turn failed. */
  error?: string;
  streaming?: boolean;
}

/**
 * Read-only cannot reach a write tool at all (enforced in agent.rs, not just
 * described here). Power adds shell access scoped to the vault directory.
 */
export type PermissionMode = 'read_only' | 'vault_edits' | 'power';

export const PERMISSION_MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'read_only', label: 'Read only', hint: 'Search and read. Cannot change anything.' },
  { value: 'vault_edits', label: 'Vault edits', hint: 'Can create and edit notes and knowledge. No shell.' },
  { value: 'power', label: 'Power', hint: 'Adds shell commands scoped to the vault folder.' },
];

/** A filing the agent suggests for an Inbox capture — shown, never applied (M7). */
export interface OrganizeProposal {
  path: string;
  type?: string;
  title?: string;
  properties?: Record<string, unknown>;
  reasoning: string;
}

export type UiAction =
  | { action: 'open_note'; path: string }
  | { action: 'navigate'; to: string; id?: string }
  | { action: 'vault_changed' }
  | ({ action: 'propose_organize' } & OrganizeProposal);
