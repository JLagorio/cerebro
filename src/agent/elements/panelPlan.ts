import type { ChatMessage, ToolCall } from '@/agent/types';
import { latestTodos, type TodoWriteCall } from '@/engine/ai/todos';
import type { TodoItem } from '@/engine/ai/types';
import { toolRenderer } from '@/engine/tools';

/**
 * The dock's live plan (M91.12c, Q9): the todo list the turn at work is
 * following, as the reducer kept its reply's calls (transcript.ts), split
 * the way the dock's Queue draws it. Pure.
 *
 * The list is the latest one the live reply's own TodoWrite calls left
 * that can be read (engine/ai/todos.ts): the manifest's `todo` renderer names
 * those calls (CV-04), a subagent's calls are its own, and a call that failed
 * or that Claude Code refused wrote nothing. It shows only while a turn is in
 * flight and only when the list holds something: a reply that wrote none, or
 * wrote an empty one, gives the dock no plan (CV-05), and the reply's own
 * Plan line keeps the list in the transcript once the turn is done.
 */

export interface LivePlan {
  /** What is left, in the list's order: in progress, to do, and any status
   * this build does not know. */
  todo: TodoItem[];
  /** What is done, in the list's order. */
  done: TodoItem[];
}

/** One of the reply's calls as a write the plan can be read from. */
function writeOf(tool: ToolCall): TodoWriteCall {
  return {
    input: tool.payload?.input ?? tool.input,
    result: tool.result ?? null,
    failed: tool.failed || tool.denied !== undefined,
  };
}

/**
 * The turn in flight's reply: the last assistant message after the last
 * user message, or null. Not only one still streaming: a deferral's Done
 * ends the bubble's stream while its turn waits on the person, and the plan
 * must stay in the dock exactly then.
 */
function liveReply(messages: readonly ChatMessage[]): ChatMessage | null {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at];
    if (message.role === 'user') return null;
    if (message.role === 'assistant') return message;
  }
  return null;
}

/**
 * The plan the dock shows, or null: while `inFlight` (a turn runs, waits on
 * the person or stops) and the live reply's latest readable list holds
 * an item.
 */
export function livePlan(messages: readonly ChatMessage[], inFlight: boolean): LivePlan | null {
  if (!inFlight) return null;
  const reply = liveReply(messages);
  if (reply === null) return null;
  const list = latestTodos(
    reply.tools.filter((tool) => toolRenderer(tool.name) === 'todo').map(writeOf),
  );
  if (list === null || list.todos.length === 0) return null;
  return {
    todo: list.todos.filter((todo) => todo.status !== 'completed'),
    done: list.todos.filter((todo) => todo.status === 'completed'),
  };
}
