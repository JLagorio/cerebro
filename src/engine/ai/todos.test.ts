import { describe, expect, it } from 'vitest';
import { latestTodos, todoCounts, todosFromInput, type TodoWriteCall } from './todos';
import type { TodosResultData } from './types';

const input = (...todos: [content: string, status: string, activeForm?: string][]) => ({
  todos: todos.map(([content, status, activeForm]) => ({ content, status, activeForm })),
});
const result = (...todos: [content: string, status: string][]): TodosResultData => ({
  type: 'todos',
  todos: todos.map(([content, status]) => ({ content, status, active_form: `Doing ${content}` })),
});

describe('latestTodos', () => {
  it('is the list the last write left, with its counts', () => {
    const calls: TodoWriteCall[] = [
      {
        input: input(
          ['Read the plan', 'in_progress', 'Reading the plan'],
          ['Write tests', 'pending'],
        ),
      },
      {
        input: input(
          ['Read the plan', 'completed', 'Reading the plan'],
          ['Write tests', 'in_progress', 'Writing tests'],
          ['Run the gate', 'pending', 'Running the gate'],
        ),
      },
    ];
    expect(latestTodos(calls)).toEqual({
      todos: [
        { content: 'Read the plan', status: 'completed', activeForm: 'Reading the plan' },
        { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
        { content: 'Run the gate', status: 'pending', activeForm: 'Running the gate' },
      ],
      counts: { done: 1, total: 3, inProgress: 1 },
    });
  });

  it("takes a call's result over its input: the result is what the CLI kept", () => {
    const list = latestTodos([
      {
        input: input(['Draft…', 'pending']),
        result: result(['Draft the whole long item', 'pending']),
      },
    ]);
    expect(list?.todos).toEqual([
      {
        content: 'Draft the whole long item',
        status: 'pending',
        activeForm: 'Doing Draft the whole long item',
      },
    ]);
  });

  it('skips a write that failed, which changed nothing', () => {
    const list = latestTodos([
      { input: input(['One', 'completed']) },
      { input: input(['Two', 'pending']), failed: true },
    ]);
    expect(list?.todos.map((t) => t.content)).toEqual(['One']);
  });

  it('reads JSON text, and falls back past a write it cannot read', () => {
    const list = latestTodos([
      { input: JSON.stringify(input(['From text', 'in_progress'])) },
      { input: '{"todos": "not a list"}' },
      { input: '{not json' },
    ]);
    expect(list?.todos).toEqual([{ content: 'From text', status: 'in_progress' }]);
  });

  it('keeps a written empty list as empty, and has no list when nothing was written', () => {
    expect(latestTodos([{ input: input(['One', 'pending']) }, { input: { todos: [] } }])).toEqual({
      todos: [],
      counts: { done: 0, total: 0, inProgress: 0 },
    });
    expect(latestTodos([])).toBeNull();
    expect(
      latestTodos([{ input: null }, { failed: true, input: input(['x', 'pending']) }]),
    ).toBeNull();
  });
});

describe('todosFromInput', () => {
  it('drops items without a string content and status, and keeps a status it does not know', () => {
    expect(
      todosFromInput({
        todos: [
          { content: 'Keep', status: 'blocked', activeForm: 7 },
          { content: 'No status' },
          { status: 'pending' },
          null,
          'text',
        ],
      }),
    ).toEqual([{ content: 'Keep', status: 'blocked' }]);
    expect(todosFromInput(undefined)).toBeNull();
    expect(todosFromInput([])).toBeNull();
  });
});

describe('todoCounts', () => {
  it('counts a status it does not know only in the total', () => {
    expect(
      todoCounts([
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'blocked' },
        { content: 'c', status: 'in_progress' },
      ]),
    ).toEqual({ done: 1, total: 3, inProgress: 1 });
  });
});
