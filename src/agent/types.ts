import type { RunChangeset } from '@/engine/changeset';
import type { Place } from '@/engine/place';
import type { QuestionAnswer, QuestionSet } from '@/engine/questionForm';
import type { ShellCeiling } from '@/lib/policy/toolApproval';

/**
 * Local agent types (M6). The events are the ones src-tauri/src/agent/fold.rs
 * folds out of Claude Code's two formats, its live stream and the session
 * file it writes for the same turns (M56.3): the CLI's own wire format is
 * richer and changes between versions, so the panel only ever sees this
 * shape, and src/agent/transcript.ts is the one reducer from it to messages.
 */

/** One run's stream payload, before the run tag is attached (mockAgent
 * scripts emit this shape; the IPC layer tags it). Also what a session file
 * folds to, read back through `readCliTranscript`. */
export type AgentStreamEvent =
  | { kind: 'Init'; session_id: string }
  /** A prompt the person sent, as the session file holds it (M56.3). */
  | { kind: 'UserPrompt'; text: string }
  /** The model answering this turn, as Claude Code reported it: once per
   * turn and again when it changes, never `<synthetic>`. */
  | { kind: 'ModelChanged'; model: string }
  /** One text block of an assistant message, whole. Live, the same words
   * arrived as TextDeltas first. */
  | { kind: 'Text'; message_id: string; text: string }
  | { kind: 'TextDelta'; text: string }
  | { kind: 'ThinkingDelta'; text: string }
  /** A tool call, its input a preview: each long string cut. */
  | { kind: 'ToolStart'; tool_name: string; tool_id: string; input?: string | null }
  // M9.5: a preview of the result travels with the completion, so an action
  // card has something to expand to; the whole rides ToolPayload (M56.8).
  | { kind: 'ToolDone'; tool_id: string; output?: string | null; is_error?: boolean }
  /** The whole of a tool call's input or output, sent only when its preview
   * cut it (M56.8): at most 256 KiB of it, cut on a character boundary;
   * `bytes` is the whole size and `truncated` says whether the cap cut it. */
  | {
      kind: 'ToolPayload';
      tool_id: string;
      part: 'input' | 'output';
      text: string;
      bytes: number;
      truncated: boolean;
    }
  | { kind: 'Result'; text: string; session_id?: string | null }
  /** `code` is the typed cause the CLI named, when it named one: the API
   * error on its own reply, or the result's subtype. `notice` is what Rust's
   * classifier made of the failure (M56.4); absent when it could not type it. */
  | { kind: 'Error'; message: string; code?: string | null; notice?: FailureNotice | null }
  /** A pull request the session opened (a `pr-link` record). */
  | { kind: 'PrLink'; number: number; url: string; repository: string }
  /** The turn ended, once; the stop reason when one was recorded. */
  | { kind: 'TurnEnded'; stop_reason?: string | null }
  /** The turn never ended: `stopped` by the person, or `cut_off`. */
  | { kind: 'TurnInterrupted'; reason: string }
  /** The turn is suspended on a call a PreToolUse hook deferred (M57.1):
   * Cerebro's gate waiting for the person, or a hook outside Cerebro. From
   * the stream and the session file alike; no TurnEnded follows. */
  | { kind: 'ToolDeferred'; tool_id: string; tool_name: string }
  /** A call waits for the person (M57.1): this run's own gate deferred it
   * and its stream confirmed it. Live only, just before its ToolDeferred. */
  | { kind: 'Interaction'; interaction: PendingInteraction }
  /** Local only, never from Rust (M57.1): the person stopped a turn whose
   * call was waiting, so the call is refused and reads cancelled. */
  | { kind: 'ToolCancelled'; tool_id: string }
  /** The run was stopped on purpose (M57.5): Stop, Steer, the run list, a
   * vault switch or quit. Live only, once, right before Done; never for a
   * run that ended on its own or that the watchdog aborted. */
  | { kind: 'Cancelled' }
  /** What the run changed (M58.3): its own commit, or why there is none.
   * Live only, once per run, after its books close and before its closing
   * events; never from a session file. */
  | { kind: 'Changeset'; changeset: RunChangeset }
  | { kind: 'Done' };

/**
 * A call waiting for the person's answer (M57.1), as Rust's book draws it
 * (`agent::interaction::InteractionCard`). `kind` picks the card's renderer:
 * `permission`, `write` for an ask-first agent's page write (M57.4), or
 * `question` for AskUserQuestion (M57.3); a kind this build does not know is
 * drawn as a permission.
 */
export interface PendingInteraction {
  /** 128-bit hex, the id the answer names. */
  id: string;
  kind: 'permission' | 'write' | 'question' | (string & {});
  tool_name: string;
  tool_id: string;
  session_id: string;
  /** The tool's title and its target, else its name. */
  summary: string;
  /** A tool-approval ask's family (M57.2): what the card is titled by, and
   * what This conversation covers with the subject. Null, or absent from an
   * older book, for any other ask, which offers no This conversation. */
  family?: string | null;
  /** The exact command, path or input the card names (M57.2). */
  subject?: string | null;
  /** A cerebro tool's manifest title (M57.4): a write card's headline. */
  title?: string | null;
  /** The note or folder the call is aimed at, when its input names one
   * (M57.4). */
  target?: string | null;
  /** Who asks (M57.4): the run's actor, `process:<handle>` for an agent;
   * null for the plain panel. */
  actor?: string | null;
  /** A question card's questions (M57.3), parsed by Rust's book; absent on
   * every other card. */
  questions?: QuestionSet | null;
  /** The call's input, pretty JSON, at most 256 KiB. */
  input: string;
  /** RFC 3339. */
  asked_at: string;
}

/** A person's answer to a waiting call (M57.1). Only the answer command
 * carries it to Rust; nothing the agent holds can send one. An allow holds
 * for this call (`once`, the default) or, for a tool-approval ask, for every
 * call in the conversation with the same family and exact subject
 * (`conversation`, M57.2). An allow of a write card may carry the person's
 * edit of the draft (`updatedInput`, M57.4b), which the adapter sends as the
 * command's `updatedInput` key and Rust re-checks. A question card is
 * answered with its answers, one per question (M57.3), or declined with a
 * deny. */
export type PersonAnswer =
  | {
      kind: 'allow';
      remember?: 'once' | 'conversation';
      updatedInput?: Record<string, unknown>;
    }
  | { kind: 'deny'; message?: string }
  | { kind: 'answers'; answers: QuestionAnswer[] };

/**
 * The person's own Claude Code settings, counted (M57.2,
 * `agent::user_settings`): never a rule's text. `unreadable` is a read that
 * failed, never an empty file (CV-05); `browser` is the mock, which has
 * none to read.
 */
export type ClaudeUserSettings =
  | {
      state: 'read';
      path: string;
      allow: number;
      ask: number;
      deny: number;
      hook_events: string[];
    }
  | { state: 'absent'; path: string }
  | { state: 'unreadable'; path: string; detail: string }
  | { state: 'browser' };

/**
 * A failure, typed and worded by Rust (M56.4, src-tauri/src/agent/failure.rs).
 * Rust is the one classifier: the panel renders these words and never
 * switches on `kind`, so a kind this build does not know still reads right.
 */
export interface FailureNotice {
  kind: string;
  title: string;
  body: string;
  /** The fix the card offers (`open_settings`, `new_conversation`,
   * `choose_model`); a button is drawn only for one the panel handles. */
  action: string | null;
  /** When the limit resets, RFC 3339 UTC, when Claude Code said. */
  resets_at: string | null;
  /** The limit's window in words ("5-hour", "weekly"). */
  window: string | null;
  /** The Claude Code version that reported it. */
  cli_version: string | null;
}

/** A pull request a conversation's session opened (M56.3). */
export interface PrLink {
  number: number;
  url: string;
  repository: string;
}

/**
 * Why a transcript could not be read back, as Rust types it
 * (`transcript::Unavailable`). A string the panel words, with a default
 * branch for one this build does not name: Rust is the one classifier.
 */
export type TranscriptUnavailable = 'cleared' | 'expired' | 'not_recorded' | 'unreadable';

/** What reading a conversation's session file found (M56.3). */
export type TranscriptRead =
  | {
      state: 'read';
      events: AgentStreamEvent[];
      /** Lines folded. */
      lines: number;
      /** Kinds the fold could not classify. */
      unclassified: string[];
    }
  | {
      state: 'unavailable';
      reason: TranscriptUnavailable | (string & {});
      /** The retention in force; null when Claude Code never sweeps. */
      retention_days: number | null;
      detail?: string;
    };

/** Every event names the run (child process) it came from (PR #5 review):
 * a killed child's terminal Done arrives after the kill — sometimes in the
 * very dispatch that hands the stream to the next turn — and only the tag
 * lets a listener refuse it instead of ending whichever turn is active.
 * `seq` is its place in that run, from 1 (M57.6): the cursor a panel
 * re-attaches from, so each event shows once. */
export type AgentEvent = AgentStreamEvent & { run: number; seq: number };

/**
 * A turn whose run may still be going while nobody watches it (M57.6): the
 * run's process tag, its attach key (the durable run id in Tauri), and the
 * reply bubble its events land in. Saved with the thread, so reopening it,
 * or reloading, re-attaches.
 */
export interface LiveTurn {
  run: number;
  attach: string;
  assistantId: string;
}

export interface AgentStatus {
  installed: boolean;
  version: string | null;
  path: string | null;
}

/**
 * What the Claude Code CLI has stored about this vault OUTSIDE it (M17.14).
 *
 * Cerebro spawns the CLI with cwd = the vault, and it files its own session
 * transcripts — with each session's subagent transcripts, tool output and
 * copies of the files it edited — and its auto-memory under a key derived from
 * that path, in its own config folder (`~/.claude` unless `CLAUDE_CONFIG_DIR`
 * says otherwise). Vault content therefore accumulates outside the
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
  /** Distinct sessions, orphaned session folders (no transcript) included. */
  sessions: number;
  /** Every file those sessions keep: top-level `<id>.*` files, everything
   * under `<id>/`, and `file-history/<id>/`. */
  sessionFiles: number;
  /** The bytes of those session files. */
  bytes: number;
  /** Auto-memory files, at any depth. */
  memoryFiles: number;
  /** What the count could not read; above zero, every count is a floor. */
  unreadable: number;
  /** The folder is shared by every project (CLAUDE_CODE_PROJECT_DIR_NAME), so
   * it is counted and never cleared. */
  shared: boolean;
}

/** What the agent did, shown inline in the transcript as an action card. */
export interface ToolCall {
  id: string;
  name: string;
  /** The input as a preview: each long string cut. */
  input: string | null;
  /** A preview of what the tool returned, cut at 2000 characters; null while
   * running or when it returned nothing. `payload` holds the whole of it, in
   * memory, when the preview cut it. */
  output: string | null;
  done: boolean;
  failed: boolean;
  /** The whole input and output, where a preview cut them (M56.8). Memory
   * only: live from the stream, and after a reload from Claude Code's session
   * file while it exists; never saved with the thread. */
  payload?: ToolPayload;
  /** A PreToolUse hook deferred this call (M57.1): it waits for the person,
   * or, unfinished on a later turn, it never ran. */
  deferred?: boolean;
  /** The person stopped the turn while this call waited (M57.1). */
  cancelled?: boolean;
  /** Deferred by a hook outside Cerebro, which no card answers (M57.1).
   * Memory only. */
  paused?: boolean;
}

/** A tool call's whole input and output (M56.8), each set only when its
 * preview cut it; `*Bytes` is the whole size, and `*Truncated` says the
 * 256 KiB cap cut what is held. */
export interface ToolPayload {
  input?: string;
  output?: string;
  inputTruncated?: boolean;
  outputTruncated?: boolean;
  inputBytes?: number;
  outputBytes?: number;
}

/**
 * A named conversation with the agent (M9.5).
 *
 * Kept in localStorage, NOT in the vault. Its messages are a cached copy: the
 * transcript is Claude Code's own session file, which the panel folds back
 * when the copy is gone (M56.3). Never the vault, because a transcript is a
 * tool log, not a note — writing it there would feed it to the distiller
 * that reads the vault, which is exactly the loop M8 was designed to avoid.
 * A turn still running when the panel closed or the thread switched is
 * named by `live` (M57.6), so the thread re-attaches to it when it opens.
 */
export interface Conversation {
  id: string;
  title: string;
  /** False once the user renames it, so auto-titling never overwrites them. */
  usesDefaultTitle: boolean;
  /** The Claude Code session to resume, minted at the first turn and stored
   * as soon as it is known; null until then. A UUID, or nothing. */
  sessionId: string | null;
  messages: ChatMessage[];
  createdAt: string;
  archived: boolean;
  /** The vault this conversation was had in (M56.3), stamped at its first
   * turn. Its session file lives under that vault's key, so a thread from
   * another vault cannot continue here. Absent on older threads. */
  vault?: string;
  /** When its last turn ended (M56.3): what tells Claude Code's sweep from a
   * clear when the session file is gone. Absent on older threads, which then
   * fall back to `createdAt`. */
  updatedAt?: string;
  /** The turn this thread left running (M57.6), re-attached when it opens;
   * null or absent once its turn ended. Healed on load. */
  live?: LiveTurn | null;
  /** The model and effort this conversation's turns ask Claude Code for
   * (M56.5), picked in the composer. Null or absent is unset: an addressed
   * agent's record decides, else Claude Code's default. A stored value Rust
   * would refuse is dropped on load (`conversations.ts`). */
  model?: string | null;
  effort?: string | null;
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
  /** Assistant only: the failure typed and worded (M56.4), beside `error`,
   * which keeps what Claude Code said. */
  notice?: FailureNotice;
  streaming?: boolean;
  /** Assistant only: the model Claude Code reported answering (M56.3). */
  model?: string;
  /** Assistant only: the turn never ended — stopped, or cut off. */
  interrupted?: boolean;
  /** Assistant only: the seq of the last live event applied to this reply
   * (M57.6), the cursor a re-attach reads after. Saved with it. */
  seq?: number;
  /** Assistant only: the journal dropped events of this reply's run while
   * the panel was closed (M57.6), so it says so and rebuilds from the
   * session file when the turn finishes. */
  gap?: true;
  /** Assistant only: a person stopped this turn (M57.5), with Stop or by
   * steering past it. It reads "Cancelled" in place of the interrupted copy;
   * the text it wrote before the stop stays. */
  cancelled?: true;
  /** Assistant only: what each of this reply's runs changed (M58.3), one per
   * run, upserted by run id: a turn resumed after a held call has two. Saved
   * with the thread; a thread rebuilt from the session file has none. */
  changesets?: RunChangeset[];
  /**
   * Assistant only, in memory only: what the reducer keeps while a turn is
   * live (`transcript.ts`) — the last message's text, every message's text,
   * and whether the turn has ended. Never persisted.
   */
  live?: { messageId: string | null; finalText: string; allText: string; ended: boolean };
  /**
   * User only: the `@handle` this turn was addressed to (M33b.6).
   *
   * Absent on every message that named nobody, which is nearly all of them.
   * `title` is null when the vault holds no agent by that name — the mention
   * was never anything but text, the turn went to whoever the panel answers
   * as, and this is how the person finds that out. `answeredBy` names that
   * one when Settings binds the panel to an agent (M56.6); absent, the plain
   * assistant took it. Quiet on purpose: an unresolved mention is not an
   * error to interrupt someone with, and it is not nothing either.
   *
   * On the message rather than on the conversation, because a thread keeps its
   * place anchor and gains a recipient PER TURN (D8) — addressing an agent once
   * does not make the whole thread theirs.
   */
  addressed?: { handle: string; title: string | null; answeredBy?: string };
  /**
   * User only: what the agent was sent, when it was not the bubble's words
   * (M52.4) — a surface's labelled ask shows "Ask to revise · ‹title›" and
   * sends the pages-long prompt behind it. Kept so a retry sends the prompt
   * again rather than the label. Absent when the bubble IS what was sent,
   * and on a skill's turn, whose expansion is read inside the turn.
   */
  prompt?: string;
}

/**
 * What the agent may do is no longer a mode the user picks per conversation
 * (M8.1). Three of them — read-only, vault edits, power — asked you to declare
 * a policy before you knew what you were going to ask for, and the honest
 * answer was always "it depends on the request."
 *
 * The permission model is the folder model instead: the agent owns
 * `knowledge/` and writes there freely, and cerebro's own tools are the only
 * way it reaches anything else. Beside them, the CLI's own tools are set once
 * in Settings by a shell ceiling: off, ask or on (M57.2), which
 * `shared/policy/tool-approval.v1.json` turns into what each run may run,
 * ask about or is refused.
 *
 * Enforcement lives in Rust, not here: a tool the agent never receives is a
 * rule, a tool it receives and is asked not to use is a suggestion.
 */
export interface AgentPolicy {
  /** The shell ceiling: what the CLI's own shell and file tools may do. */
  shell: ShellCeiling;
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
  /** navigate's arguments (M59.1): a place id from `engine/destinations.ts`,
   * or `view` with the database and, optionally, its saved view. */
  | { action: 'navigate'; to: string; database?: string; view?: string }
  /**
   * An agent tool wrote the vault (M53.6). `paths` names the files it changed,
   * as the scan lists them, when the tool could name them; absent means
   * "somewhere — rescan", never "nothing changed".
   */
  | { action: 'vault_changed'; paths?: string[] }
  /**
   * An agent's comment tool posted beside a page (M70.3): only that page's
   * comments changed, never a file the vault lists, so this reloads its
   * threads and rescans nothing.
   */
  | { action: 'comments_changed'; path: string }
  | ({ action: 'propose_organize' } & OrganizeProposal);
