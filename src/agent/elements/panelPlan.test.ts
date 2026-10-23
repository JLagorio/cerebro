import { describe, expect, it } from 'vitest';
import { livePlan } from '@/agent/elements/panelPlan';
import type { ChatMessage, ToolCall } from '@/agent/types';
import type { TodoItem } from '@/engine/ai/types';

/**
 * The dock's live plan (M91.12c): the live reply's latest readable
 * TodoWrite list, split into what is left and what is done, only while a
 * turn is in flight and only when the list holds something.
 */

const todo = (content: string, status: string, activeForm?: string): TodoItem =>
  activeForm === undefined ? { content, status } : { content, status, activeForm };

const LIST = [
  todo('List the open risks', 'completed', 'Listing the open risks'),
  todo('Read the dated risks', 'in_progress', 'Reading the dated risks'),
  todo('Name the risk to escalate', 'pending', 'Naming the risk to escalate'),
];

/** A TodoWrite call as the reducer keeps it: its input, and its result
 * once the fold read one. */
function write(id: string, todos: TodoItem[], over: Partial<ToolCall> = {}): ToolCall {
  return {
    id,
    name: 'TodoWrite',
    input: JSON.stringify({ todos }),
    output: null,
    done: true,
    failed: false,
    ...over,
  };
}

const read = (id: string): ToolCall => ({
  id,
  name: 'mcp__cerebro__get_note',
  input: JSON.stringify({ path: 'notes/plan.md' }),
  output: '# Plan',
  done: true,
  failed: false,
});

const asked: ChatMessage = { id: 'u-1', role: 'user', text: 'Make a todo list', tools: [] };
const reply = (tools: ToolCall[], streaming = true): ChatMessage => ({
  id: 'a-1',
  role: 'assistant',
  text: '',
  tools,
  streaming,
});

describe('livePlan', () => {
  it('splits the live reply’s list into what is left and what is done, in order', () => {
    expect(livePlan([asked, reply([write('t-1', LIST)])], true)).toEqual({
      todo: [LIST[1], LIST[2]],
      done: [LIST[0]],
    });
  });

  it('reads the latest readable write: a failed or refused one wrote nothing', () => {
    const first = LIST.map((item) => ({ ...item, status: 'pending' }));
    const plan = livePlan(
      [
        asked,
        reply([
          write('t-1', first),
          read('r-1'),
          write('t-2', LIST),
          write('t-3', [], { failed: true }),
          write('t-4', [], { denied: 'Permission to use TodoWrite has been denied.' }),
        ]),
      ],
      true,
    );
    expect(plan?.done).toEqual([LIST[0]]);
  });

  it('takes the list the CLI kept over the input that asked for it', () => {
    const kept = [todo('Kept item', 'pending')];
    const call = write('t-1', LIST, {
      result: { type: 'todos', todos: [{ content: 'Kept item', status: 'pending' }] },
    });
    expect(livePlan([asked, reply([call])], true)).toEqual({ todo: kept, done: [] });
  });

  it('keeps a status this build does not know with what is left', () => {
    const odd = [todo('Wait on review', 'in_review'), todo('Ship', 'completed')];
    expect(livePlan([asked, reply([write('t-1', odd)])], true)).toEqual({
      todo: [odd[0]],
      done: [odd[1]],
    });
  });

  it('is no plan while no turn is in flight, even over a reply still marked streaming', () => {
    expect(livePlan([asked, reply([write('t-1', LIST)])], false)).toBeNull();
  });

  it('keeps the plan while the turn waits on the person: a deferral ended the bubble’s stream', () => {
    // A deferral's Done runs endLiveTurn on the reply while the turn stays
    // in flight, waiting on the card; the dock must still show the plan.
    expect(livePlan([asked, reply([write('t-1', LIST)], false)], true)).toEqual({
      todo: [LIST[1], LIST[2]],
      done: [LIST[0]],
    });
  });

  it('is no plan before the turn’s reply exists: the last message is the person’s', () => {
    const earlier: ChatMessage = { ...reply([write('t-0', LIST)], false), id: 'a-0' };
    expect(livePlan([earlier, asked], true)).toBeNull();
  });

  it('is no plan for a reply that wrote none, an empty one, or none that reads', () => {
    expect(livePlan([asked, reply([read('r-1')])], true)).toBeNull();
    expect(livePlan([asked, reply([write('t-1', [])])], true)).toBeNull();
    expect(livePlan([asked, reply([write('t-1', LIST, { failed: true })])], true)).toBeNull();
    expect(
      livePlan([asked, reply([{ ...write('t-1', LIST), input: '{"todos": [' }])], true),
    ).toBeNull();
    expect(livePlan([], true)).toBeNull();
  });

  it('reads only the live reply, never an earlier turn’s list', () => {
    const earlier: ChatMessage = { ...reply([write('t-0', LIST)], false), id: 'a-0' };
    expect(livePlan([earlier, asked, reply([read('r-1')])], true)).toBeNull();
  });

  it('leaves a subagent’s own calls to it: only the main thread’s writes are the plan', () => {
    const agent: ToolCall = {
      id: 'agent-1',
      name: 'Agent',
      input: JSON.stringify({ description: 'Read the risks', prompt: 'x' }),
      output: null,
      done: false,
      failed: false,
      subagent: {
        type: 'cerebro-researcher',
        description: 'Read the risks',
        status: 'running',
        parts: [],
        tools: [write('t-sub', LIST, { parent: 'agent-1' })],
      },
    };
    expect(livePlan([asked, reply([agent])], true)).toBeNull();
  });
});
