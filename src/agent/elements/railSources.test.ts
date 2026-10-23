import { describe, expect, it } from 'vitest';
import { applyEvent } from '@/agent/transcript';
import type { ChatMessage, ToolCall } from '@/agent/types';
import type { TranscriptStatus } from '@/agent/useConversations';
import { railSources, type RailSources } from './railSources';

/**
 * The rail's Sources card (M92.6, Q15): every finished reply's own sources,
 * merged, the latest reply's first, each under the reply its line jumps to.
 * A streaming reply adds nothing, a subagent's finds count, and a list that
 * may be short says why: the transcript could not be read back, or a
 * finished web call holds no result (CV-05).
 */

const IDLE: TranscriptStatus = { state: 'idle' };
const READING: TranscriptStatus = { state: 'reading' };
const UNREADABLE: TranscriptStatus = {
  state: 'unavailable',
  reason: 'unreadable',
  retentionDays: null,
};

function call(id: string, name: string, over: Partial<ToolCall> = {}): ToolCall {
  return { id, name, input: '{}', output: 'ok', done: true, failed: false, ...over };
}

const search = (id: string, ...urls: string[]): ToolCall =>
  call(id, 'WebSearch', {
    result: {
      type: 'web_search',
      query: 'scanners',
      results: urls.map((url) => ({ title: `Page ${url.slice(-1)}`, url })),
    },
  });
const read = (id: string, path: string): ToolCall =>
  call(id, 'mcp__cerebro__get_note', { input: JSON.stringify({ path }) });
const fetchedNothing = (id: string, over: Partial<ToolCall> = {}): ToolCall =>
  call(id, 'WebFetch', { input: '{"url":"https://example.com/a"}', ...over });

const asked = (id: string): ChatMessage => ({ id, role: 'user', text: 'Look it up', tools: [] });
const replied = (id: string, tools: ToolCall[], over: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: 'assistant',
  text: '',
  tools,
  ...over,
});

/** Each line as where it leads and the reply it jumps to. */
const lines = (list: RailSources) =>
  list.cited.map(({ source, turn }) => [source.kind === 'url' ? source.url : source.path, turn]);

describe('railSources', () => {
  it('lists every finished reply’s sources, the latest reply’s first, each under the reply that used it', () => {
    const list = railSources(
      [
        asked('u1'),
        replied('a1', [search('s1', 'https://a.example/1'), read('r1', 'notes/plan.md')]),
        asked('u2'),
        replied('a2', [search('s2', 'https://b.example/2')], {
          text: 'Also [the spec](https://a.example/1).',
        }),
      ],
      IDLE,
    );
    expect(lines(list)).toEqual([
      ['https://b.example/2', 'a2'],
      ['https://a.example/1', 'a2'],
      ['notes/plan.md', 'a1'],
    ]);
    expect(list.state).toBe('ready');
    expect(list.missing).toBeNull();
  });

  it('adds nothing for a reply still streaming, until it is done', () => {
    const before = [asked('u1'), replied('a1', [search('s1', 'https://a.example/1')])];
    const streaming = replied('a2', [search('s2', 'https://b.example/2')], {
      text: 'Half-typed https://c.example/',
      streaming: true,
    });
    expect(lines(railSources([...before, asked('u2'), streaming], IDLE))).toEqual([
      ['https://a.example/1', 'a1'],
    ]);
    const done = { ...streaming, streaming: false };
    expect(lines(railSources([...before, asked('u2'), done], IDLE))).toEqual([
      ['https://b.example/2', 'a2'],
      ['https://c.example/', 'a2'],
      ['https://a.example/1', 'a1'],
    ]);
  });

  it('counts what a subagent found where its Agent call stands', () => {
    const agent = call('ag', 'Agent', {
      subagent: {
        type: 'cerebro-researcher',
        description: 'Research the cutover',
        status: 'done',
        parts: [
          { kind: 'tool', toolId: 'sub-s' },
          { kind: 'tool', toolId: 'sub-r' },
        ],
        tools: [
          search('sub-s', 'https://vendor.example/lead'),
          read('sub-r', 'projects/cutover.md'),
        ],
      },
    });
    const list = railSources([asked('u1'), replied('a1', [agent])], IDLE);
    expect(lines(list)).toEqual([
      ['https://vendor.example/lead', 'a1'],
      ['projects/cutover.md', 'a1'],
    ]);
  });

  it('is partial when the transcript could not be read back, whatever it could list', () => {
    const listed = railSources(
      [asked('u1'), replied('a1', [read('r1', 'notes/plan.md')])],
      UNREADABLE,
    );
    expect(listed.state).toBe('partial');
    expect(listed.missing).toBe('transcript');
    expect(lines(listed)).toEqual([['notes/plan.md', 'a1']]);

    // Nothing it could list is not nothing drawn on.
    const bare = railSources([asked('u1'), replied('a1', [])], UNREADABLE);
    expect(bare).toMatchObject({ state: 'partial', missing: 'transcript', cited: [] });
  });

  it('is partial when a finished web call holds no result, a subagent’s too', () => {
    const main = railSources(
      [asked('u1'), replied('a1', [read('r1', 'notes/plan.md'), fetchedNothing('f1')])],
      IDLE,
    );
    expect(main).toMatchObject({ state: 'partial', missing: 'results' });
    expect(lines(main)).toEqual([['notes/plan.md', 'a1']]);

    const agent = call('ag', 'Agent', {
      subagent: {
        type: 'cerebro-researcher',
        description: 'Search',
        status: 'done',
        parts: [{ kind: 'tool', toolId: 'sub-f' }],
        tools: [fetchedNothing('sub-f')],
      },
    });
    expect(railSources([asked('u1'), replied('a1', [agent])], IDLE)).toMatchObject({
      state: 'partial',
      missing: 'results',
      cited: [],
    });
  });

  it('is partial when a subagent ran and used tools but none of its steps are in hand', () => {
    // A branch's copy, or a reload whose `subagents/` transcript is gone:
    // the summary is kept, the steps are not.
    const kept = (over: Partial<NonNullable<ToolCall['subagent']>> = {}) =>
      call('ag', 'Agent', {
        subagent: {
          type: 'cerebro-researcher',
          description: 'Research the cutover',
          status: 'done',
          toolUses: 4,
          parts: [],
          tools: [],
          ...over,
        },
      });
    const thread = (agent: ToolCall) => [
      asked('u1'),
      replied('a1', [read('r1', 'notes/plan.md'), agent, fetchedNothing('f1')]),
    ];
    const short = railSources(thread(kept()), IDLE);
    expect(short).toMatchObject({ state: 'partial', missing: 'steps' });
    expect(lines(short)).toEqual([['notes/plan.md', 'a1']]);
    // Its tool-use count unrecorded is not a count of none.
    expect(railSources(thread(kept({ toolUses: undefined })), IDLE).missing).toBe('steps');
    // While the file is read, its steps may yet come back.
    expect(railSources(thread(kept()), READING).missing).toBeNull();

    // One that used no tools, failed in its own words, never ran, or was
    // refused, lost nothing: only the web call's result is missing.
    const agentOnly = (agent: ToolCall) =>
      railSources([asked('u1'), replied('a1', [agent])], IDLE).missing;
    expect(agentOnly(kept({ toolUses: 0 }))).toBeNull();
    expect(agentOnly(kept({ status: 'failed', error: 'It ran out of turns.' }))).toBeNull();
    expect(agentOnly(kept({ status: 'not_run' }))).toBeNull();
    expect(agentOnly({ ...kept(), failed: true, denied: 'Denied by a rule.' })).toBeNull();
    expect(railSources(thread(kept({ toolUses: 0 })), IDLE).missing).toBe('results');
  });

  it('misses nothing for a web call that failed, was refused, or has not finished', () => {
    const calls = [
      fetchedNothing('failed', { failed: true }),
      fetchedNothing('refused', { failed: true, denied: 'Denied by a rule.' }),
      fetchedNothing('running', { done: false, output: null }),
      fetchedNothing('waiting', { done: false, output: null, deferred: true }),
      // Not a web call: a note read keeps no result to lose.
      read('r1', 'notes/plan.md'),
    ];
    expect(railSources([asked('u1'), replied('a1', calls)], IDLE)).toMatchObject({
      state: 'ready',
      missing: null,
    });
  });

  it('while the transcript is being read, a result it will put back is not missing yet', () => {
    const thread = [asked('u1'), replied('a1', [fetchedNothing('f1')])];
    expect(railSources(thread, READING)).toMatchObject({ state: 'empty', missing: null });
    expect(railSources(thread, { state: 'healed' })).toMatchObject({
      state: 'partial',
      missing: 'results',
    });
  });

  it('is empty when the conversation drew on nothing, and with no reply yet', () => {
    expect(railSources([asked('u1'), replied('a1', [], { text: 'No links.' })], IDLE)).toEqual({
      state: 'empty',
      cited: [],
      missing: null,
    });
    expect(railSources([], IDLE)).toEqual({ state: 'empty', cited: [], missing: null });
  });

  it('hands back the same list across a turn’s stream, and a new one once it is done', () => {
    const first = replied('a1', [search('s1', 'https://a.example/1')]);
    let reply = replied('a2', [], { streaming: true });
    let messages: ChatMessage[] = [asked('u1'), first, asked('u2'), reply];
    const held = railSources(messages, IDLE);
    for (let word = 0; word < 50; word += 1) {
      reply = applyEvent(
        reply,
        { kind: 'TextDelta', text: `see https://b.example/${word} ` },
        'live',
      );
      messages = [...messages.slice(0, -1), reply];
      expect(railSources(messages, IDLE)).toBe(held);
    }
    // Its stream ends: what it drew on joins the list, ahead of the rest.
    messages = [...messages.slice(0, -1), { ...reply, streaming: false }];
    const after = railSources(messages, IDLE);
    expect(after).not.toBe(held);
    expect(after.cited).toHaveLength(51);
    expect(after.cited[0].turn).toBe('a2');
    expect(after.cited.at(-1)?.turn).toBe('a1');
    // Asked again with nothing changed, the same list.
    expect(railSources([...messages], IDLE)).toBe(after);
  });

  it('makes a new list when what is missing changes, though the replies did not', () => {
    const thread = [asked('u1'), replied('a1', [read('r1', 'notes/plan.md')])];
    const read1 = railSources(thread, IDLE);
    const failed = railSources(thread, UNREADABLE);
    expect(failed).not.toBe(read1);
    expect(failed.state).toBe('partial');
    expect(failed.cited).toEqual(read1.cited);
  });
});
