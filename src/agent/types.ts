import type { SubagentSummary, ToolResultData } from '@/engine/ai/types';
import type { RunChangeset } from '@/engine/changeset';
import type { Place } from '@/engine/place';
import type { QuestionAnswer, QuestionSet } from '@/engine/questionForm';
import type { Decision, ShellCeiling } from '@/lib/policy/toolApproval';

/**
 * Local agent types (M6). The events are the ones src-tauri/src/agent/fold.rs
 * folds out of Claude Code's two formats, its live stream and the session
 * file it writes for the same turns (M56.3): the CLI's own wire format is
 * richer and changes between versions, so the panel only ever sees this
 * shape, and src/agent/transcript.ts is the one reducer from it to messages.
 */

// The data shapes the AI elements draw (M91.10) live in the engine, so its
// parsers can read them; the agent layer names them from here.
export type {
  AgentResultData,
  ShellResultData,
  SourceRef,
  SourceVia,
  StepInput,
  StepKind,
  StepStatus,
  SubagentSummary,
  TodoItem,
  TodoStatus,
  TodosResultData,
  ToolResultData,
  WebFetchResultData,
  WebSearchResultData,
  WireTodo,
} from '@/engine/ai/types';

/** One run's stream payload, before the run tag is attached (mockAgent
 * scripts emit this shape; the IPC layer tags it). Also what a session file
 * folds to, read back through `readCliTranscript`. M91.3a's fields are
 * optional and absent when Rust has none: `at` is the CLI line's RFC 3339
 * timestamp, and `parent` the Agent call whose subagent a line belongs to. */
export type AgentStreamEvent =
  | { kind: 'Init'; session_id: string }
  /** What the run reaches (M92.8), from the values its argv was built from:
   * once, right after the first init Rust's init gate admits; never for an
   * internal run or one its init refused. Live only, never from a session
   * file. */
  | { kind: 'Reach'; reach: RunReach }
  /** A prompt the person sent, as the session file holds it (M56.3), with
   * its line's uuid. */
  | { kind: 'UserPrompt'; text: string; uuid?: string }
  /** The model answering this turn, as Claude Code reported it: once per
   * turn and again when it changes, never `<synthetic>`. */
  | { kind: 'ModelChanged'; model: string }
  /** One text block of an assistant message, whole. Live, the same words
   * arrived as TextDeltas first. */
  | { kind: 'Text'; message_id: string; text: string; parent?: string; at?: string }
  | { kind: 'TextDelta'; text: string }
  /** Reasoning as it streams: never empty, never a subagent's (M91.3a). */
  | { kind: 'ThinkingDelta'; text: string }
  /** One reasoning block, whole (M91.3a), from the stream and the session
   * file alike; live, its words came as ThinkingDeltas first. Its text may be
   * empty, and a redacted block has none. */
  | {
      kind: 'Thinking';
      message_id: string;
      text: string;
      redacted?: true;
      parent?: string;
      at?: string;
    }
  /** A tool call, its input a preview: each long string cut. */
  | {
      kind: 'ToolStart';
      tool_name: string;
      tool_id: string;
      input?: string | null;
      parent?: string;
      at?: string;
    }
  // M9.5: a preview of the result travels with the completion, so an action
  // card has something to expand to; the whole rides ToolPayload (M56.8).
  | {
      kind: 'ToolDone';
      tool_id: string;
      output?: string | null;
      is_error?: boolean;
      parent?: string;
      at?: string;
    }
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
      parent?: string;
    }
  /** What a call's structured result says, for the tools whose result the
   * panel draws (M91.3a): after its ToolDone, from both formats. */
  | { kind: 'ToolResult'; tool_id: string; parent?: string; data: ToolResultData }
  /** Claude Code refused a call by its own rules (M91.3a): its ToolDone
   * follows as an error. Live only, never from a session file. */
  | { kind: 'ToolDenied'; tool_id: string; tool_name: string; message: string }
  /** Claude Code started a subagent for the Agent call `tool_id` (M91.3b):
   * the agent id it runs as, its type and task, whether it runs in the
   * background, and how deep it was spawned when the CLI said. Its type or
   * task is empty when the CLI named none. Live only. */
  | {
      kind: 'SubagentStarted';
      tool_id: string;
      agent_id: string;
      subagent_type: string;
      description: string;
      background: boolean;
      depth?: number;
    }
  /** What a running subagent is doing (M91.3b): its latest step in Claude
   * Code's words, its last tool, and its tool uses and time so far. Never its
   * tokens. Live only. */
  | {
      kind: 'SubagentProgress';
      tool_id: string;
      description: string;
      last_tool?: string;
      tool_uses?: number;
      duration_ms?: number;
    }
  /** A subagent ended (M91.3b), in Claude Code's word for how, with its
   * totals; its report is its Agent call's ToolResult. Live only. */
  | {
      kind: 'SubagentDone';
      tool_id: string;
      status: string;
      tool_uses?: number;
      duration_ms?: number;
    }
  /** The turn's answer, live only: a session file holds no result line.
   * `duration_ms` is how long Claude Code worked on the turn, as its result
   * counted it (M92.2), a live ask's wait included; absent when it gave no
   * count. */
  | { kind: 'Result'; text: string; session_id?: string | null; duration_ms?: number }
  /** `code` is the typed cause the CLI named, when it named one: the API
   * error on its own reply, or the result's subtype. `notice` is what Rust's
   * classifier made of the failure (M56.4); absent when it could not type it. */
  | {
      kind: 'Error';
      message: string;
      code?: string | null;
      notice?: FailureNotice | null;
      parent?: string;
    }
  /** A pull request the session opened (a `pr-link` record). */
  | { kind: 'PrLink'; number: number; url: string; repository: string }
  /** The turn ended, once; the stop reason when one was recorded, and the
   * uuid of its last main-thread assistant line, where a branch can start
   * (M91.3a). */
  | { kind: 'TurnEnded'; stop_reason?: string | null; last_uuid?: string }
  /** The turn never ended: `stopped` by the person, or `cut_off`. */
  | { kind: 'TurnInterrupted'; reason: string }
  /** The turn is suspended on a call a PreToolUse hook deferred (M57.1):
   * Cerebro's gate waiting for the person, or a hook outside Cerebro. From
   * the stream and the session file alike; no TurnEnded follows.
   * `duration_ms` is how long the run worked before the hook held it, from
   * the stream's result (M92.2); the session file's marker gives none. */
  | { kind: 'ToolDeferred'; tool_id: string; tool_name: string; duration_ms?: number }
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

/** One connector a run loads (M92.8), by its name in the vault's list, and
 * its status in the run's first init as Claude Code spelled it: `absent`
 * when that init left it out, `unreported` when it gave no status. */
export interface ConnectorInit {
  name: string;
  status: string;
}

/** A connector a run's record named that the run does not get (M54.11), as
 * its prompt names it: the name cut to 64 characters, and why in Rust's
 * words. */
export interface MissingConnector {
  name: string;
  reason: string;
}

/**
 * What one run reaches (M92.8), as Rust's `agent::RunReach` says it: built
 * from the connectors, the tool-approval plan and the pinning its argv was
 * built from, so the rail and the run's prompt never tell two stories.
 * Facts, never words: the rail words them. A thread saves its latest as its
 * own fact (`conversations.threadReach`).
 */
export interface RunReach {
  /** Each connector it loads, in the vault list's order. */
  connectors: ConnectorInit[];
  /** The connectors its record named that it does not get: exactly the ones
   * its prompt names, at most eight. */
  missing: MissingConnector[];
  /** How many more its prompt counts without naming them. */
  missing_more: number;
  /** It also loads the MCP servers in the person's own Claude Code config
   * (legacy open mode), which no vault list names, so `connectors` is not
   * all it reaches. */
  inherits: boolean;
  /** The mode its `--permission-mode` started it in. */
  permission_mode: string;
  /** Its grant holds Cerebro's own tools, which read and change pages. */
  cerebro: boolean;
  /** How its plan decided each family of tools, by the tool-approval table's
   * family id: each decision the family's tools got, once, in the manifest's
   * order. The reach words read them: pages (`confirmable`), shell, web,
   * subagents (`delegate`) and edit mode (`file_write`). */
  families: Record<string, Decision[]>;
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
  /** The Agent call whose subagent made this call (M91.4); absent on the
   * main thread's own calls. */
  parent?: string;
  /** When the call started and returned, as Claude Code stamped its lines
   * (M91.4): RFC 3339, each absent when nothing recorded it. A duration is
   * their difference only (`durationBetween`), never a guess. */
  startedAt?: string;
  endedAt?: string;
  /** What the call's structured result says (M91.3a), for the tools whose
   * result the panel draws. Memory only: the session file holds it, and a
   * reload heals it back while it exists. */
  result?: ToolResultData;
  /** Claude Code refused the call by its own rules (M91.3a), in its words.
   * Live only, so a thread keeps it. */
  denied?: string;
  /** The subagent an Agent call started (M91.4), with its own steps. Saved
   * as its summary only; its steps heal from the session file's
   * `subagents/` while they exist. */
  subagent?: SubagentRun;
}

/**
 * One piece of a turn, in the order it came (M91.4): a reasoning block, a
 * message's text, or a call, by id. A message's text parts hold every
 * message's words in order, the last its answer; a reasoning block's
 * `durationMs` is the time since the step before it, from two recorded `at`s
 * only (CV-05).
 */
export type MessagePart =
  | {
      kind: 'reasoning';
      id: string;
      text: string;
      /** Claude Code withheld the text (a `redacted_thinking` block). */
      redacted?: true;
      /** Its words are still arriving. Memory only. */
      streaming?: true;
      at?: string;
      durationMs?: number;
    }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'tool'; toolId: string };

/**
 * A subagent an Agent call started (M91.4): what Claude Code reported of it,
 * its own steps, and, live, what it is doing now. Its `type` and
 * `description` read empty when nothing named them, and are never printed so.
 */
export interface SubagentRun extends SubagentSummary {
  /** Live only: what `SubagentStarted` and `SubagentProgress` said. */
  background?: boolean;
  depth?: number;
  progress?: string;
  lastTool?: string;
  /** Its own failure in Claude Code's words, when an API error ended it;
   * never the turn's. Memory only. */
  error?: string;
  parts: MessagePart[];
  tools: ToolCall[];
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
 * Where a branch leaves its conversation (M91.6), as Rust's
 * `transcript::ForkRequest` reads it: the Claude Code session it forks, and
 * the anchor it forks at, the line one of that session's turns ended on
 * (`ChatMessage.anchor`). Both are lowercase UUIDs.
 */
export interface ForkPoint {
  from: string;
  at: string;
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
  /** A branch's source (M91.6): sent with every turn until the thread has a
   * session of its own, which Rust mints and forks from it, then dropped.
   * Absent on every other thread. Healed on load. */
  fork?: ForkPoint | null;
  /** What this thread's latest run said it reaches (M92.8), saved as the
   * thread's own small fact: its replies keep theirs in memory only, so a
   * reload, or a trimmed body, still knows it (`conversations.threadReach`).
   * Absent until a run said one. Healed on load. */
  reach?: RunReach | null;
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
  /** Assistant only: how long Claude Code worked on this reply (M92.2), the
   * sum of each of its runs' own count (`duration_ms`), once per run: a
   * resume after a held call is a run of its own, so it adds its own. Null
   * when one run counted and another did not, so a partial sum is never kept
   * (CV-05); absent while no run has counted. Live only: a reply rebuilt from
   * the session file has none. Saved with the thread. */
  workedMs?: number | null;
  /** Assistant only: the count the run still writing this reply gave
   * (M92.2), until the run's Changeset closes it: a later count of the same
   * run replaces it in `workedMs`, never adds to it. Saved with the thread,
   * so a re-attach still closes it. */
  workedRun?: number;
  /** Assistant only: what the run writing this reply said it reaches
   * (M92.8): the latest run's, so a resume's stands in place of the held
   * run's. Live only, and memory only here: the thread saves the latest as
   * its own fact (`Conversation.reach`). */
  reach?: RunReach;
  /** Assistant only: the turn's pieces in order (M91.4), each main-thread
   * call once, by id. Absent on a reply no piece reached, and on threads
   * saved before M91.4. Reasoning is memory only. */
  parts?: MessagePart[];
  /** Assistant only: where a conversation can branch from this turn
   * (M91.4): its session and the uuid of its last main-thread assistant
   * line, as its TurnEnded named it. */
  anchor?: { sessionId: string; uuid: string };
  /**
   * Assistant only, in memory only: what the reducer keeps while a turn is
   * live (`transcript.ts`) — the last message's text, every message's text,
   * and whether the turn has ended; the text part the deltas stream into
   * (M91.4); and, per thread (keyed by its Agent call, '' for the main one),
   * the message its last text part holds and its last recorded time. Never
   * persisted.
   */
  live?: {
    messageId: string | null;
    finalText: string;
    allText: string;
    ended: boolean;
    openText?: string;
    textOf?: Record<string, string>;
    lastAt?: Record<string, string>;
  };
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
 * in Settings by two ceilings: the shell's, off, ask or on (M57.2), and the
 * web's, off or on (M57.7), which `shared/policy/tool-approval.v1.json`
 * turns into what each run may run, ask about or is refused.
 *
 * Enforcement lives in Rust, not here: a tool the agent never receives is a
 * rule, a tool it receives and is asked not to use is a suggestion.
 */
export interface AgentPolicy {
  /** The shell ceiling: what the CLI's own shell and file tools may do. */
  shell: ShellCeiling;
  /** The web ceiling (M57.7): may runs hold WebFetch and WebSearch? */
  web: boolean;
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
