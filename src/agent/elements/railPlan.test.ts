import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cutByPreview, INPUT_PREVIEW_CHARS, railPlan } from '@/agent/elements/railPlan';
import { applyEvent, endLiveTurn } from '@/agent/transcript';
import type { AgentStreamEvent, ChatMessage, ToolCall } from '@/agent/types';
import type { TranscriptStatus } from '@/agent/useConversations';
import type { TodoItem } from '@/engine/ai/types';

/**
 * The rail's plan (M92.17, Q11): the latest readable todo list across the
 * conversation's replies, kept once its turn is done, the same plan while a
 * turn streams words, and honest where the thread did not keep the list
 * whole (CV-05).
 */

const todo = (content: string, status: string, activeForm?: string): TodoItem =>
  activeForm === undefined ? { content, status } : { content, status, activeForm };

const FIRST = [
  todo('Read the open risks', 'in_progress', 'Reading the open risks'),
  todo('Draft the escalation note', 'pending', 'Drafting the escalation note'),
];
const LIST = [
  todo('Read the open risks', 'completed', 'Reading the open risks'),
  todo('Draft the escalation note', 'in_progress', 'Drafting the escalation note'),
  todo('Link the note from the launch page', 'pending', 'Linking the note'),
];

/** A TodoWrite call as a thread holds it: its input, done. */
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
  input: JSON.stringify({ path: 'records/risks/risk-scanner-delivery.md' }),
  output: '# Scanner hardware delivery is slipping',
  done: true,
  failed: false,
});

const asked = (id: string): ChatMessage => ({ id, role: 'user', text: 'Plan it', tools: [] });
const reply = (id: string, tools: ToolCall[], over: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: 'assistant',
  text: '',
  tools,
  ...over,
});

const READING: TranscriptStatus = { state: 'reading' };
const unavailable = (reason: string): TranscriptStatus => ({
  state: 'unavailable',
  reason,
  retentionDays: 30,
});

/** A todo's words past what a call's preview keeps, and as the preview
 *  keeps them: cut, the cut marked. */
const DICTATED = `Draft the escalation note for the scanner risk, ${'naming every milestone it moves, '.repeat(6)}`;
const CUT_DICTATED = `${DICTATED.slice(0, INPUT_PREVIEW_CHARS)}…`;

/** The preview of a list holding the dictated step: what a thread saves. */
function savedCut(id: string, over: Partial<ToolCall> = {}): ToolCall {
  const whole = [todo(DICTATED, 'in_progress', 'Drafting the note'), LIST[2]];
  return write(id, whole, {
    input: JSON.stringify({ todos: [{ ...whole[0], content: CUT_DICTATED }, whole[1]] }),
    ...over,
  });
}

describe('railPlan', () => {
  it('is the latest list any reply left, across the conversation’s turns', () => {
    const plan = railPlan([
      asked('u1'),
      reply('a1', [write('t1', FIRST)]),
      asked('u2'),
      reply('a2', [read('r1'), write('t2', LIST)]),
    ]);
    expect(plan.state).toBe('ready');
    expect(plan.list?.todos).toEqual(LIST);
    expect(plan.list?.counts).toEqual({ done: 1, total: 3, inProgress: 1 });
    expect(plan.list?.todo).toEqual([LIST[1], LIST[2]]);
    expect(plan.list?.done).toEqual([LIST[0]]);
    expect(plan.current).toBe(true);
  });

  it('keeps an earlier reply’s list while later replies write none, as no longer the turn at work’s', () => {
    const earlier = [asked('u1'), reply('a1', [write('t1', LIST)])];
    for (const messages of [
      [...earlier, asked('u2'), reply('a2', [read('r1')])],
      // A turn just sent: no reply of its own yet.
      [...earlier, asked('u2')],
    ]) {
      const plan = railPlan(messages);
      expect(plan.state).toBe('ready');
      expect(plan.list?.todos).toEqual(LIST);
      expect(plan.current).toBe(false);
    }
  });

  it('keeps the list once its turn is done, where the dock lets it go', () => {
    const events: AgentStreamEvent[] = [
      {
        kind: 'ToolStart',
        tool_name: 'TodoWrite',
        tool_id: 't1',
        input: JSON.stringify({ todos: LIST }),
      },
      { kind: 'ToolDone', tool_id: 't1', output: 'Todos have been modified', is_error: false },
      { kind: 'Text', message_id: 'm1', text: 'Drafting the note now.' },
      { kind: 'TurnEnded', stop_reason: 'end_turn' },
    ];
    let live = reply('a1', [], { streaming: true });
    for (const event of events) live = applyEvent(live, event, 'live');
    const working = railPlan([asked('u1'), live]);
    expect(working.state).toBe('ready');
    expect(working.current).toBe(true);

    const done = railPlan([asked('u1'), endLiveTurn(live)]);
    expect(done).toBe(working);

    const next = railPlan([asked('u1'), endLiveTurn(live), asked('u2')]);
    expect(next.state).toBe('ready');
    expect(next.list?.todos).toEqual(LIST);
    expect(next.current).toBe(false);
  });

  it('hands the card the same plan across 50 streamed words, and a new one for a new list', () => {
    let live = reply('a1', [], { streaming: true });
    const step = (event: AgentStreamEvent) => {
      live = applyEvent(live, event, 'live');
      return railPlan([asked('u1'), live]);
    };
    step({
      kind: 'ToolStart',
      tool_name: 'TodoWrite',
      tool_id: 't1',
      input: JSON.stringify({ todos: FIRST }),
    });
    const first = step({ kind: 'ToolDone', tool_id: 't1', output: 'ok', is_error: false });
    expect(first.list?.todos).toEqual(FIRST);
    const calls = live.tools;
    for (let word = 0; word < 50; word += 1) {
      const plan = step({ kind: 'TextDelta', text: `word ${word} ` });
      expect(plan).toBe(first);
      expect(plan.list?.todo).toBe(first.list?.todo);
    }
    // The reply's calls never changed: a word is not a call.
    expect(live.tools).toBe(calls);
    expect(live.text).toContain('word 49');

    // Another call starting keeps the list call as it was.
    const reading = step({
      kind: 'ToolStart',
      tool_name: 'mcp__cerebro__get_note',
      tool_id: 'r1',
      input: '{}',
    });
    expect(live.tools).not.toBe(calls);
    expect(reading).toBe(first);

    step({
      kind: 'ToolStart',
      tool_name: 'TodoWrite',
      tool_id: 't2',
      input: JSON.stringify({ todos: LIST }),
    });
    const next = step({ kind: 'ToolDone', tool_id: 't2', output: 'ok', is_error: false });
    expect(next).not.toBe(first);
    expect(next.list?.todos).toEqual(LIST);
  });

  it('reads a saved list whose input the preview cut as not recorded, never as the list', () => {
    const plan = railPlan([asked('u1'), reply('a1', [savedCut('t1')])]);
    expect(plan.state).toBe('not-recorded');
    expect(plan.list).toBeNull();
    // An earlier whole list does not stand in for it.
    expect(
      railPlan([
        asked('u0'),
        reply('a0', [write('t0', LIST)]),
        asked('u1'),
        reply('a1', [savedCut('t1')]),
      ]).state,
    ).toBe('not-recorded');
  });

  it('reads the same list whole where the whole input or the kept list is there', () => {
    const whole = JSON.stringify({ todos: [todo(DICTATED, 'in_progress'), LIST[2]] });
    const live = railPlan([
      asked('u1'),
      reply('a1', [savedCut('t1', { payload: { input: whole, inputBytes: whole.length } })]),
    ]);
    expect(live.state).toBe('ready');
    expect(live.list?.todo[0].content).toBe(DICTATED);

    const kept = railPlan([
      asked('u1'),
      reply('a1', [
        savedCut('t1', {
          result: { type: 'todos', todos: [{ content: DICTATED, status: 'in_progress' }] },
        }),
      ]),
    ]);
    expect(kept.state).toBe('ready');
    expect(kept.list?.todos).toEqual([todo(DICTATED, 'in_progress')]);

    // A call still running in the reply that streams takes its whole input
    // next.
    const starting = railPlan([
      asked('u1'),
      reply('a1', [savedCut('t1', { done: false })], { streaming: true }),
    ]);
    expect(starting.state).toBe('ready');
  });

  it('reads a cut call a stopped or saved reply left running as not recorded', () => {
    // The turn was stopped between the call's start and its whole input, or
    // the thread saved it so: the whole input never comes.
    const stopped = railPlan([
      asked('u1'),
      reply('a1', [savedCut('t1', { done: false })], { interrupted: true }),
    ]);
    expect(stopped.state).toBe('not-recorded');
    expect(stopped.list).toBeNull();
  });

  it('reads an ellipsis the agent wrote itself as its words', () => {
    const plan = railPlan([
      asked('u1'),
      reply('a1', [write('t1', [todo('Wait for the vendor…', 'in_progress', 'Waiting…')])]),
    ]);
    expect(plan.state).toBe('ready');
  });

  it('skips a write that failed or that Claude Code refused, and a subagent’s own', () => {
    const agent: ToolCall = {
      id: 'agent-1',
      name: 'Agent',
      input: JSON.stringify({ description: 'Read the risks', prompt: 'x' }),
      output: null,
      done: true,
      failed: false,
      subagent: {
        type: 'cerebro-researcher',
        description: 'Read the risks',
        status: 'done',
        parts: [],
        tools: [write('t-sub', FIRST, { parent: 'agent-1' })],
      },
    };
    const plan = railPlan([
      asked('u1'),
      reply('a1', [
        write('t1', LIST),
        write('t2', FIRST, { failed: true }),
        write('t3', FIRST, { denied: 'Permission to use TodoWrite has been denied.' }),
        agent,
      ]),
    ]);
    expect(plan.state).toBe('ready');
    expect(plan.list?.todos).toEqual(LIST);
  });

  it('shows the list before a latest write that does not read, as an earlier one', () => {
    const unreadable = write('t2', [], { input: '{"todos": [' });
    for (const messages of [
      [asked('u1'), reply('a1', [write('t1', LIST), unreadable])],
      [asked('u1'), reply('a1', [write('t1', LIST)]), asked('u2'), reply('a2', [unreadable])],
    ]) {
      const plan = railPlan(messages);
      expect(plan.state).toBe('partial');
      expect(plan.list?.todos).toEqual(LIST);
      expect(plan.current).toBe(false);
    }
    // A whole input the payload cap cut is no list either.
    const capped = write('t2', [], {
      payload: { input: '{"todos":[{"content":"Fold in the log', inputTruncated: true },
    });
    expect(railPlan([asked('u1'), reply('a1', [write('t1', LIST), capped])]).state).toBe('partial');
  });

  it('reads a latest write that does not read, with no list before it, as not recorded', () => {
    const unreadable = write('t1', [], { input: null });
    expect(railPlan([asked('u1'), reply('a1', [unreadable])]).state).toBe('not-recorded');
    expect(
      railPlan([asked('u1'), reply('a1', [savedCut('t1'), write('t2', [], { input: '[' })])]).state,
    ).toBe('not-recorded');
  });

  it('is empty with no list written, and empty with its list when the agent wrote an empty one', () => {
    expect(railPlan([])).toEqual({ state: 'empty', list: null, current: false });
    expect(railPlan([asked('u1'), reply('a1', [read('r1')])])).toEqual({
      state: 'empty',
      list: null,
      current: false,
    });
    const cleared = railPlan([asked('u1'), reply('a1', [write('t1', LIST), write('t2', [])])]);
    expect(cleared.state).toBe('empty');
    expect(cleared.list?.todos).toEqual([]);
  });

  it('waits on the transcript only where the thread holds nothing to show', () => {
    const nothing: ChatMessage[] = [];
    expect(railPlan(nothing, READING).state).toBe('reading');
    expect(railPlan(nothing, unavailable('unreadable')).state).toBe('unavailable');
    expect(railPlan(nothing, unavailable('a reason this build has no name for')).state).toBe(
      'unavailable',
    );
    expect(railPlan(nothing, unavailable('cleared')).state).toBe('not-recorded');
    expect(railPlan(nothing, unavailable('expired')).state).toBe('not-recorded');
    expect(railPlan(nothing, unavailable('not_recorded')).state).toBe('not-recorded');
    expect(railPlan(nothing, { state: 'rebuilt' }).state).toBe('empty');

    const cut = [asked('u1'), reply('a1', [savedCut('t1')])];
    expect(railPlan(cut, READING).state).toBe('reading');
    expect(railPlan(cut, unavailable('unreadable')).state).toBe('unavailable');
    expect(railPlan(cut, unavailable('cleared')).state).toBe('not-recorded');

    // The thread holds every call its replies made: one that wrote no list
    // wrote none, and one that wrote a list shows it, whatever the file says.
    const none = [asked('u1'), reply('a1', [read('r1')])];
    expect(railPlan(none, unavailable('unreadable')).state).toBe('empty');
    expect(railPlan(none, READING).state).toBe('empty');
    const listed = [asked('u1'), reply('a1', [write('t1', LIST)])];
    expect(railPlan(listed, unavailable('unreadable')).state).toBe('ready');
    expect(railPlan(listed, READING).state).toBe('ready');
  });
});

describe('cutByPreview', () => {
  it('reads the cut the fold made as a cut, and a string it kept as whole', () => {
    // The goldens are Rust's: fold.rs writes them from the recorded streams.
    const golden = JSON.parse(
      readFileSync(join(__dirname, '../../../conformance/transcript/long-payload.json'), 'utf8'),
    ) as { streams: { events: AgentStreamEvent[] }[] };
    const start = golden.streams[0].events.find(
      (event) => event.kind === 'ToolStart' && event.tool_name.endsWith('write_concept'),
    );
    const input = JSON.parse(start?.kind === 'ToolStart' ? (start.input ?? '{}') : '{}') as Record<
      string,
      string
    >;
    expect(cutByPreview(input.body)).toBe(true);
    expect(cutByPreview(input.description)).toBe(false);
    expect(cutByPreview(input.title)).toBe(false);
  });

  it('counts as Rust counts, by character, and wants the ellipsis', () => {
    expect(cutByPreview(`${'a'.repeat(INPUT_PREVIEW_CHARS)}…`)).toBe(true);
    expect(cutByPreview(`${'🙂'.repeat(INPUT_PREVIEW_CHARS)}…`)).toBe(true);
    expect(cutByPreview('a'.repeat(INPUT_PREVIEW_CHARS + 1))).toBe(false);
    expect(cutByPreview(`${'a'.repeat(INPUT_PREVIEW_CHARS + 1)}…`)).toBe(false);
    expect(cutByPreview(`${'a'.repeat(INPUT_PREVIEW_CHARS - 1)}…`)).toBe(false);
    expect(cutByPreview('Waiting…')).toBe(false);
  });
});
