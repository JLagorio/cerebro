/**
 * The data shapes behind the assistant's AI elements (M91.10). Pure: no DOM,
 * no store, no IPC. They live in the engine so its parsers can read them; the
 * agent layer imports them from here, never the other way round.
 *
 * Two kinds of shape live here. The wire shapes are `ToolResult.data` as the
 * M91 plan's §3.1 spells it, what Rust's fold sends beside a tool's text:
 * snake_case, tagged by `type`, an absent field left out rather than sent as
 * null. The reduced shapes are what the elements draw: camelCase, and still
 * absent where nothing was reported (CV-05), never 0.
 */

/** A shell call's output: the LAST 2000 characters of each stream, since
 * runners print their summary last. `truncated` says a stream was cut at its
 * head, so its first line may be a fragment. */
export interface ShellResultData {
  type: 'shell';
  stdout: string;
  stderr: string;
  interrupted: boolean;
  truncated: boolean;
}

/** One todo as TodoWrite's result carries it (the CLI's `newTodos`). */
export interface WireTodo {
  content: string;
  status: string;
  active_form?: string;
}

/** The list a TodoWrite call left: at most 100 items of at most 500
 * characters each. */
export interface TodosResultData {
  type: 'todos';
  todos: WireTodo[];
}

/** What a subagent reported when its Agent call returned. Never its tokens
 * (Q7): the fold strips them, and `summary` is its cleaned answer, at most
 * 500 characters. */
export interface AgentResultData {
  type: 'agent';
  agent_id?: string;
  agent_type?: string;
  /** The CLI's own word for how it ended, such as `completed`. */
  status?: string;
  tool_uses?: number;
  duration_ms?: number;
  model?: string;
  summary?: string;
}

export interface WebFetchResultData {
  type: 'web_fetch';
  url: string;
  /** The HTTP status the fetch ended on. */
  code?: number;
  bytes?: number;
  duration_ms?: number;
}

/** A web search's results: at most 20, each an http(s) URL. */
export interface WebSearchResultData {
  type: 'web_search';
  query: string;
  results: { title: string; url: string }[];
}

export type ToolResultData =
  ShellResultData | TodosResultData | AgentResultData | WebFetchResultData | WebSearchResultData;

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** One todo as the Plan and Queue elements draw it. A status this build does
 * not know is kept as the CLI wrote it. */
export interface TodoItem {
  content: string;
  status: TodoStatus | (string & {});
  /** The present-tense form the CLI shows while the item is in progress. */
  activeForm?: string;
}

/** Wire todos as TodoItems. An entry without a string content and status is
 * dropped rather than guessed at. */
export function todoItemsFromWire(todos: readonly WireTodo[]): TodoItem[] {
  return todos.flatMap((todo): TodoItem[] => {
    if (typeof todo?.content !== 'string' || typeof todo.status !== 'string') return [];
    const item: TodoItem = { content: todo.content, status: todo.status };
    if (typeof todo.active_form === 'string') item.activeForm = todo.active_form;
    return [item];
  });
}

/** The words a step's state is drawn in: `ToolStatus` in
 * `src/agent/transcriptRows.ts`, which the engine may not import; the
 * typecheck of types.test.ts fails when the two lists drift apart. */
export type StepStatus =
  'running' | 'done' | 'failed' | 'interrupted' | 'waiting' | 'cancelled' | 'not_run' | 'paused';

/** What a line of a turn's chain of thought is drawn from: a reasoning
 * block, one call, a folded group of calls, or a subagent. */
export type StepKind = 'reasoning' | 'tool' | 'group' | 'subagent';

/** One line of a turn's chain of thought, as `summarizeSteps` reads it. */
export interface StepInput {
  kind: StepKind;
  status: StepStatus;
  /** It sits inside the chain's fold rather than as a top-level line. */
  folds: boolean;
}

/** A subagent a run started, as the Subagent element draws it. */
export interface SubagentSummary {
  /** The CLI's id for it, once reported. */
  agentId?: string;
  /** The Agent call's `subagent_type`. */
  type: string;
  /** The Agent call's `description`: what it was asked to do. */
  description: string;
  status: StepStatus;
  toolUses?: number;
  durationMs?: number;
  /** Its cleaned answer, at most 500 characters. */
  summary?: string;
  model?: string;
}

/** How a reply met a source: a search result, a fetched page, a vault page a
 * call read, or a link in the reply's own text. */
export type SourceVia = 'search' | 'fetch' | 'read' | 'text';

/** A source a reply drew on. Only an http(s) URL is ever a `url`; a vault
 * page is its path, opened inside the app and never through an href (CV-16). */
export type SourceRef =
  | { kind: 'url'; url: string; path?: undefined; title?: string; via: SourceVia }
  | { kind: 'vault'; path: string; url?: undefined; title?: string; via: SourceVia };
