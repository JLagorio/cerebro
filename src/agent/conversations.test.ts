// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  anchor,
  DEFAULT_TITLE,
  loadConversations,
  newConversation,
  ordered,
  retitle,
  saveConversations,
  threadReach,
  titleFrom,
  withSession,
} from '@/agent/conversations';
import { healFromTranscript, replayTranscript } from '@/agent/transcript';
import type {
  AgentStreamEvent,
  ChatMessage,
  Conversation,
  MessagePart,
  RunReach,
  SubagentRun,
  ToolCall,
} from '@/agent/types';
import type { RunChangeset } from '@/engine/changeset';
import { ASK_BASE_LABEL, askedAbout } from '@/lib/prompts';

const msg = (role: ChatMessage['role'], text: string): ChatMessage => ({
  id: `${role}-${text}`,
  role,
  text,
  tools: [],
});

beforeEach(() => {
  window.localStorage.clear();
});

describe('titleFrom', () => {
  it('uses the first user message', () => {
    expect(titleFrom([msg('user', 'What is at risk?'), msg('assistant', 'Three items.')])).toBe(
      'What is at risk?',
    );
  });

  it('truncates long prompts at a word boundary', () => {
    const long = 'Help me work out which of the objectives is going to slip this quarter';
    const title = titleFrom([msg('user', long)])!;
    expect(title.length).toBeLessThanOrEqual(43);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/\s…$/);
  });

  // M52.4 — a labelled ask cut after its label used to end on the `·`.
  it('does not end a cut title on the separator of a labelled ask', () => {
    const asked = askedAbout(ASK_BASE_LABEL, 'Offline sync hardening');
    expect(titleFrom([msg('user', asked)])).toBe('What does Knowledge say about this?…');
  });

  it('returns null when there is nothing to title from', () => {
    expect(titleFrom([])).toBeNull();
    expect(titleFrom([msg('user', '   ')])).toBeNull();
  });
});

describe('retitle', () => {
  it('names an untitled conversation', () => {
    const c: Conversation = { ...newConversation(), messages: [msg('user', 'Clear the inbox')] };
    expect(retitle(c).title).toBe('Clear the inbox');
  });

  // A conversation you named and that renamed itself on the next turn would
  // be the app overruling you.
  it('never overwrites a name the user chose', () => {
    const c: Conversation = {
      ...newConversation(),
      title: 'Q3 planning',
      usesDefaultTitle: false,
      messages: [msg('user', 'something else entirely')],
    };
    expect(retitle(c).title).toBe('Q3 planning');
  });
});

describe('persistence', () => {
  it('round-trips through storage', () => {
    const c = { ...newConversation(), messages: [msg('user', 'hi')] };
    saveConversations([c]);
    const loaded = loadConversations();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].messages[0].text).toBe('hi');
  });

  // A restored conversation claiming to still be thinking would never stop.
  it('drops the streaming flag', () => {
    const c = {
      ...newConversation(),
      messages: [{ ...msg('assistant', 'partial'), streaming: true }],
    };
    saveConversations([c]);
    expect(loadConversations()[0].messages[0].streaming).toBeUndefined();
  });

  // M56.8 (Q21): whole tool payloads are memory only; the session file holds
  // them, and the copy keeps the previews.
  it('drops tool payloads and keeps the previews', () => {
    const tool = {
      id: 't-1',
      name: 'mcp__cerebro__get_note',
      input: '{"path":"a.md"}',
      output: 'the first 2000 characters…',
      done: true,
      failed: false,
      payload: { output: 'the whole result', outputBytes: 16, outputTruncated: false },
    };
    const c = {
      ...newConversation(),
      messages: [{ ...msg('assistant', 'read it'), tools: [tool] }],
    };
    saveConversations([c]);
    const raw = window.localStorage.getItem('cerebro.conversations') ?? '';
    expect(raw).not.toContain('the whole result');
    const [saved] = loadConversations()[0].messages[0].tools;
    expect(saved.payload).toBeUndefined();
    expect(saved).toMatchObject({ input: '{"path":"a.md"}', output: 'the first 2000 characters…' });
    // What is in memory keeps it.
    expect(c.messages[0].tools[0].payload?.output).toBe('the whole result');
  });

  it('keeps a held call deferred and cancelled, and drops what is not true (M57.1)', () => {
    const tool = (id: string, over: Record<string, unknown>) => ({
      id,
      name: 'mcp__cerebro__append_to_note',
      input: '{"path":"a.md"}',
      output: null,
      done: false,
      failed: false,
      ...over,
    });
    const c = {
      ...newConversation(),
      messages: [
        {
          ...msg('assistant', 'held'),
          tools: [
            tool('t-1', { deferred: true }),
            tool('t-2', { deferred: true, cancelled: true }),
            tool('t-3', { deferred: true, paused: true }),
          ],
        },
      ],
    };
    saveConversations([c]);
    const [one, two, three] = loadConversations()[0].messages[0].tools;
    expect(one.deferred).toBe(true);
    expect(two).toMatchObject({ deferred: true, cancelled: true });
    // Paused is memory only: after a reload the call reads not run.
    expect(three.deferred).toBe(true);
    expect('paused' in three).toBe(false);
    // Whatever another build wrote that is not `true` is dropped.
    window.localStorage.setItem(
      'cerebro.conversations',
      JSON.stringify([
        {
          ...newConversation(),
          messages: [
            {
              ...msg('assistant', 'odd'),
              tools: [
                tool('t-4', { deferred: 'yes', cancelled: 1 }),
                tool('t-5', { deferred: false, paused: true }),
              ],
            },
          ],
        },
      ]),
    );
    const [four, five] = loadConversations()[0].messages[0].tools;
    for (const kept of [four, five]) {
      expect('deferred' in kept).toBe(false);
      expect('cancelled' in kept).toBe(false);
      expect('paused' in kept).toBe(false);
    }
  });

  it('survives a corrupted record without losing the rest', () => {
    window.localStorage.setItem(
      'cerebro.conversations',
      JSON.stringify([{ nonsense: true }, { ...newConversation(), messages: [] }]),
    );
    expect(loadConversations()).toHaveLength(1);
  });

  it('returns nothing when storage holds garbage', () => {
    window.localStorage.setItem('cerebro.conversations', 'not json');
    expect(loadConversations()).toEqual([]);
  });

  // M56.4: a failed turn's card comes back with its thread.
  it('keeps a failure notice through save and load', () => {
    const notice = {
      kind: 'not_signed_in',
      title: "Claude Code isn't signed in",
      body: 'Open Terminal, run claude, and type /login.',
      action: 'open_settings',
      resets_at: null,
      window: null,
      cli_version: '2.1.250',
    };
    const failed = { ...msg('assistant', ''), error: 'Not logged in', notice };
    saveConversations([{ ...newConversation(), messages: [failed] }]);
    expect(loadConversations()[0].messages[0].notice).toEqual(notice);
  });

  it('drops a stored notice whose words are missing, keeping the raw error', () => {
    const c = {
      ...newConversation(),
      messages: [
        { ...msg('assistant', ''), error: 'raw', notice: { kind: 'usage_limit', title: 7 } },
        { ...msg('assistant', ''), error: 'raw', notice: 'nonsense' },
      ],
    };
    window.localStorage.setItem('cerebro.conversations', JSON.stringify([c]));
    const [first, second] = loadConversations()[0].messages;
    expect('notice' in first).toBe(false);
    expect('notice' in second).toBe(false);
    expect(first.error).toBe('raw');
  });

  it('keeps a reply’s changesets through save and load, and drops malformed ones (M58.3)', () => {
    const good = {
      state: 'committed',
      run_id: 'run-1',
      commit: 'c'.repeat(40),
      files: [
        {
          path: 'notes/a.md',
          previous_path: null,
          kind: 'modified',
          additions: 2,
          deletions: 1,
          also_by: ['human:me'],
        },
      ],
      additions: 2,
      deletions: 1,
      binary: 0,
      shell_unrecorded: false,
    } satisfies RunChangeset;
    const kept = { ...msg('assistant', 'done'), changesets: [good] };
    saveConversations([{ ...newConversation(), messages: [kept] }]);
    expect(loadConversations()[0].messages[0].changesets).toEqual([good]);

    const c = {
      ...newConversation(),
      messages: [
        { ...msg('assistant', 'a'), changesets: [good, { state: 'committed', run_id: 7 }] },
        { ...msg('assistant', 'b'), changesets: 'nonsense' },
        { ...msg('assistant', 'c'), changesets: [{ state: 'nothing' }] },
      ],
    };
    window.localStorage.setItem('cerebro.conversations', JSON.stringify([c]));
    const [first, second, third] = loadConversations()[0].messages;
    expect(first.changesets).toEqual([good]);
    expect('changesets' in second).toBe(false);
    expect('changesets' in third).toBe(false);
  });
});

describe('ordered', () => {
  it('puts recent first and archived last', () => {
    const a: Conversation = { ...newConversation(), createdAt: '2026-07-01', title: 'old' };
    const b: Conversation = { ...newConversation(), createdAt: '2026-07-29', title: 'new' };
    const c: Conversation = {
      ...newConversation(),
      createdAt: '2026-07-30',
      title: 'archived',
      archived: true,
    };
    expect(ordered([a, c, b]).map((x) => x.title)).toEqual(['new', 'old', 'archived']);
  });
});

describe('newConversation', () => {
  it('starts untitled, unsessioned and unanchored', () => {
    const c = newConversation();
    expect(c.title).toBe(DEFAULT_TITLE);
    expect(c.usesDefaultTitle).toBe(true);
    expect(c.sessionId).toBeNull();
    expect(c.place).toBeNull();
  });
});

describe('anchor (M17.5)', () => {
  it('stamps the place and the name it had at the time', () => {
    const c = anchor(newConversation(), { kind: 'inbox' });
    expect(c.place).toEqual({ kind: 'inbox' });
    expect(c.placeLabel).toBe('Inbox');
  });

  it('refuses to re-anchor, so it is safe to call on every send', () => {
    const first = anchor(newConversation(), { kind: 'inbox' });
    const again = anchor(first, { kind: 'pulse' });
    expect(again).toBe(first);
  });
});

describe('a stored place this build cannot read (M17.5)', () => {
  const write = (place: unknown, placeLabel?: unknown, messages: ChatMessage[] = []) =>
    window.localStorage.setItem(
      'cerebro.conversations',
      JSON.stringify([
        { id: 'c-1', title: 'x', usesDefaultTitle: true, messages, place, placeLabel },
      ]),
    );

  it('drops an anchor written by a build whose Selection shape is gone', () => {
    // M12.5 retired `project` as a selection kind. The next such change must
    // cost a label, not a transcript.
    write({ kind: 'project', id: 'onboarding' }, 'Onboarding');
    const [c] = loadConversations();
    expect(c.place).toBeNull();
    expect(c.placeLabel).toBeUndefined();
    expect(c.title).toBe('x');
  });

  it('rebuilds a label that went missing rather than dropping the anchor', () => {
    write({ kind: 'inbox' });
    const [c] = loadConversations();
    expect(c.place).toEqual({ kind: 'inbox' });
    expect(c.placeLabel).toBe('Inbox');
  });

  it('leaves a readable anchor alone', () => {
    write({ kind: 'list', id: 'roadmap', collection: 'product' }, 'Roadmap');
    const [c] = loadConversations();
    expect(c.place).toEqual({ kind: 'list', id: 'roadmap', collection: 'product' });
    // The name it HAD, not the one re-derived from a vault that no longer
    // holds the List.
    expect(c.placeLabel).toBe('Roadmap');
  });

  // M53.14 — the guard had no case for My work or Work, so a thread anchored
  // on either came back unanchored on every reload.
  it('keeps a My work anchor and the name it had', () => {
    write({ kind: 'mywork' }, 'My work');
    const [c] = loadConversations();
    expect(c.place).toEqual({ kind: 'mywork' });
    expect(c.placeLabel).toBe('My work');
  });

  // M59.1 — a bare destination's label is the table's, so the names the nav
  // stopped saying heal on load.
  it('keeps a Work anchor stored as Workspace and reads it as Work', () => {
    write({ kind: 'workspace' }, 'Workspace');
    const [c] = loadConversations();
    expect(c.place).toEqual({ kind: 'workspace' });
    expect(c.placeLabel).toBe('Work');
  });

  it('reads a thread stored as Pulse as History', () => {
    write({ kind: 'pulse' }, 'Pulse');
    const [c] = loadConversations();
    expect(c.place).toEqual({ kind: 'pulse' });
    expect(c.placeLabel).toBe('History');
  });

  it('rebuilds a My work label that went missing', () => {
    write({ kind: 'mywork' });
    const [c] = loadConversations();
    expect(c.place).toEqual({ kind: 'mywork' });
    expect(c.placeLabel).toBe('My work');
  });

  it('drops an anchor on the retired review surface and keeps the thread (M53.14)', () => {
    // M33.3 took `review` out of Selection and placeLabel but left it in the
    // guard, so the anchor came back as a place nothing renders.
    write({ kind: 'review' }, 'Needs review', [msg('user', 'What is waiting on me?')]);
    const [c] = loadConversations();
    expect(c.place).toBeNull();
    expect(c.placeLabel).toBeUndefined();
    expect(c.title).toBe('x');
    expect(c.messages.map((m) => m.text)).toEqual(['What is waiting on me?']);
  });
});

describe('loading a transcript written before the ToolStart dedupe (M15)', () => {
  const tool = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    name: 'get note',
    input: null,
    output: null,
    done: false,
    failed: false,
    ...over,
  });

  it('collapses the doubled tool rows shipped transcripts already carry', () => {
    // Exactly what was found in localStorage: every tool recorded twice.
    window.localStorage.setItem(
      'cerebro.conversations',
      JSON.stringify([
        {
          id: 'c-1',
          title: 'Learn from the note at…',
          usesDefaultTitle: true,
          sessionId: 'mock-session',
          messages: [
            {
              id: 'm-2',
              role: 'assistant',
              text: 'Kept one thing.',
              tools: [tool('t-1'), tool('t-1'), tool('t-2'), tool('t-2')],
            },
          ],
        },
      ]),
    );

    const [conversation] = loadConversations();
    expect(conversation.messages[0].tools.map((t) => t.id)).toEqual(['t-1', 't-2']);
  });

  it('keeps the completed result when only the later copy finished', () => {
    window.localStorage.setItem(
      'cerebro.conversations',
      JSON.stringify([
        {
          id: 'c-1',
          title: 'x',
          usesDefaultTitle: true,
          sessionId: null,
          messages: [
            {
              id: 'm-1',
              role: 'assistant',
              text: '',
              tools: [tool('t-1'), tool('t-1', { done: true, output: 'the note' })],
            },
          ],
        },
      ]),
    );

    const [{ messages }] = loadConversations();
    expect(messages[0].tools).toHaveLength(1);
    expect(messages[0].tools[0].done).toBe(true);
    expect(messages[0].tools[0].output).toBe('the note');
  });

  it('leaves a clean transcript untouched', () => {
    const clean = newConversation();
    clean.messages = [
      { id: 'm-1', role: 'assistant', text: 'hi', tools: [tool('t-1'), tool('t-2')] },
    ];
    saveConversations([clean]);
    expect(loadConversations()[0].messages[0].tools.map((t) => t.id)).toEqual(['t-1', 't-2']);
  });
});

describe('a thread whose transcript is Claude Code’s file (M56.3)', () => {
  const SESSION = '00000000-0000-4000-8000-000000000001';
  const thread = (over: Partial<Conversation>): Conversation => ({
    ...newConversation(),
    id: 'c-1',
    ...over,
  });

  it('keeps the vault it was had in and when its last turn ended', () => {
    saveConversations([
      thread({ sessionId: SESSION, vault: '/demo-vault', updatedAt: '2026-07-28T12:00:00.000Z' }),
    ]);
    expect(loadConversations()[0]).toMatchObject({
      sessionId: SESSION,
      vault: '/demo-vault',
      updatedAt: '2026-07-28T12:00:00.000Z',
    });
  });

  it('drops a session id that is not UUID-shaped', () => {
    for (const bad of [
      'mock-session',
      '--dangerously-skip-permissions',
      'ABCDEF00-0000-4000-8000-00000000000A',
    ]) {
      saveConversations([thread({ sessionId: bad })]);
      expect(loadConversations()[0].sessionId, bad).toBeNull();
    }
  });

  it('never persists the reducer’s live state', () => {
    saveConversations([
      thread({
        messages: [
          {
            id: 'a',
            role: 'assistant',
            text: 'done',
            tools: [],
            streaming: true,
            live: { messageId: 'm1', finalText: 'done', allText: 'x\n\ndone', ended: true },
          },
        ],
      }),
    ]);
    const raw = window.localStorage.getItem('cerebro.conversations') ?? '';
    expect(raw).not.toContain('allText');
    expect(raw).not.toContain('streaming');
    expect(loadConversations()[0].messages[0].text).toBe('done');
  });
});

describe('a conversation’s model and effort (M56.5)', () => {
  const thread = (over: Partial<Conversation>): Conversation => ({
    ...newConversation(),
    id: 'c-1',
    ...over,
  });

  it('persists the pick with its conversation', () => {
    saveConversations([
      thread({ id: 'a', model: 'opus', effort: 'high' }),
      thread({ id: 'b', model: 'claude-sonnet-5', effort: null }),
    ]);
    const [a, b] = loadConversations();
    expect([a.model, a.effort]).toEqual(['opus', 'high']);
    expect([b.model, b.effort]).toEqual(['claude-sonnet-5', null]);
  });

  it('drops a stored value Rust would refuse, keeping the rest', () => {
    saveConversations([
      thread({ id: 'a', model: '-x', effort: 'high' }),
      thread({ id: 'b', model: 'opus', effort: 'turbo' }),
      thread({ id: 'c', model: 3 as never, effort: '  ' }),
    ]);
    const [a, b, c] = loadConversations();
    expect([a.model, a.effort]).toEqual([null, 'high']);
    expect([b.model, b.effort]).toEqual(['opus', null]);
    expect([c.model, c.effort]).toEqual([null, null]);
  });
});

describe('a turn left running (M57.6)', () => {
  const reply: ChatMessage = { ...msg('assistant', 'half'), seq: 12, gap: true, streaming: true };
  const thread = (over: Partial<Conversation> = {}): Conversation => ({
    ...newConversation(),
    messages: [msg('user', 'go'), reply],
    live: { run: 7, attach: 'run-0001', assistantId: reply.id },
    ...over,
  });

  it('round-trips live with its reply’s seq and gap, and still strips streaming', () => {
    saveConversations([thread()]);
    const [loaded] = loadConversations();
    expect(loaded.live).toEqual({ run: 7, attach: 'run-0001', assistantId: reply.id });
    expect(loaded.messages[1].seq).toBe(12);
    expect(loaded.messages[1].gap).toBe(true);
    expect(loaded.messages[1].streaming).toBeUndefined();
  });

  it('drops a malformed live, seq or gap on load', () => {
    const bad = [
      { run: 1.5, attach: 'run-1', assistantId: reply.id },
      { run: 1, attach: 'has a space', assistantId: reply.id },
      { run: 1, attach: 'run-1', assistantId: 'not-in-the-thread' },
      'run-1',
    ];
    for (const live of bad) {
      window.localStorage.setItem('cerebro.conversations', JSON.stringify([{ ...thread(), live }]));
      expect(loadConversations()[0].live ?? null).toBeNull();
    }
    window.localStorage.setItem(
      'cerebro.conversations',
      JSON.stringify([
        {
          ...thread({ live: null }),
          messages: [msg('user', 'go'), { ...reply, seq: -1, gap: 'yes' }],
        },
      ]),
    );
    const [loaded] = loadConversations();
    expect('seq' in loaded.messages[1]).toBe(false);
    expect('gap' in loaded.messages[1]).toBe(false);
  });
});

describe('how long a reply worked (M92.2)', () => {
  const reply = (id: string, over: Partial<ChatMessage>): ChatMessage => ({
    ...msg('assistant', id),
    ...over,
  });
  const running = (open: ChatMessage, over: Partial<Conversation> = {}): Conversation => ({
    ...newConversation(),
    messages: [msg('user', 'go'), open],
    live: { run: 3, attach: 'run-0003', assistantId: open.id },
    ...over,
  });

  it('keeps a sum through save and load, and an open count only on the reply a live turn writes into', () => {
    const open = reply('open', { workedMs: 3000, workedRun: 3000, streaming: true, seq: 4 });
    saveConversations([
      {
        ...newConversation(),
        messages: [
          reply('counted', { workedMs: 5400 }),
          reply('unrecorded', { workedMs: null }),
          // Its run's Changeset never came (Cerebro quit as it committed):
          // its count stands in the sum, and no run can close it any more.
          reply('ended', { workedMs: 2400, workedRun: 2400 }),
          reply('none', {}),
        ],
      },
      running(open),
    ]);
    const [quiet, live] = loadConversations();
    expect(quiet.messages.map((m) => [m.workedMs, 'workedRun' in m])).toEqual([
      [5400, false],
      [null, false],
      [2400, false],
      [undefined, false],
    ]);
    expect(live.messages[1]).toMatchObject({ workedMs: 3000, workedRun: 3000 });
  });

  it('reads a stored sum this build cannot read as none, and drops an open count with no sum', () => {
    const stored = [
      running(reply('words', { workedMs: 'four minutes' as unknown as number, workedRun: 4 })),
      running(reply('negative', { workedMs: -1 })),
      running(reply('unrecorded', { workedMs: null, workedRun: 3000 })),
      running(reply('lone', { workedRun: 3000 })),
      running(reply('odd', { workedMs: 3000, workedRun: 'x' as unknown as number })),
      // An open count is a part of its sum, never more than all of it.
      running(reply('over', { workedMs: 3000, workedRun: 4000 })),
    ];
    window.localStorage.setItem('cerebro.conversations', JSON.stringify(stored));
    const replies = loadConversations().map((c) => c.messages[1]);
    expect(replies.map((m) => [m.workedMs, 'workedRun' in m])).toEqual([
      [null, false],
      [null, false],
      [null, false],
      [undefined, false],
      [3000, false],
      [3000, false],
    ]);
  });
});

describe('a turn’s parts, anchor and subagents (M91.4)', () => {
  const SESSION = '00000000-0000-4000-8000-0000000091a4';
  const LINE = '00000000-0000-4000-8000-0000000091b2';
  const raw = () => window.localStorage.getItem('cerebro.conversations') ?? '';
  const call = (id: string, over: Partial<ToolCall> = {}): ToolCall => ({
    id,
    name: 'mcp__cerebro__get_note',
    input: '{}',
    output: 'read it',
    done: true,
    failed: false,
    ...over,
  });
  const run = (over: Partial<SubagentRun> = {}): SubagentRun => ({
    agentId: 'a0000000000000001',
    type: 'cerebro-researcher',
    description: 'Read the launch note',
    status: 'done',
    toolUses: 1,
    durationMs: 3800,
    model: 'claude-haiku-4-5-20251001',
    summary: 'It is ready for review.',
    background: false,
    depth: 1,
    progress: 'Reading projects/launch.md',
    lastTool: 'mcp__cerebro__get_note',
    parts: [
      { kind: 'reasoning', id: 'a1:reasoning-1', text: 'INTERNAL THOUGHT', durationMs: 1600 },
      { kind: 'tool', toolId: 'r1' },
    ],
    tools: [call('r1', { parent: 'a1', output: 'INTERNAL READ' })],
    ...over,
  });
  const reply = (over: Partial<ChatMessage> = {}): ChatMessage => ({
    id: 'a-1',
    role: 'assistant',
    text: 'Almost ready.',
    tools: [
      call('a1', {
        name: 'Agent',
        startedAt: '2026-10-22T12:00:02.400Z',
        endedAt: '2026-10-22T12:00:06.300Z',
        result: { type: 'agent', agent_id: 'a0000000000000001', summary: 'RESULT DATA' },
        subagent: run(),
      }),
      call('b1', { name: 'Bash', failed: true, denied: 'Needs approval.' }),
    ],
    parts: [
      {
        kind: 'reasoning',
        id: 'reasoning-1',
        text: 'MAIN THOUGHT',
        at: '2026-10-22T12:00:02.000Z',
      },
      { kind: 'text', id: 'text-1', text: 'Asking a researcher.' },
      { kind: 'tool', toolId: 'a1' },
      { kind: 'tool', toolId: 'b1' },
      { kind: 'text', id: 'text-2', text: 'Almost ready.' },
    ],
    anchor: { sessionId: SESSION, uuid: LINE },
    ...over,
  });
  const save = (...messages: ChatMessage[]) =>
    saveConversations([{ ...newConversation(), messages: [msg('user', 'go'), ...messages] }]);

  it('keeps the parts, the anchor and each subagent’s summary, and nothing else of it', () => {
    save(reply());
    const stored = raw();
    for (const memoryOnly of [
      'MAIN THOUGHT',
      'INTERNAL THOUGHT',
      'INTERNAL READ',
      'RESULT DATA',
      'Reading projects/launch.md',
    ]) {
      expect(stored, memoryOnly).not.toContain(memoryOnly);
    }
    // The answer's words are saved once, as the reply's text.
    expect(stored.split('Almost ready.')).toHaveLength(2);
    const [, loaded] = loadConversations()[0].messages;
    expect(loaded.parts).toEqual([
      { kind: 'text', id: 'text-1', text: 'Asking a researcher.' },
      { kind: 'tool', toolId: 'a1' },
      { kind: 'tool', toolId: 'b1' },
      { kind: 'text', id: 'text-2', text: 'Almost ready.' },
    ]);
    expect(loaded.anchor).toEqual({ sessionId: SESSION, uuid: LINE });
    const [agent, bash] = loaded.tools;
    expect(agent.subagent).toEqual({
      agentId: 'a0000000000000001',
      type: 'cerebro-researcher',
      description: 'Read the launch note',
      status: 'done',
      toolUses: 1,
      durationMs: 3800,
      model: 'claude-haiku-4-5-20251001',
      summary: 'It is ready for review.',
      parts: [],
      tools: [],
    });
    expect(agent).toMatchObject({
      startedAt: '2026-10-22T12:00:02.400Z',
      endedAt: '2026-10-22T12:00:06.300Z',
    });
    expect('result' in agent).toBe(false);
    expect(bash.denied).toBe('Needs approval.');
  });

  it('cuts a subagent’s saved answer to what its line shows', () => {
    save(
      reply({
        tools: [call('a1', { name: 'Agent', subagent: run({ summary: 'x'.repeat(900) }) })],
      }),
    );
    expect(loadConversations()[0].messages[1].tools[0].subagent?.summary).toHaveLength(500);
  });

  it('counts a saved answer by character, as Rust clips it, never splitting an emoji', () => {
    const summary = `${'x'.repeat(498)}🙂🙂`;
    save(reply({ tools: [call('a1', { name: 'Agent', subagent: run({ summary }) })] }));
    expect(loadConversations()[0].messages[1].tools[0].subagent?.summary).toBe(summary);
  });

  it('heals a reloaded subagent turn back to its replay from the session file', () => {
    const golden = JSON.parse(
      readFileSync(join(__dirname, '../../conformance/transcript/subagent.json'), 'utf8'),
    ) as { session: { events: AgentStreamEvent[] } };
    const session = '00000000-0000-4000-8000-000000009500';
    const { messages } = replayTranscript(golden.session.events, session);
    saveConversations([{ ...newConversation(), sessionId: session, messages }]);
    const reloaded = loadConversations()[0].messages;
    // Memory only: the reasoning and the subagent's steps are gone.
    expect(reloaded[1].parts?.some((part) => part.kind === 'reasoning')).toBe(false);
    expect(reloaded[1].tools[0].subagent).toMatchObject({ status: 'done', parts: [], tools: [] });
    const healed = healFromTranscript(reloaded, messages);
    expect(healed[1].parts).toEqual(messages[1].parts);
    expect(healed[1].tools).toEqual(messages[1].tools);
    expect(healed[1].anchor).toEqual(messages[1].anchor);
  });

  it('drops what a stored reply holds that this build does not write', () => {
    const tool = (id: string, over: Record<string, unknown>) => ({ ...call(id), ...over });
    const stored = {
      ...newConversation(),
      messages: [
        {
          ...msg('assistant', 'answer'),
          tools: [
            tool('t1', { startedAt: 'yesterday', endedAt: 7, denied: 3, parent: 'x', result: {} }),
            tool('t2', {
              name: 'Agent',
              subagent: { type: 'x', description: 'y', status: 'busy' },
            }),
            tool('t3', {
              name: 'Agent',
              subagent: {
                type: 'x',
                description: 'y',
                status: 'done',
                toolUses: -1,
                durationMs: 'long',
                parts: ['junk'],
              },
            }),
          ],
          parts: [
            { kind: 'tool', toolId: 't1' },
            { kind: 'tool', toolId: 't1' },
            { kind: 'tool', toolId: 'gone' },
            { kind: 'text', id: 'text-1', text: 7 },
            { kind: 'text', id: 'text-1' },
            { kind: 'text', id: 'text-1', text: 'a second text-1' },
            { kind: 'reasoning', id: 'reasoning-1', text: 'never saved' },
            'nonsense',
          ],
          anchor: { sessionId: 'mock-session', uuid: LINE },
        },
        { ...msg('assistant', 'b'), parts: 'nonsense', anchor: { sessionId: SESSION } },
      ],
    };
    window.localStorage.setItem('cerebro.conversations', JSON.stringify([stored]));
    const [first, second] = loadConversations()[0].messages;
    const [t1, t2, t3] = first.tools;
    for (const key of ['startedAt', 'endedAt', 'denied', 'parent', 'result']) {
      expect(key in t1, key).toBe(false);
    }
    expect('subagent' in t2).toBe(false);
    expect(t3.subagent).toEqual({
      type: 'x',
      description: 'y',
      status: 'done',
      parts: [],
      tools: [],
    });
    // Each call once, the answer's words from the reply, and every call shown.
    expect(first.parts).toEqual([
      { kind: 'tool', toolId: 't1' },
      { kind: 'text', id: 'text-1', text: 'answer' },
      { kind: 'tool', toolId: 't2' },
      { kind: 'tool', toolId: 't3' },
    ]);
    expect('anchor' in first).toBe(false);
    expect('parts' in second).toBe(false);
    expect('anchor' in second).toBe(false);
  });

  it('reads a subagent no turn feeds any more as stopped, and keeps the live reply’s', () => {
    const waiting = (id: string, status: SubagentRun['status']) =>
      call(id, { name: 'Agent', done: false, subagent: run({ status }) });
    const old = reply({
      id: 'a-1',
      tools: [waiting('a1', 'running'), waiting('a2', 'waiting')],
      parts: undefined,
    });
    const busy = reply({ id: 'a-2', tools: [waiting('a3', 'running')], parts: undefined });
    saveConversations([
      {
        ...newConversation(),
        messages: [msg('user', 'go'), old, msg('user', 'again'), busy],
        live: { run: 7, attach: 'run-0007', assistantId: 'a-2' },
      },
    ]);
    const [, first, , second] = loadConversations()[0].messages;
    expect(first.tools.map((t) => t.subagent?.status)).toEqual(['interrupted', 'not_run']);
    expect(second.tools[0].subagent?.status).toBe('running');
  });

  /** A turn that asked eight researchers, each of which read ten notes. */
  function heavyTurn(n: number): ChatMessage {
    const notes = (agent: string) =>
      Array.from({ length: 10 }, (_, k) =>
        call(`${agent}-r${k}`, { parent: agent, output: `note ${k} `.repeat(250) }),
      );
    const agents = Array.from({ length: 8 }, (_, k) => {
      const id = `t${n}-a${k}`;
      return call(id, {
        name: 'Agent',
        input: JSON.stringify({
          description: `Research ${k}`,
          subagent_type: 'cerebro-researcher',
        }),
        output: 'Found it. '.repeat(50),
        result: { type: 'agent', summary: 'Found it.'.repeat(55) },
        subagent: run({
          summary: 'Found it. '.repeat(50),
          parts: [
            { kind: 'reasoning', id: `${id}:reasoning-1`, text: 'thinking '.repeat(300) },
            ...notes(id).map((note): MessagePart => ({ kind: 'tool', toolId: note.id })),
            { kind: 'text', id: `${id}:text-1`, text: 'report '.repeat(200) },
          ],
          tools: notes(id),
        }),
      });
    });
    return {
      id: `a-${n}`,
      role: 'assistant',
      text: 'Here is what the researchers found.',
      tools: agents,
      parts: [
        { kind: 'reasoning', id: 'reasoning-1', text: 'planning '.repeat(300) },
        ...agents.map((agent): MessagePart => ({ kind: 'tool', toolId: agent.id })),
        { kind: 'text', id: 'text-1', text: 'Here is what the researchers found.' },
      ],
    };
  }

  it('saves thirty threads of eight-subagent turns under a fixed budget', () => {
    const threads = Array.from({ length: 30 }, (_, n) => ({
      ...newConversation(),
      id: `c-${n}`,
      messages: [msg('user', `research ${n} with subagents`), heavyTurn(n)],
    }));
    // In memory the steps alone are several megabytes; saved, the summaries
    // fit in well under one.
    expect(JSON.stringify(threads).length).toBeGreaterThan(5_000_000);
    saveConversations(threads);
    expect(raw().length).toBeLessThan(1_000_000);
    const loaded = loadConversations();
    expect(loaded).toHaveLength(30);
    expect(loaded[0].messages[1].tools.every((t) => t.subagent?.tools.length === 0)).toBe(true);
  });

  describe('when storage is full', () => {
    afterEach(() => vi.restoreAllMocks());

    /** Whatever holds the page's `setItem`: jsdom's Storage, or the stand-in
     * src/test/setup.ts installs where Node shadows it. */
    const storage = (): Storage => {
      const store = window.localStorage;
      return Object.prototype.hasOwnProperty.call(store, 'setItem')
        ? store
        : (Object.getPrototypeOf(store) as Storage);
    };

    /** A store that refuses anything longer than `limit`, as a full one would. */
    function quota(limit: number) {
      const real = storage().setItem;
      return vi.spyOn(storage(), 'setItem').mockImplementation(function (
        this: Storage,
        key: string,
        value: string,
      ) {
        if (value.length > limit) {
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        }
        real.call(this, key, value);
      });
    }

    const thread = (n: number, over: Partial<Conversation> = {}): Conversation => ({
      ...newConversation(),
      id: `c-${n}`,
      updatedAt: `2026-10-${String(10 + n).padStart(2, '0')}T12:00:00.000Z`,
      messages: [
        msg('user', `question ${n}`),
        { ...msg('assistant', 'x'.repeat(4000)), id: `a-${n}` },
      ],
      ...over,
    });

    it('trims the oldest threads’ bodies until the rest fits, and keeps every thread', () => {
      const threads = [thread(3), thread(1), thread(2)];
      quota(JSON.stringify(threads).length - 2000);
      saveConversations(threads);
      const loaded = loadConversations();
      expect(loaded.map((c) => c.id)).toEqual(['c-3', 'c-1', 'c-2']);
      // The oldest lost its copy (its session file rebuilds it); the rest kept theirs.
      expect(loaded.map((c) => c.messages.length)).toEqual([2, 0, 2]);
    });

    it('trims a thread no session file can rebuild only after every thread one can', () => {
      const session = '00000000-0000-4000-8000-000000000001';
      // The oldest never reached Claude Code: nothing could rebuild it.
      const threads = [thread(1), thread(2, { sessionId: session })];
      quota(JSON.stringify(threads).length - 2000);
      saveConversations(threads);
      const loaded = loadConversations();
      expect(loaded.map((c) => c.messages.length)).toEqual([2, 0]);
      expect(loaded[1].sessionId).toBe(session);
    });

    it('trims a running turn’s thread last, down to its question and reply', () => {
      const live = { run: 4, attach: 'run-0004', assistantId: 'a-1' };
      const running = thread(1, {
        live,
        messages: [
          msg('user', 'earlier'),
          { ...msg('assistant', 'y'.repeat(4000)), id: 'a-0' },
          msg('user', 'now'),
          { ...msg('assistant', 'half'), id: 'a-1', seq: 9 },
        ],
      });
      const threads = [running, thread(2)];
      quota(1500);
      saveConversations(threads);
      const [kept, other] = loadConversations();
      expect(kept.live).toEqual(live);
      expect(kept.messages.map((m) => m.text)).toEqual(['now', 'half']);
      expect(kept.messages[1].seq).toBe(9);
      expect(other.messages).toEqual([]);
    });

    it('keeps only a true cache omission marker from storage', () => {
      for (const cacheTrimmed of [false, 'true', 1, null]) {
        window.localStorage.setItem(
          'cerebro.conversations',
          JSON.stringify([{ ...newConversation(), cacheTrimmed }]),
        );
        expect(loadConversations()[0].cacheTrimmed).toBeUndefined();
      }
    });

    it('quota_retry_does_not_repeat_full_trim_per_delta', () => {
      const live = { run: 4, attach: 'run-0004', assistantId: 'a-live' };
      const prior = { ...msg('assistant', 'y'.repeat(4000)), id: 'a-prior' };
      const running = thread(1, {
        live,
        messages: [
          msg('user', 'earlier'),
          prior,
          msg('user', 'now'),
          { ...msg('assistant', 'half'), id: 'a-live', seq: 9 },
        ],
      });
      const other = thread(2);
      const setItem = quota(1500);
      saveConversations([running, other]);
      expect(loadConversations()[0].messages.map((m) => m.text)).toEqual(['now', 'half']);
      // Reading/serializing a body rejected on the first save is observable
      // work, independent of machine speed or a timing threshold.
      let priorReads = 0;
      Object.defineProperty(prior, 'text', {
        get: () => {
          priorReads += 1;
          return 'y'.repeat(4000);
        },
        enumerable: true,
      });
      setItem.mockClear();
      for (const [seq, text] of [
        [10, 'half one'],
        [11, 'half one two'],
      ] as const) {
        running.messages = running.messages.map((m) =>
          m.id === 'a-live' ? { ...m, text, seq } : m,
        );
        saveConversations([running, other]);
        expect(loadConversations()[0].messages[1]).toMatchObject({ text, seq });
      }
      expect(priorReads).toBe(0);
      expect(setItem).toHaveBeenCalledTimes(2);
      expect(loadConversations()[0].live).toEqual(live);
    });

    it.each([
      'healed',
      'prefix reorder',
      'session',
      'vault',
      'thread reorder',
      'clear',
      'overwrite',
    ])('invalidates quota admission after %s', (change) => {
      const original = thread(1);
      const threads = [original, thread(2)];
      const full = quota(1000);
      saveConversations(threads);
      expect(loadConversations()[0].messages).toEqual([]);
      full.mockRestore();
      if (change === 'healed') {
        original.messages = original.messages.map((m) => ({ ...m, text: 'healed' }));
      } else if (change === 'prefix reorder') {
        original.messages = [...original.messages].reverse();
      } else if (change === 'session') {
        original.sessionId = '00000000-0000-4000-8000-000000000002';
      } else if (change === 'vault') {
        original.vault = '/other-vault';
      } else if (change === 'thread reorder') {
        threads.reverse();
      } else if (change === 'clear') {
        window.localStorage.clear();
      } else {
        window.localStorage.setItem('cerebro.conversations', '[]');
      }
      saveConversations(threads);
      expect(loadConversations().find((c) => c.id === original.id)?.messages).toEqual(
        original.messages,
      );
    });

    it('does not admit omissions from a save that never fit', () => {
      const threads = [thread(1), thread(2)];
      const full = quota(10);
      saveConversations(threads);
      full.mockRestore();
      saveConversations(threads);
      expect(loadConversations().map((c) => c.messages.length)).toEqual([2, 2]);
    });

    it('saves nothing new, and throws nothing, when even the trimmed list cannot fit', () => {
      saveConversations([thread(1)]);
      const before = raw();
      quota(10);
      expect(() => saveConversations([thread(1), thread(2)])).not.toThrow();
      expect(raw()).toBe(before);
    });

    it('never trims for a failure that is not a full store', () => {
      const setItem = vi.spyOn(storage(), 'setItem').mockImplementation(() => {
        throw new DOMException('Denied.', 'SecurityError');
      });
      expect(() => saveConversations([thread(1), thread(2)])).not.toThrow();
      // One try: a trim would have tried again with less.
      expect(setItem).toHaveBeenCalledTimes(1);
    });
  });
});

describe('what a thread’s runs reached (M92.8)', () => {
  const reach = (status: string, over: Partial<RunReach> = {}): RunReach => ({
    connectors: [{ name: 'gmail', status }],
    missing: [{ name: 'linear', reason: "not in this vault's connector list" }],
    missing_more: 2,
    inherits: false,
    permission_mode: 'acceptEdits',
    cerebro: true,
    families: { confirmable: ['allow'], delegate: ['cli'], file_write: ['deny'], shell: ['deny'] },
    ...over,
  });
  const reply = (id: string, reached?: RunReach): ChatMessage => ({
    ...msg('assistant', id),
    ...(reached === undefined ? {} : { reach: reached }),
  });
  /** The threads as storage holds them. */
  const stored = (): Record<string, unknown>[] =>
    JSON.parse(window.localStorage.getItem('cerebro.conversations') ?? '[]') as Record<
      string,
      unknown
    >[];

  it('saves the newest reply’s reach once, as the thread’s own fact, and none on its replies', () => {
    const older = reach('needs-auth');
    const newer = reach('connected');
    const thread: Conversation = {
      ...newConversation(),
      messages: [
        msg('user', 'a'),
        reply('one', older),
        msg('user', 'b'),
        reply('two', newer),
        msg('user', 'c'),
        // A run its init refused says nothing: the last one that said stands.
        reply('three'),
      ],
    };
    expect(threadReach(thread)).toEqual(newer);
    saveConversations([thread]);
    const [saved] = stored();
    expect(saved.reach).toEqual(newer);
    const messages = saved.messages as Record<string, unknown>[];
    expect(messages.some((m) => 'reach' in m)).toBe(false);
    const [loaded] = loadConversations();
    expect(loaded.reach).toEqual(newer);
    expect(loaded.messages.some((m) => m.reach !== undefined)).toBe(false);
    expect(threadReach(loaded)).toEqual(newer);
    // A later turn's run outranks what the thread saved, and is saved in its
    // place.
    const later: Conversation = { ...loaded, messages: [...loaded.messages, reply('four', older)] };
    expect(threadReach(later)).toEqual(older);
    saveConversations([later]);
    expect(loadConversations()[0].reach).toEqual(older);
  });

  it('reads a thread no run has said one for as not recorded, never as reaching nothing', () => {
    const thread: Conversation = {
      ...newConversation(),
      messages: [msg('user', 'a'), reply('one')],
    };
    expect(threadReach(thread)).toBeNull();
    saveConversations([thread]);
    expect('reach' in stored()[0]).toBe(false);
    expect(threadReach(loadConversations()[0])).toBeNull();
  });

  it('drops a stored reach this build cannot read, and any a reply holds', () => {
    const good = reach('connected');
    const unread: unknown[] = [
      'gmail',
      null,
      { ...good, connectors: [{ name: 'gmail' }] },
      { ...good, missing: [{ name: 7, reason: 'x' }] },
      { ...good, missing_more: -1 },
      { ...good, missing_more: 1.5 },
      { ...good, inherits: 'no' },
      { ...good, cerebro: undefined },
      { ...good, permission_mode: null },
      { ...good, families: [] },
      { ...good, families: { shell: 'deny' } },
      { ...good, families: { shell: ['maybe'] } },
      { ...good, families: { shell: ['toString'] } },
    ];
    window.localStorage.setItem(
      'cerebro.conversations',
      JSON.stringify([
        ...unread.map((r, n) => ({ ...newConversation(), id: `c-${n}`, reach: r })),
        {
          ...newConversation(),
          id: 'kept',
          reach: good,
          messages: [msg('user', 'a'), reply('one', reach('failed'))],
        },
      ]),
    );
    const loaded = loadConversations();
    expect(loaded.slice(0, unread.length).map((c) => 'reach' in c)).toEqual(
      unread.map(() => false),
    );
    const kept = loaded[unread.length];
    expect(kept.reach).toEqual(good);
    expect('reach' in kept.messages[1]).toBe(false);
    expect(threadReach(kept)).toEqual(good);
  });

  describe('when storage is full', () => {
    afterEach(() => vi.restoreAllMocks());

    /** A store that refuses anything longer than `limit`, as a full one
     * would, on whatever holds the page's `setItem`. */
    function quota(limit: number) {
      const store = window.localStorage;
      const holder = Object.prototype.hasOwnProperty.call(store, 'setItem')
        ? store
        : (Object.getPrototypeOf(store) as Storage);
      const real = holder.setItem;
      vi.spyOn(holder, 'setItem').mockImplementation(function (
        this: Storage,
        key: string,
        value: string,
      ) {
        if (value.length > limit) {
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        }
        real.call(this, key, value);
      });
    }

    const thread = (n: number, reached?: RunReach): Conversation => ({
      ...newConversation(),
      id: `c-${n}`,
      updatedAt: `2026-10-${String(10 + n).padStart(2, '0')}T12:00:00.000Z`,
      messages: [
        msg('user', `question ${n}`),
        { ...reply(`a-${n}`, reached), text: 'x'.repeat(4000) },
      ],
    });

    it('keeps a thread’s reach when its body is trimmed to fit', () => {
      const oldest = reach('needs-auth');
      const threads = [thread(3, reach('connected')), thread(1, oldest), thread(2)];
      quota(JSON.stringify(threads).length - 2000);
      saveConversations(threads);
      const loaded = loadConversations();
      expect(loaded.map((c) => c.messages.length)).toEqual([2, 0, 2]);
      // The oldest lost its body, and with it the reply that said; the
      // thread still knows what its run reached.
      expect(threadReach(loaded[1])).toEqual(oldest);
      expect(threadReach(loaded[0])).toEqual(reach('connected'));
      expect(threadReach(loaded[2])).toBeNull();
    });
  });
});

describe('a branch’s fork (M91.6)', () => {
  const SOURCE = '00000000-0000-4000-8000-000000000001';
  const ANCHOR = '00000000-0000-4000-8000-000000000002';
  const MINTED = '00000000-0000-4000-8000-000000000003';
  const branch = (over: Partial<Conversation> = {}): Conversation => ({
    ...newConversation(),
    id: 'c-branch',
    fork: { from: SOURCE, at: ANCHOR },
    ...over,
  });

  it('keeps a branch’s fork through save and load while it has no session', () => {
    saveConversations([branch()]);
    expect(loadConversations()[0]).toMatchObject({
      sessionId: null,
      fork: { from: SOURCE, at: ANCHOR },
    });
  });

  it('drops a malformed fork, and keeps only a fork’s two ids', () => {
    for (const fork of [
      { from: 'mock-session', at: ANCHOR },
      { from: SOURCE, at: '--resume' },
      { from: SOURCE },
      'not a fork',
      null,
    ]) {
      window.localStorage.setItem('cerebro.conversations', JSON.stringify([{ ...branch(), fork }]));
      const [loaded] = loadConversations();
      expect('fork' in loaded, JSON.stringify(fork)).toBe(false);
      expect(loaded.messages).toEqual([]);
    }
    window.localStorage.setItem(
      'cerebro.conversations',
      JSON.stringify([{ ...branch(), fork: { from: SOURCE, at: ANCHOR, extra: 'x' } }]),
    );
    expect(loadConversations()[0].fork).toEqual({ from: SOURCE, at: ANCHOR });
  });

  it('drops a fork once its thread has a session of its own', () => {
    saveConversations([branch({ sessionId: MINTED })]);
    const [loaded] = loadConversations();
    expect(loaded.sessionId).toBe(MINTED);
    expect('fork' in loaded).toBe(false);
  });

  it('spends a fork when the thread takes a session, and keeps it until then', () => {
    const pending = withSession(branch(), null);
    expect(pending).toMatchObject({ sessionId: null, fork: { from: SOURCE, at: ANCHOR } });
    const forked = withSession(branch(), MINTED);
    expect(forked.sessionId).toBe(MINTED);
    expect('fork' in forked).toBe(false);
    // A thread that never branched only takes the session.
    const plain = { ...newConversation(), id: 'c-plain' };
    expect(withSession(plain, MINTED)).toEqual({ ...plain, sessionId: MINTED });
  });
});

describe('M95 cached generation metadata has no execution authority', () => {
  const key = '1234567890abcdef1234567890abcdef';
  const receipt = {
    generationId: '11111111111111111111111111111111',
    firstRunId: '22222222222222222222222222222222',
    currentRunId: '33333333333333333333333333333333',
    state: 'running',
  };

  it('retains the logical key but never persists a live generation observation as current state', () => {
    const reply = {
      ...msg('assistant', 'Original reply'),
      generationRequestKey: key,
      generationObservation: receipt,
    };
    saveConversations([
      { ...newConversation(), messages: [msg('user', 'Original question'), reply] },
    ]);
    const loaded = loadConversations()[0].messages[1];
    expect(Reflect.get(loaded, 'generationRequestKey')).toBe(key);
    expect(Reflect.get(loaded, 'generationObservation')).toBeUndefined();
    expect(window.localStorage.getItem('cerebro.conversations')).not.toContain(
      'generationObservation',
    );
  });

  it('drops even well-formed injected cache observations rather than treating them as fresh native facts', () => {
    window.localStorage.setItem(
      'cerebro.conversations',
      JSON.stringify([
        {
          ...newConversation(),
          messages: [
            {
              ...msg('assistant', 'Retained words'),
              generationRequestKey: key,
              generationObservation: receipt,
            },
          ],
        },
      ]),
    );
    const loaded = loadConversations()[0].messages[0];
    expect(loaded.text).toBe('Retained words');
    expect(Reflect.get(loaded, 'generationRequestKey')).toBe(key);
    expect(Reflect.get(loaded, 'generationObservation')).toBeUndefined();
  });

  it('drops malformed cached keys and observation objects without losing the neighboring question', () => {
    window.localStorage.setItem(
      'cerebro.conversations',
      JSON.stringify([
        {
          ...newConversation(),
          messages: [
            msg('user', 'Keep my question'),
            {
              ...msg('assistant', 'Keep my reply'),
              generationRequestKey: { run: 99, attach: 'claimed-authority' },
              generationObservation: { currentRunId: 99, state: { kind: 'success' } },
            },
          ],
        },
      ]),
    );
    const loaded = loadConversations()[0].messages;
    expect(loaded.map((message) => message.text)).toEqual(['Keep my question', 'Keep my reply']);
    expect(Reflect.get(loaded[1], 'generationRequestKey')).toBeUndefined();
    expect(Reflect.get(loaded[1], 'generationObservation')).toBeUndefined();
  });
});

describe('M95 cached messages cannot retain an original native reply selector', () => {
  const reply = {
    ...msg('assistant', 'Original reply'),
    nativeRecoveryRoot: { runId: 'original-native-root', vaultPath: '/vault', opening: 4 },
  };
  it('strips the captured selector when saving a thread', () => {
    saveConversations([{ ...newConversation(), messages: [msg('user', 'Question'), reply] }]);
    expect(localStorage.getItem('cerebro.conversations')).not.toContain('nativeRecoveryRoot');
    expect(Reflect.get(loadConversations()[0].messages[1], 'nativeRecoveryRoot')).toBeUndefined();
  });
  it('drops a well-formed selector injected into cached history', () => {
    localStorage.setItem(
      'cerebro.conversations',
      JSON.stringify([{ ...newConversation(), messages: [msg('user', 'Question'), reply] }]),
    );
    expect(Reflect.get(loadConversations()[0].messages[1], 'nativeRecoveryRoot')).toBeUndefined();
  });
});
