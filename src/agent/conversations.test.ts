// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
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
  it('starts untitled and unsessioned', () => {
    const c = newConversation();
    expect(c.title).toBe(DEFAULT_TITLE);
    expect(c.usesDefaultTitle).toBe(true);
    expect(c.sessionId).toBeNull();
  });
});
