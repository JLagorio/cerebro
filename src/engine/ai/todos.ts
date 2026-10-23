/**
 * The agent's own todo list (M91.10, Q9): what the Plan row and the dock's
 * Queue draw. Pure: no DOM.
 *
 * TodoWrite sends the whole list on every call, so the latest write that can
 * be read is the list. A call that failed wrote nothing, and a write of an
 * empty list is an empty list: no write that can be read is no list (null),
 * never an empty one (CV-05).
 */

import { todoItemsFromWire, type TodoItem, type ToolResultData } from './types';

/** One TodoWrite call as a turn holds it. */
export interface TodoWriteCall {
  /** Its input, `{todos: [{content, status, activeForm}]}`, parsed or as
   * JSON text: the whole input where a preview cut it. */
  input?: unknown;
  /** Its result where the fold read one: the list the CLI kept. */
  result?: ToolResultData | null;
  failed?: boolean;
}

export interface TodoCounts {
  done: number;
  total: number;
  inProgress: number;
}

export interface TodoList {
  todos: TodoItem[];
  counts: TodoCounts;
}

/** The list a TodoWrite input holds, or null when it holds none. Items
 * without a string content and status are dropped. */
export function todosFromInput(input: unknown): TodoItem[] | null {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const todos = (value as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return null;
  return todos.flatMap((todo): TodoItem[] => {
    if (typeof todo !== 'object' || todo === null) return [];
    const { content, status, activeForm } = todo as Record<string, unknown>;
    if (typeof content !== 'string' || typeof status !== 'string') return [];
    const item: TodoItem = { content, status };
    if (typeof activeForm === 'string') item.activeForm = activeForm;
    return [item];
  });
}

export function todoCounts(todos: readonly TodoItem[]): TodoCounts {
  return {
    done: todos.filter((todo) => todo.status === 'completed').length,
    total: todos.length,
    inProgress: todos.filter((todo) => todo.status === 'in_progress').length,
  };
}

/** The list the latest readable write left, or null when no write can be
 * read. A call's result outranks its input: it is what the CLI kept. */
export function latestTodos(calls: readonly TodoWriteCall[]): TodoList | null {
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    if (call.failed === true) continue;
    const todos =
      call.result?.type === 'todos'
        ? todoItemsFromWire(call.result.todos)
        : todosFromInput(call.input);
    if (todos !== null) return { todos, counts: todoCounts(todos) };
  }
  return null;
}
