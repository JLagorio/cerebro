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
  // M9.5: the result travels with the completion, so an action card has
  // something to expand to.
  | { kind: 'ToolDone'; tool_id: string; output?: string | null; is_error?: boolean }
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

/** What the agent did, shown inline in the transcript as an action card. */
export interface ToolCall {
  id: string;
  name: string;
  input: string | null;
  /** What the tool returned; null while running or when it returned nothing. */
  output: string | null;
  done: boolean;
  failed: boolean;
}

/**
 * A named conversation with the agent (M9.5).
 *
 * Persisted in app config, NOT in the vault. A transcript is a tool log, not
 * a note — writing it into the vault would feed it to the distiller that
 * reads the vault, which is exactly the loop M8 was designed to avoid.
 */
export interface Conversation {
  id: string;
  title: string;
  /** False once the user renames it, so auto-titling never overwrites them. */
  usesDefaultTitle: boolean;
  /** The CLI session to resume; null before the first turn. */
  sessionId: string | null;
  messages: ChatMessage[];
  createdAt: string;
  archived: boolean;
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
 * What the agent may do is no longer a mode the user picks per conversation
 * (M8.1). Three of them — read-only, vault edits, power — asked you to declare
 * a policy before you knew what you were going to ask for, and the honest
 * answer was always "it depends on the request."
 *
 * The permission model is the folder model instead: the agent owns
 * `knowledge/` and writes there freely, and cerebro's own tools are the only
 * way it reaches anything else. Shell access is the one thing left that a
 * folder boundary cannot express, so it is the one thing still switchable —
 * once, in Settings, as a ceiling rather than a per-turn choice.
 *
 * Enforcement lives in agent.rs, not here: a tool the agent never receives is
 * a rule, a tool it receives and is asked not to use is a suggestion.
 */
export interface AgentPolicy {
  /** Bash + the CLI's own file tools, scoped to the vault directory. */
  shell: boolean;
}

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
