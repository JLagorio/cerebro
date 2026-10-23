import { describe, expect, it } from 'vitest';
import { railSubagents } from '@/agent/elements/railSubagents';
import { applyEvent, endLiveTurn, replayTranscript } from '@/agent/transcript';
import type { AgentStreamEvent, ChatMessage } from '@/agent/types';

/**
 * The rail's Subagents rows (M92.4): the conversation's main-thread Agent
 * calls as Claude Code reported them, read off the manifest's `subagent`
 * renderer, and the same object for as long as no reply's calls change.
 */

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';

const ask = (id: string, text: string): ChatMessage => ({ id, role: 'user', text, tools: [] });

/** A reply as the reducer builds it from a live stream, still streaming. */
function live(events: AgentStreamEvent[], id = 'reply'): ChatMessage {
  let message: ChatMessage = { id, role: 'assistant', text: '', tools: [], streaming: true };
  for (const event of events) message = applyEvent(message, event, 'live', SESSION);
  return message;
}

/** An Agent call as it starts, under the CLI's name or its alias. */
function agent(
  id: string,
  description: string,
  type = 'cerebro-researcher',
  name = 'Agent',
): AgentStreamEvent {
  return {
    kind: 'ToolStart',
    tool_name: name,
    tool_id: id,
    input: JSON.stringify({ description, subagent_type: type, prompt: `${description}.` }),
  };
}

/** A subagent's own call, and its return. */
const step = (parent: string, id: string): AgentStreamEvent[] => [
  {
    kind: 'ToolStart',
    tool_name: 'mcp__cerebro__get_note',
    tool_id: id,
    input: '{"path":"notes/risks.md"}',
    parent,
  },
  { kind: 'ToolDone', tool_id: id, output: 'Five risks.', parent },
];

const reported = (id: string, toolUses: number, ms: number): AgentStreamEvent[] => [
  { kind: 'ToolDone', tool_id: id, output: 'Found it.' },
  {
    kind: 'ToolResult',
    tool_id: id,
    data: { type: 'agent', status: 'completed', tool_uses: toolUses, duration_ms: ms },
  },
];

describe('railSubagents', () => {
  it('lists each main-thread Agent call, in order, as reported, never its tokens', () => {
    const reply = live([
      agent('a-1', 'Read the open risks'),
      ...step('a-1', 's-1'),
      ...reported('a-1', 3, 4100),
      {
        kind: 'ToolStart',
        tool_name: 'mcp__cerebro__search_notes',
        tool_id: 'read-1',
        input: '{"query":"x"}',
      },
      { kind: 'ToolDone', tool_id: 'read-1', output: 'none' },
      agent('a-2', 'Check the dates', 'Explore', 'Task'),
    ]);
    const { rows, held } = railSubagents([ask('u', 'Research it'), reply]);
    expect(held).toBe(true);
    expect(rows).toEqual([
      {
        toolId: 'a-1',
        type: 'cerebro-researcher',
        description: 'Read the open risks',
        state: 'done',
        toolUses: 3,
        durationMs: 4100,
      },
      { toolId: 'a-2', type: 'Explore', description: 'Check the dates', state: 'running' },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/token/i);
  });

  it('keeps a subagent’s own Agent call out: only the main thread’s are listed', () => {
    const reply = live([
      agent('a-1', 'Read the open risks'),
      { ...agent('a-nested', 'Look deeper'), parent: 'a-1' } as AgentStreamEvent,
    ]);
    expect(railSubagents([reply]).rows.map((row) => row.toolId)).toEqual(['a-1']);
  });

  it('keeps a call Claude Code refused denied, never failed', () => {
    const reply = live([
      agent('a-1', 'Read the open risks'),
      {
        kind: 'ToolDenied',
        tool_id: 'a-1',
        tool_name: 'Agent',
        message: "Permission to use Agent has been denied by permission rule 'Agent'.",
      },
      { kind: 'ToolDone', tool_id: 'a-1', output: 'denied', is_error: true },
      agent('a-2', 'Check the dates'),
      { kind: 'Error', message: 'API Error: 529 overloaded', parent: 'a-2' },
      { kind: 'ToolDone', tool_id: 'a-2', output: 'failed', is_error: true },
    ]);
    expect(reply.tools[0].subagent?.status).toBe('failed');
    expect(railSubagents([reply]).rows.map((row) => [row.toolId, row.state])).toEqual([
      ['a-1', 'denied'],
      ['a-2', 'failed'],
    ]);
  });

  it('says what one is doing now only while it runs in a reply that streams', () => {
    const running = live([
      agent('a-1', 'Read the open risks'),
      {
        kind: 'SubagentProgress',
        tool_id: 'a-1',
        description: 'Reading notes/risks.md',
        last_tool: 'mcp__cerebro__get_note',
        tool_uses: 1,
      },
      agent('a-2', 'Check the dates'),
      {
        kind: 'SubagentProgress',
        tool_id: 'a-2',
        description: '',
        last_tool: 'mcp__cerebro__search_notes',
      },
    ]);
    expect(railSubagents([running]).rows.map((row) => [row.state, row.now, row.toolUses])).toEqual([
      ['running', 'Reading notes/risks.md', 1],
      // With no words of its own, the last tool it used.
      ['running', 'search notes', undefined],
    ]);
    // Restored, nothing feeds it: it reads interrupted, never done, and
    // says nothing of now.
    const restored = { ...running, streaming: false };
    expect(railSubagents([restored]).rows.map((row) => [row.state, row.now])).toEqual([
      ['interrupted', undefined],
      ['interrupted', undefined],
    ]);
    // Ended live, the reducer says so itself.
    expect(railSubagents([endLiveTurn(running)]).rows.map((row) => row.state)).toEqual([
      'interrupted',
      'interrupted',
    ]);
  });

  it('says a subagent’s steps were not recorded only where it ran, used tools and none are in hand', () => {
    const turn = (id: string, steps: boolean, toolUses: number): AgentStreamEvent[] => [
      { kind: 'UserPrompt', text: 'Research it' },
      agent(id, 'Read the open risks'),
      ...(steps ? step(id, `${id}-s`) : []),
      ...reported(id, toolUses, 900),
      { kind: 'TurnEnded' },
    ];
    const replay = (events: AgentStreamEvent[]) => replayTranscript(events, SESSION).messages;
    const flags = (messages: ChatMessage[]) =>
      railSubagents(messages).rows.map((row) => row.stepsNotRecorded === true);
    // A branch's copy, or a file whose `subagents/` is gone: no steps.
    expect(flags(replay(turn('a-1', false, 2)))).toEqual([true]);
    expect(flags(replay(turn('a-2', true, 1)))).toEqual([false]);
    // One that used no tools has no steps to keep.
    expect(flags(replay(turn('a-3', false, 0)))).toEqual([false]);
    // Its own failure says why it has none.
    const failed = live([
      agent('a-4', 'Check the dates'),
      { kind: 'Error', message: 'API Error: 529 overloaded', parent: 'a-4' },
      { kind: 'ToolDone', tool_id: 'a-4', output: 'failed', is_error: true },
    ]);
    expect(flags([failed])).toEqual([false]);
  });

  it('reads a stored call whose subagent did not survive by its input and its own row', () => {
    const reply: ChatMessage = {
      id: 'stored',
      role: 'assistant',
      text: 'Done.',
      tools: [
        {
          id: 'a-1',
          name: 'Agent',
          input: JSON.stringify({ description: 'Read the open risks', subagent_type: 'Explore' }),
          output: 'ok',
          done: true,
          failed: false,
        },
      ],
    };
    expect(railSubagents([reply]).rows).toEqual([
      { toolId: 'a-1', type: 'Explore', description: 'Read the open risks', state: 'done' },
    ]);
  });

  it('holds nothing for a conversation with no turns, and no rows for one that started none', () => {
    const none = railSubagents([]);
    expect(none).toEqual({ rows: [], held: false });
    const quiet = railSubagents([ask('u', 'Hello'), live([{ kind: 'TextDelta', text: 'Hi' }])]);
    expect(quiet).toEqual({ rows: [], held: true });
    // Another quiet conversation reads back the same answer.
    expect(railSubagents([ask('u2', 'Hey'), live([], 'other')])).toBe(quiet);
  });

  it('gives back the same rows, the same object, across 50 streamed words', () => {
    let reply = live([agent('a-1', 'Read the open risks'), ...step('a-1', 's-1')]);
    const question = ask('u', 'Research it');
    const first = railSubagents([question, reply]);
    const tools = reply.tools;
    for (let at = 0; at < 50; at += 1) {
      reply = applyEvent(reply, { kind: 'TextDelta', text: `word ${at} ` }, 'live', SESSION);
      // A new message and a new list every time, its calls untouched.
      expect(reply.tools).toBe(tools);
      const next = railSubagents([question, reply]);
      expect(next).toBe(first);
      expect(next.rows).toBe(first.rows);
    }
    // A step of its subagent's is news: the rows change.
    reply = applyEvent(
      reply,
      { kind: 'SubagentProgress', tool_id: 'a-1', description: 'Reading', tool_uses: 1 },
      'live',
      SESSION,
    );
    const moved = railSubagents([question, reply]);
    expect(moved).not.toBe(first);
    expect(moved.rows[0].now).toBe('Reading');
  });

  it('gives back the same object while a subagent’s own steps change nothing its row says', () => {
    let reply = endLiveTurn(live([agent('a-1', 'Read the open risks'), ...step('a-1', 's-1')]));
    const question = ask('u', 'Research it');
    const first = railSubagents([question, reply]);
    const tools = reply.tools;
    // Healed from its transcript: another step of its own, read back.
    reply = applyEvent(
      reply,
      { kind: 'Text', message_id: 'm-sub', text: 'Five risks, one open.', parent: 'a-1' },
      'live',
      SESSION,
    );
    expect(reply.tools).not.toBe(tools);
    expect(railSubagents([question, reply])).toBe(first);
  });

  it('keeps an earlier reply’s rows as they were when a later one grows', () => {
    const earlier = endLiveTurn(live([agent('a-1', 'Read the open risks')], 'r-1'));
    let later = live([agent('a-2', 'Check the dates')], 'r-2');
    const first = railSubagents([earlier, later]);
    later = applyEvent(
      later,
      { kind: 'SubagentProgress', tool_id: 'a-2', description: 'Checking' },
      'live',
      SESSION,
    );
    const next = railSubagents([earlier, later]);
    expect(next).not.toBe(first);
    expect(next.rows[0]).toBe(first.rows[0]);
    expect(next.rows[1].now).toBe('Checking');
  });
});
