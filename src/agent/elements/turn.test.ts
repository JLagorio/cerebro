import { describe, expect, it } from 'vitest';
import type { ChatMessage, MessagePart, SubagentRun, ToolCall } from '@/agent/types';
import {
  chainOpens,
  latestTodo,
  subagentItems,
  turnItems,
  turnLines,
  type TurnItem,
  type TurnLine,
} from './turn';

/**
 * A turn's lines (M91.13): its pieces in order, reads folded across the
 * reasoning between them but never across words, one chain holding only
 * reasoning and folded reads, and a subagent's steps without its report
 * drawn twice.
 */

let next = 0;
function call(name: string, over: Partial<ToolCall> = {}): ToolCall {
  next += 1;
  return {
    id: `t-${next}`,
    name: `mcp__cerebro__${name}`,
    input: '{}',
    output: 'ok',
    done: true,
    failed: false,
    ...over,
  };
}

const tool = (call: ToolCall): MessagePart => ({ kind: 'tool', toolId: call.id });
const words = (id: string, text: string): MessagePart => ({ kind: 'text', id, text });
const thought = (id: string, text: string, over: Partial<MessagePart> = {}): MessagePart =>
  ({ kind: 'reasoning', id, text, ...over }) as MessagePart;

function reply(tools: ToolCall[], parts?: MessagePart[], text = ''): ChatMessage {
  return { id: 'r', role: 'assistant', text, tools, ...(parts === undefined ? {} : { parts }) };
}

/** Each item as a short word. */
function shape(items: readonly (TurnItem | TurnLine)[]): string[] {
  return items.map((item) => {
    switch (item.kind) {
      case 'reasoning':
        return `reasoning(${item.part.text})`;
      case 'group':
        return `group(${item.group.label})`;
      case 'row':
        return `${item.row.tool.name.replace('mcp__cerebro__', '')}:${item.row.status}`;
      case 'text':
        return `${item.answer ? 'answer' : 'words'}(${item.text})`;
      case 'chain':
        return `chain[${shape(item.steps).join(', ')}]`;
    }
  });
}

describe('turnItems', () => {
  it('draws a reply saved before M91.4 as it was: its calls, then its words', () => {
    const read = call('search_notes');
    expect(shape(turnItems(reply([read], undefined, 'Two risks.'), { streaming: false }))).toEqual([
      'search_notes:done',
      'answer(Two risks.)',
    ]);
  });

  it('keeps the pieces in order, the last words the answer', () => {
    const write = call('edit_note');
    const parts = [words('text-1', 'Reading first.'), tool(write), words('text-2', 'Edited.')];
    expect(shape(turnItems(reply([write], parts, 'Edited.'), { streaming: false }))).toEqual([
      'words(Reading first.)',
      'edit_note:done',
      'answer(Edited.)',
    ]);
  });

  it('folds reads across the reasoning between them, never across words', () => {
    const [a, b, c, d] = [call('get_note'), call('get_note'), call('get_note'), call('get_note')];
    const parts = [
      thought('reasoning-1', 'First.'),
      tool(a),
      thought('reasoning-2', 'Then.'),
      tool(b),
      words('text-1', 'Now the others.'),
      tool(c),
      tool(d),
    ];
    expect(shape(turnItems(reply([a, b, c, d], parts), { streaming: false }))).toEqual([
      'reasoning(First.)',
      'group(Read 2 notes)',
      'reasoning(Then.)',
      'answer(Now the others.)',
      'group(Read 2 notes)',
    ]);
  });

  it('draws no line for thinking with no words, and keeps withheld or streaming thinking', () => {
    const parts = [
      thought('reasoning-1', ''),
      thought('reasoning-2', '', { redacted: true }),
      thought('reasoning-3', 'Still', { streaming: true }),
    ];
    expect(shape(turnItems(reply([], parts), { streaming: true }))).toEqual([
      'reasoning()',
      'reasoning(Still)',
    ]);
  });

  it('draws a call no part names after the rest, and the text no part holds as the answer', () => {
    const named = call('edit_note');
    const stray = call('create_note');
    expect(
      shape(turnItems(reply([named, stray], [tool(named)], 'Done.'), { streaming: false })),
    ).toEqual(['edit_note:done', 'create_note:done', 'answer(Done.)']);
  });

  it('reads an unfinished call running while the message streams, interrupted once it stops', () => {
    const open = call('edit_note', { done: false, output: null });
    expect(shape(turnItems(reply([open], [tool(open)]), { streaming: true }))).toEqual([
      'edit_note:running',
    ]);
    expect(shape(turnItems(reply([open], [tool(open)]), { streaming: false }))).toEqual([
      'edit_note:interrupted',
    ]);
  });
});

describe('turnLines', () => {
  it('gathers reasoning and folded reads into one chain where the first came', () => {
    const [a, b] = [call('get_note'), call('get_note')];
    const write = call('append_to_note');
    const failed = call('get_note', { failed: true });
    const parts = [
      words('text-1', 'Looking.'),
      thought('reasoning-1', 'Read both.'),
      tool(a),
      tool(b),
      tool(write),
      thought('reasoning-2', 'One is gone.'),
      tool(failed),
      words('text-2', 'Done.'),
    ];
    const lines = turnLines(turnItems(reply([a, b, write, failed], parts), { streaming: false }));
    expect(shape(lines)).toEqual([
      'words(Looking.)',
      'chain[reasoning(Read both.), group(Read 2 notes), reasoning(One is gone.)]',
      'append_to_note:done',
      'get_note:failed',
      'answer(Done.)',
    ]);
    // It counts every step the turn took, inside the chain or not.
    const chain = lines[1] as Extract<TurnLine, { kind: 'chain' }>;
    expect(chain.summary).toEqual({ running: false, total: 5, failed: 1, folded: 3 });
  });

  it('draws no chain when nothing folds', () => {
    const write = call('edit_note');
    expect(
      shape(turnLines(turnItems(reply([write], [tool(write)]), { streaming: false }))),
    ).toEqual(['edit_note:done']);
  });

  it('draws no chain for a turn that did no thinking: its folded reads stand as they are', () => {
    const [a, b] = [call('get_note'), call('get_note')];
    const write = call('edit_note');
    const parts = [tool(a), tool(b), tool(write)];
    expect(shape(turnLines(turnItems(reply([a, b, write], parts), { streaming: false })))).toEqual([
      'group(Read 2 notes)',
      'edit_note:done',
    ]);
  });

  it('counts a subagent as a step of its own kind', () => {
    const agent: ToolCall = { ...call('x'), name: 'Agent' };
    const lines = turnLines(
      turnItems(reply([agent], [thought('reasoning-1', 'Delegate.'), tool(agent)]), {
        streaming: false,
      }),
    );
    expect(shape(lines)).toEqual(['chain[reasoning(Delegate.)]', 'Agent:done']);
  });
});

describe('chainOpens', () => {
  const summary = { running: false, total: 3, failed: 0, folded: 2 };
  it('opens the latest turn, one at work, and one holding a failure', () => {
    expect(chainOpens(summary, true)).toBe(true);
    expect(chainOpens(summary, false)).toBe(false);
    expect(chainOpens({ ...summary, running: true }, false)).toBe(true);
    expect(chainOpens({ ...summary, failed: 1 }, false)).toBe(true);
  });
});

describe('latestTodo', () => {
  it('names the thread’s last todo list call, or none', () => {
    const first: ToolCall = { ...call('x'), name: 'TodoWrite' };
    const last: ToolCall = { ...call('x'), name: 'TodoWrite' };
    expect(latestTodo([first, call('get_note'), last, call('get_note')])).toBe(last.id);
    expect(latestTodo([call('get_note')])).toBeNull();
  });
});

describe('subagentItems', () => {
  function run(over: Partial<SubagentRun> = {}): SubagentRun {
    const read = call('search_notes');
    return {
      type: 'cerebro-researcher',
      description: 'Read the risks',
      status: 'done',
      parts: [thought('a:reasoning-1', 'Find them.'), tool(read), words('a:text-1', 'Found two.')],
      tools: [read],
      ...over,
    };
  }

  it('draws its steps in order, its report said once by its summary', () => {
    expect(shape(subagentItems(run({ summary: 'Found two.' }), { streaming: false }))).toEqual([
      'reasoning(Find them.)',
      'search_notes:done',
    ]);
    expect(shape(subagentItems(run(), { streaming: false }))).toEqual([
      'reasoning(Find them.)',
      'search_notes:done',
      'words(Found two.)',
    ]);
  });

  it('runs its calls only while it works', () => {
    const open = call('get_note', { done: false, output: null });
    const parts = [tool(open)];
    expect(
      shape(subagentItems(run({ status: 'running', parts, tools: [open] }), { streaming: true })),
    ).toEqual(['get_note:running']);
    expect(
      shape(
        subagentItems(run({ status: 'interrupted', parts, tools: [open] }), { streaming: true }),
      ),
    ).toEqual(['get_note:interrupted']);
  });
});
