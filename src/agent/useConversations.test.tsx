import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useConversations } from './useConversations';
import type { AgentChat } from './useAgentChat';
import type { ChatMessage, Conversation } from './types';
import type { Place } from '@/engine/place';
import { makeEntry } from '@/test/factories';

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

/**
 * Anchoring (M17.5). The panel calls `anchorNow` from a wrapper around every
 * send, so these are the guarantees that wrapper is relying on.
 */
describe('useConversations — where a thread happened', () => {
  const ROADMAP: Place = { kind: 'list', id: 'roadmap', collection: 'product' };
  const INBOX: Place = { kind: 'inbox' };
  let chat: AgentChat;

  beforeEach(() => {
    window.localStorage.clear();
    chat = stubChat();
  });

  it('leaves a thread unanchored until something is actually asked', () => {
    const { result } = renderHook(() => useConversations(chat, ROADMAP));
    // Opening the panel somewhere is not having a conversation there.
    expect(result.current.active?.place ?? null).toBeNull();
    expect(stored()[0]?.place ?? null).toBeNull();
  });

  it('stamps the place, and its name, on the first turn', () => {
    const views = [
      {
        id: 'roadmap',
        collection: 'product',
        project: null,
        path: 'product/roadmap.list.yml',
        definition: {
          name: 'Roadmap',
          icon: null,
          color: null,
          order: null,
          source: { type: null, project: null },
          views: [],
        },
      },
    ];
    const { result } = renderHook(() => useConversations(chat, ROADMAP, { views }));
    act(() => result.current.anchorNow());
    expect(result.current.active?.place).toEqual(ROADMAP);
    expect(result.current.active?.placeLabel).toBe('Roadmap');
    // Persisted immediately: the panel is unmounted on close, and an anchor
    // that only lived in memory would be gone by the next open.
    expect(stored()[0].placeLabel).toBe('Roadmap');
  });

  it('keeps the first anchor when the user walks away mid-conversation', () => {
    const { result, rerender } = renderHook(({ place }) => useConversations(chat, place), {
      initialProps: { place: ROADMAP as Place },
    });
    act(() => result.current.anchorNow());
    rerender({ place: INBOX });
    act(() => result.current.anchorNow());
    // Where a thread STARTED is a fact about the thread. Following the user's
    // feet would make it a fact about the user, and un-findable by subject.
    expect(result.current.active?.place).toEqual(ROADMAP);
  });

  it('anchors a new thread where you are now, not where the last one was', () => {
    const { result, rerender } = renderHook(({ place }) => useConversations(chat, place), {
      initialProps: { place: ROADMAP as Place },
    });
    act(() => result.current.anchorNow());
    rerender({ place: INBOX });
    act(() => result.current.start());
    act(() => result.current.anchorNow());
    expect(result.current.active?.place).toEqual(INBOX);
  });

  it('reports where a thread started once you have walked somewhere else', () => {
    // A FACT, handed to the agent (`startedIn` in the snapshot) and used as a
    // label in the switcher. It was briefly a prompt — "you've moved to X,
    // start a new one here" — which made the app's bookkeeping the user's
    // problem, and was unnecessary: the model holds both places at once.
    const { result, rerender } = renderHook(({ place }) => useConversations(chat, place), {
      initialProps: { place: ROADMAP as Place },
    });
    // Unanchored: it has not started anywhere yet, so there is nothing to say.
    expect(result.current.startedElsewhere).toBeNull();
    act(() => result.current.anchorNow());
    expect(result.current.startedElsewhere).toBeNull();
    rerender({ place: INBOX });
    expect(result.current.startedElsewhere).toBe('roadmap');
  });

  it('reads a thread anchored to a deleted List by the name it had', () => {
    const entries = [makeEntry({ path: 'docs/spec.md', title: 'The spec' })];
    const { result } = renderHook(() =>
      useConversations(chat, { kind: 'doc', path: 'docs/spec.md' }, { entries }),
    );
    act(() => result.current.anchorNow());
    expect(result.current.hereLabel).toBe('The spec');
    expect(result.current.active?.placeLabel).toBe('The spec');
  });
});
