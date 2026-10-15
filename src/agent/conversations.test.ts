// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  anchor,
  DEFAULT_TITLE,
  loadConversations,
  newConversation,
  ordered,
  retitle,
  saveConversations,
  titleFrom,
} from '@/agent/conversations';
import type { ChatMessage, Conversation } from '@/agent/types';
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
