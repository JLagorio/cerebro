import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { useConversations } from './useConversations';
import type { AgentChat } from './useAgentChat';
import type { ChatMessage, Conversation } from './types';

afterEach(cleanup);

/**
 * The list around the live transcript (M9.5), and the two ways it used to
 * lose things (M15): the panel is unmounted on close, so anything that only
 * happened while it was mounted happened for the last time on the way out.
 */

const conversation = (id: string, over: Partial<Conversation> = {}): Conversation => ({
  id,
  title: id,
  usesDefaultTitle: true,
  sessionId: null,
  messages: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  archived: false,
  ...over,
});

const NO_MESSAGES: ChatMessage[] = [];

/** Built ONCE per test and handed to every render: the hook mirrors on the
 * identity of `messages`, so a stub rebuilt per render would loop forever. */
const stubChat = (over: Partial<AgentChat> = {}): AgentChat => ({
  messages: NO_MESSAGES,
  streaming: false,
  send: vi.fn(),
  stop: vi.fn(),
  reset: vi.fn(),
  sessionId: null,
  restore: vi.fn(),
  ...over,
});

const stored = (): Conversation[] =>
  JSON.parse(window.localStorage.getItem('cerebro.conversations') ?? '[]') as Conversation[];

describe('useConversations', () => {
  let chat: AgentChat;

  beforeEach(() => {
    window.localStorage.clear();
    chat = stubChat();
  });

  it('reopens on the conversation you were last in, not the newest one', () => {
    window.localStorage.setItem(
      'cerebro.conversations',
      JSON.stringify([conversation('newest'), conversation('older')]),
    );
    window.localStorage.setItem('cerebro.activeConversation', 'older');
    const { result } = renderHook(() => useConversations(chat));
    expect(result.current.activeId).toBe('older');
  });

  it('falls back to the first stored conversation when the remembered one is gone', () => {
    window.localStorage.setItem(
      'cerebro.conversations',
      JSON.stringify([conversation('newest'), conversation('older')]),
    );
    window.localStorage.setItem('cerebro.activeConversation', 'deleted-elsewhere');
    const { result } = renderHook(() => useConversations(chat));
    expect(result.current.activeId).toBe('newest');
  });

  it('records the active conversation so the next mount can find it', () => {
    const { result } = renderHook(() => useConversations(chat));
    expect(window.localStorage.getItem('cerebro.activeConversation')).toBe(result.current.activeId);
  });

  it('persists the exchange when the panel is closed MID-TURN', () => {
    // The critical one: closing the assistant while a reply streamed used to
    // destroy the question and the partial answer permanently, because the
    // mirror effect deliberately skips persistence while streaming.
    const messages: ChatMessage[] = [
      { id: 'a-1', role: 'user', text: 'summarise note-a', tools: [] },
      { id: 'a-2', role: 'assistant', text: 'half an ans', tools: [], streaming: true },
    ];
    const streamingChat = stubChat({ messages, streaming: true, sessionId: 'sess-1' });
    const { unmount } = renderHook(() => useConversations(streamingChat));
    expect(stored()[0]?.messages ?? []).toHaveLength(0);
    unmount();
    const saved = stored()[0];
    expect(saved.messages.map((m) => m.text)).toEqual(['summarise note-a', 'half an ans']);
    expect(saved.sessionId).toBe('sess-1');
    // A conversation that reopens claiming to still be thinking is worse than
    // one that reopens finished.
    expect(saved.messages.some((m) => 'streaming' in m)).toBe(false);
    // It is titled from the question, like any other finished turn.
    expect(saved.title).toBe('summarise note-a');
  });

  it('adds nothing on the way out when there was nothing to say', () => {
    const { unmount } = renderHook(() => useConversations(chat));
    const before = stored();
    unmount();
    expect(stored()).toEqual(before);
    expect(stored()[0].messages).toHaveLength(0);
  });
});
