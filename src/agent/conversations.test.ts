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
  const write = (place: unknown, placeLabel?: unknown) =>
    window.localStorage.setItem(
      'cerebro.conversations',
      JSON.stringify([
        { id: 'c-1', title: 'x', usesDefaultTitle: true, messages: [], place, placeLabel },
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
