import type { Place } from '@/engine/place';

/**
 * Local agent types (M6). Mirrors the normalized events emitted by
 * src-tauri/src/agent.rs — the CLI's own wire format is richer and changes
 * between versions, so the panel only ever sees this shape.
 */

/** One run's stream payload, before the run tag is attached (mockAgent
 * scripts emit this shape; the IPC layer tags it). */
export type AgentStreamEvent =
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

/** Every event names the run (child process) it came from (PR #5 review):
 * a killed child's terminal Done arrives after the kill — sometimes in the
 * very dispatch that hands the stream to the next turn — and only the tag
 * lets a listener refuse it instead of ending whichever turn is active. */
export type AgentEvent = AgentStreamEvent & { run: number };

export interface AgentStatus {
  installed: boolean;
  version: string | null;
  path: string | null;
}

export interface McpInfo {
  url: string;
  token: string;
}

/**
 * What the Claude Code CLI has stored about this vault OUTSIDE it (M17.14).
 *
 * Cerebro spawns the CLI with cwd = the vault, and it files its own session
 * transcripts — and its auto-memory — under a slug derived from that path, in
 * the user's home directory. Vault content therefore accumulates outside the
 * vault: outside its git, outside its backups, outside every guard in
 * knowledge.rs.
 *
 * It cannot be switched off without breaking the product: `--bare` is the only
 * flag that skips auto-memory and it also stops the CLI reading the keychain,
 * which is how the user is signed in at all. So the app names the directory
 * and offers to empty it. A leak you can see and clear is a different thing
 * from one nobody mentions.
 */
export interface CliWorkspace {
  path: string;
  exists: boolean;
  sessions: number;
  bytes: number;
  memoryFiles: number;
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
  /**
   * Where this conversation was had (M17.5), stamped at its FIRST turn — a
   * thread with nothing in it is not about anywhere yet, and anchoring an
   * empty one would file it under whatever surface happened to be open when
   * the panel was.
   *
   * Null on every thread written before M17.5, and on any whose stored place
   * this build cannot read (`engine/place.isPlace`).
   */
  place?: Place | null;
  /**
   * What that place was CALLED when the thread was anchored.
   *
   * Stored rather than re-derived because a thread outlives the List it was
   * about: re-resolving a deleted List gives its id, while the label recorded
   * at the time still says "Roadmap". The place itself stays the identity —
   * this is only what to print.
   */
  placeLabel?: string;
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
  /**
   * User only: the `@handle` this turn was addressed to (M33b.6).
   *
   * Absent on every message that named nobody, which is nearly all of them.
   * `title` is null when the vault holds no agent by that name — the mention
   * was never anything but text, the turn went to the assistant, and this is
   * how the person finds that out. Quiet on purpose: an unresolved mention is
   * not an error to interrupt someone with, and it is not nothing either.
   *
   * On the message rather than on the conversation, because a thread keeps its
   * place anchor and gains a recipient PER TURN (D8) — addressing an agent once
   * does not make the whole thread theirs.
   */
  addressed?: { handle: string; title: string | null };
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
