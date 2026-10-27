import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';

// The transcript read is Rust's (M56.3); each test says what it answers.
vi.mock('./agentIpc', () => ({
  readCliTranscript: vi.fn(async () => ({
    state: 'unavailable',
    reason: 'not_recorded',
    retention_days: 30,
  })),
  attachRun: vi.fn(),
  // M57.6: deleting a thread ends its turn.
  stopAgent: vi.fn(async () => true),
  listInteractions: vi.fn(async () => []),
  cancelInteraction: vi.fn(async () => true),
}));

import * as agentIpc from './agentIpc';
import { loadConversations, saveConversations } from './conversations';
import { NO_BRANCH_POINT, NO_SUCH_REPLY, useConversations } from './useConversations';
import { useAgentChat, type AgentChat } from './useAgentChat';
import { Message } from './ChatTurn';
import { TranscriptNotice } from './TranscriptNotice';
import type { ConversationState } from './useConversations';
import { useVaultStore } from '@/stores/vaultStore';
import type {
  AgentEvent,
  AgentStreamEvent,
  ChatMessage,
  Conversation,
  TranscriptRead,
} from './types';
import type { Place } from '@/engine/place';
import { makeEntry } from '@/test/factories';
import { useReviewNotesStore } from '@/stores/reviewNotesStore';
import { useUiStore } from '@/stores/uiStore';

afterEach(cleanup);

/**
 * The list around the live transcript (M9.5), and the two ways it used to
 * lose things (M15): the panel is unmounted on close, so the thread is saved
 * on the way out, with the turn it left running (M57.6), which the next
 * mount re-attaches to.
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
  interaction: null,
  waiting: false,
  answer: vi.fn(),
  send: vi.fn(),
  stop: vi.fn(),
  stopping: false,
  busy: () => false,
  reset: vi.fn(),
  sessionId: null,
  model: null,
  prLinks: [],
  turnEndedAt: null,
  live: null,
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

  it('is ready only once the stored thread has been handed to the chat hook', () => {
    const kept = conversation('kept', {
      messages: [{ id: 'k-1', role: 'user', text: 'What did we decide?', tools: [] }],
    });
    window.localStorage.setItem('cerebro.conversations', JSON.stringify([kept]));
    const restoring = stubChat({ restore: vi.fn() });
    const seen: boolean[] = [];
    renderHook(() => {
      const state = useConversations(restoring);
      seen.push(state.ready);
      return state;
    });
    // The first render's chat hook holds an empty start, not the thread.
    expect(seen[0]).toBe(false);
    expect(seen.at(-1)).toBe(true);
    expect(restoring.restore).toHaveBeenCalledOnce();
    expect(vi.mocked(restoring.restore).mock.calls[0][0]).toEqual(kept.messages);
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

/**
 * Threads that come back from Claude Code's own file (M56.3). The cache is
 * restored at once; the file is read, and either rebuilds a thread with no
 * cache, heals one that has a cache, or blocks one Claude Code no longer has.
 */
describe('useConversations — threads rebuild from the session file', () => {
  const SESSION = '00000000-0000-4000-8000-000000000001';
  const read = vi.mocked(agentIpc.readCliTranscript);
  const events: AgentStreamEvent[] = [
    { kind: 'UserPrompt', text: 'Read a.md' },
    { kind: 'ModelChanged', model: 'claude-haiku-4-5-20251001' },
    { kind: 'ToolStart', tool_name: 'Read', tool_id: 't-1', input: '{"file_path":"a.md"}' },
    { kind: 'ToolDone', tool_id: 't-1', output: 'alpha', is_error: false },
    { kind: 'Text', message_id: 'msg_1', text: 'done' },
    { kind: 'TurnEnded', stop_reason: 'end_turn' },
    {
      kind: 'PrLink',
      number: 7,
      url: 'https://github.com/example/notes/pull/7',
      repository: 'example/notes',
    },
  ];
  const answer = (value: TranscriptRead) => read.mockResolvedValueOnce(value);
  const seed = (...threads: Conversation[]) =>
    window.localStorage.setItem('cerebro.conversations', JSON.stringify(threads));
  const settle = () => act(async () => await Promise.resolve());

  beforeEach(() => {
    window.localStorage.clear();
    read.mockClear();
  });

  it('busy_quota_trim_preserves_prior_turn_availability', async () => {
    const live = { run: 4, attach: 'run-0004', assistantId: 'a-live' };
    const source = conversation('c-busy', {
      sessionId: SESSION,
      vault: '/demo-vault',
      live,
      messages: [
        { id: 'u-prior', role: 'user', text: 'earlier', tools: [] },
        { id: 'a-prior', role: 'assistant', text: 'x'.repeat(4000), tools: [] },
        { id: 'u-live', role: 'user', text: 'now', tools: [] },
        { id: 'a-live', role: 'assistant', text: 'half', tools: [], seq: 9 },
      ],
    });
    const store = window.localStorage;
    const owner = Object.prototype.hasOwnProperty.call(store, 'setItem')
      ? store
      : (Object.getPrototypeOf(store) as Storage);
    const real = owner.setItem;
    const full = vi.spyOn(owner, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === 'cerebro.conversations' && value.length > 1500) {
        throw new DOMException('Full', 'QuotaExceededError');
      }
      real.call(this, key, value);
    });
    saveConversations([source]);
    full.mockRestore();
    const [cached] = loadConversations();
    expect(cached.messages.map((m) => m.text)).toEqual(['now', 'half']);
    expect(cached.live).toEqual(live);
    expect(cached).toMatchObject({ cacheTrimmed: true });
    useVaultStore.setState({ vaultPath: '/demo-vault' });
    useUiStore.setState({ runs: [] });
    let deliver: (event: AgentEvent) => void = () => {};
    vi.mocked(agentIpc.attachRun).mockImplementationOnce(async (handle, after, take, onState) => {
      expect(handle).toEqual({ run: 4, attach: 'run-0004' });
      expect(after).toBe(9);
      let cursor = after;
      deliver = (event) => {
        if (event.run === handle.run && event.seq > cursor) {
          cursor = event.seq;
          take(event);
        }
      };
      onState?.('held', false);
      return { state: 'held', done: false, detach: () => {} };
    });
    let current!: { chat: AgentChat; conversations: ConversationState };
    function Harness() {
      const chat = useAgentChat(
        () => ({ systemPrompt: () => '', place: null, conversationId: 'c-busy' }),
        { shell: 'off', connectors: false },
      );
      const conversations = useConversations(chat, undefined, undefined, '/demo-vault');
      current = { chat, conversations };
      return (
        <>
          {chat.messages.map((message) => (
            <Message key={message.id} message={message} onOpen={() => {}} onOpenPath={() => {}} />
          ))}
          {conversations.transcript.state === 'unavailable' && (
            <TranscriptNotice {...conversations.transcript} cached={chat.messages.length > 0} />
          )}
        </>
      );
    }
    const { unmount } = render(<Harness />);
    await settle();
    const words = () =>
      screen
        .getAllByTestId('chat-message')
        .map((node) => node.querySelector('.cb-chat-answer')?.textContent ?? node.textContent);
    const [questionNode, replyNode] = screen.getAllByTestId('chat-message');
    expect(words()).toEqual(['now', 'half']);
    expect(screen.getByTestId('transcript-unavailable').getAttribute('role')).toBe('status');
    expect(screen.getByTestId('transcript-unavailable').textContent).toContain(
      'Earlier messages unavailable',
    );
    expect(current.chat.live).toEqual(live);
    expect(current.chat.sessionId).toBe(SESSION);
    expect(current.chat.messages.map((m) => m.id)).toEqual(['u-live', 'a-live']);
    expect(current.chat.streaming).toBe(true);
    expect(current.conversations.blocked).toBeNull();
    act(() => deliver({ run: 4, seq: 10, kind: 'TextDelta', text: ' one' }));
    // Hold before Done: an eventual transcript read cannot hide wrong words
    // or a missing earlier-content notice while the stream is still live.
    expect(words()).toEqual(['now', 'half one']);
    expect(current.chat.messages[1].seq).toBe(10);
    expect(current.chat.streaming).toBe(true);
    expect(screen.getByTestId('transcript-unavailable').getAttribute('role')).toBe('status');
    expect(screen.getByTestId('transcript-unavailable').textContent).toContain(
      'Earlier messages unavailable',
    );
    act(() => deliver({ run: 4, seq: 11, kind: 'TextDelta', text: ' two' }));
    expect(words()).toEqual(['now', 'half one two']);
    answer({ state: 'unavailable', reason: 'not_recorded', retention_days: 30 });
    await act(async () => deliver({ run: 4, seq: 12, kind: 'Done' }));
    await settle();
    expect(current.chat.streaming).toBe(false);
    expect(current.chat.live).toBeNull();
    expect(current.chat.sessionId).toBe(SESSION);
    expect(current.chat.messages.map((m) => m.id)).toEqual(['u-live', 'a-live']);
    expect(current.chat.messages[1].seq).toBe(12);
    expect(words()).toEqual(['now', 'half one two']);
    expect(screen.getAllByTestId('chat-message')).toEqual([questionNode, replyNode]);
    expect(screen.getByTestId('transcript-unavailable').getAttribute('role')).toBe('status');
    expect(screen.getByTestId('transcript-unavailable').textContent).toContain(
      'Earlier messages unavailable',
    );
    expect(read).toHaveBeenCalledWith('/demo-vault', SESSION, null);
    unmount();
    answer({ state: 'unavailable', reason: 'not_recorded', retention_days: 30 });
    const reopened = renderHook(() =>
      useConversations(stubChat(), undefined, undefined, '/demo-vault'),
    );
    await settle();
    expect(reopened.result.current.transcript).toMatchObject({
      state: 'unavailable',
      reason: 'cache_trimmed',
    });
  });

  it('stamps the vault and persists the session id mid-turn', () => {
    let chat = stubChat();
    const { result, rerender } = renderHook(() =>
      useConversations(chat, undefined, undefined, '/demo-vault'),
    );
    act(() => result.current.anchorNow());
    expect(stored()[0].vault).toBe('/demo-vault');
    chat = stubChat({ streaming: true, sessionId: SESSION });
    rerender();
    expect(stored()[0].sessionId).toBe(SESSION);
  });

  it('rebuilds a thread with no cached messages from its transcript', async () => {
    seed(conversation('c-1', { sessionId: SESSION, vault: '/demo-vault' }));
    answer({ state: 'read', events, lines: 9, unclassified: [] });
    const chat = stubChat();
    const { result } = renderHook(() =>
      useConversations(chat, undefined, undefined, '/demo-vault'),
    );
    expect(result.current.transcript.state).toBe('reading');
    await settle();
    expect(read).toHaveBeenCalledWith('/demo-vault', SESSION, '2026-01-01T00:00:00.000Z');
    expect(result.current.transcript.state).toBe('rebuilt');
    const [messages, session, facts] = vi.mocked(chat.restore).mock.calls.at(-1) ?? [];
    expect(session).toBe(SESSION);
    expect(messages?.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Read a.md'],
      ['assistant', 'done'],
    ]);
    expect(messages?.[1].tools[0]).toMatchObject({ id: 't-1', done: true, output: 'alpha' });
    expect(facts).toEqual({
      model: 'claude-haiku-4-5-20251001',
      prLinks: [
        { number: 7, url: 'https://github.com/example/notes/pull/7', repository: 'example/notes' },
      ],
    });
    expect(result.current.blocked).toBeNull();
  });

  it('clears the omission marker only when the whole empty cache is rebuilt', async () => {
    seed(conversation('c-1', { sessionId: SESSION, cacheTrimmed: true }));
    answer({ state: 'read', events, lines: 9, unclassified: [] });
    const { result } = renderHook(() =>
      useConversations(stubChat(), undefined, undefined, '/demo-vault'),
    );
    await settle();
    expect(result.current.transcript.state).toBe('rebuilt');
    expect(result.current.active?.cacheTrimmed).toBeUndefined();
  });

  it('a partial cache heal does not claim omitted messages were recovered', async () => {
    const cached: ChatMessage[] = [
      { id: 'u-live', role: 'user', text: 'now', tools: [] },
      { id: 'a-live', role: 'assistant', text: 'half done', tools: [] },
    ];
    seed(conversation('c-1', { sessionId: SESSION, messages: cached, cacheTrimmed: true }));
    answer({ state: 'read', events, lines: 9, unclassified: [] });
    const { result } = renderHook(() =>
      useConversations(stubChat(), undefined, undefined, '/demo-vault'),
    );
    await settle();
    expect(result.current.transcript).toMatchObject({
      state: 'unavailable',
      reason: 'cache_trimmed',
    });
    expect(result.current.active?.cacheTrimmed).toBe(true);
  });

  it('reads an expired thread as cleared by Claude Code, and blocks it', async () => {
    seed(conversation('c-1', { sessionId: SESSION, updatedAt: '2026-05-01T00:00:00.000Z' }));
    answer({ state: 'unavailable', reason: 'expired', retention_days: 30 });
    const { result } = renderHook(() =>
      useConversations(stubChat(), undefined, undefined, '/demo-vault'),
    );
    await settle();
    expect(read).toHaveBeenCalledWith('/demo-vault', SESSION, '2026-05-01T00:00:00.000Z');
    expect(result.current.transcript).toEqual({
      state: 'unavailable',
      reason: 'expired',
      retentionDays: 30,
    });
    expect(result.current.blocked).toBe('expired');
  });

  it('blocks a cleared thread, and leaves an unreadable one open', async () => {
    seed(conversation('c-1', { sessionId: SESSION }), conversation('c-2', { sessionId: SESSION }));
    answer({ state: 'unavailable', reason: 'cleared', retention_days: 30 });
    const { result } = renderHook(() =>
      useConversations(stubChat(), undefined, undefined, '/demo-vault'),
    );
    await settle();
    expect(result.current.blocked).toBe('cleared');
    answer({ state: 'unavailable', reason: 'unreadable', retention_days: 30, detail: 'denied' });
    act(() => result.current.select('c-2'));
    await settle();
    expect(result.current.transcript).toMatchObject({ state: 'unavailable', reason: 'unreadable' });
    expect(result.current.blocked).toBeNull();
  });

  it('blocks a thread from another vault as elsewhere', async () => {
    seed(conversation('c-1', { sessionId: SESSION, vault: '/other-vault' }));
    answer({ state: 'read', events, lines: 9, unclassified: [] });
    const { result } = renderHook(() =>
      useConversations(stubChat(), undefined, undefined, '/demo-vault'),
    );
    await settle();
    expect(read).toHaveBeenCalledWith('/other-vault', SESSION, expect.any(String));
    expect(result.current.blocked).toBe('elsewhere');
  });

  it('changes nothing when the read lands after a send', async () => {
    seed(conversation('c-1', { sessionId: SESSION }));
    let land: (value: TranscriptRead) => void = () => {};
    read.mockImplementationOnce(() => new Promise((resolve) => (land = resolve)));
    const chat = stubChat();
    const { result } = renderHook(() =>
      useConversations(chat, undefined, undefined, '/demo-vault'),
    );
    expect(vi.mocked(chat.restore)).toHaveBeenCalledTimes(1);
    act(() => result.current.anchorNow());
    await act(async () => {
      land({ state: 'read', events, lines: 9, unclassified: [] });
      await Promise.resolve();
    });
    expect(vi.mocked(chat.restore)).toHaveBeenCalledTimes(1);
    expect(result.current.transcript.state).toBe('reading');
  });

  it('heals a cached thread’s unfinished tools by id, keeping its wording', async () => {
    const cached: ChatMessage[] = [
      { id: 'm-1', role: 'user', text: 'read a, as typed', tools: [] },
      {
        id: 'm-2',
        role: 'assistant',
        text: 'cut short',
        tools: [{ id: 't-1', name: 'Read', input: null, output: null, done: false, failed: false }],
      },
    ];
    seed(conversation('c-1', { sessionId: SESSION, messages: cached }));
    answer({ state: 'read', events, lines: 9, unclassified: [] });
    const chat = stubChat();
    const { result } = renderHook(() =>
      useConversations(chat, undefined, undefined, '/demo-vault'),
    );
    await settle();
    expect(result.current.transcript.state).toBe('healed');
    const [messages] = vi.mocked(chat.restore).mock.calls.at(-1) ?? [];
    expect(messages?.map((m) => m.text)).toEqual(['read a, as typed', 'cut short']);
    expect(messages?.[1].tools[0]).toMatchObject({ id: 't-1', done: true, output: 'alpha' });
  });
});

describe('useConversations — a conversation’s model and effort (M56.5)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('persists the pick per thread, and a thread switch restores it', () => {
    window.localStorage.setItem(
      'cerebro.conversations',
      JSON.stringify([conversation('a'), conversation('b', { model: 'sonnet', effort: 'low' })]),
    );
    window.localStorage.setItem('cerebro.activeConversation', 'a');
    const chat = stubChat();
    const { result } = renderHook(() => useConversations(chat));
    act(() => result.current.setRunOptions('a', { model: 'opus', effort: 'high' }));
    expect(result.current.active?.model).toBe('opus');
    expect(result.current.active?.effort).toBe('high');
    expect(stored().find((c) => c.id === 'a')).toMatchObject({ model: 'opus', effort: 'high' });

    act(() => result.current.select('b'));
    expect([result.current.active?.model, result.current.active?.effort]).toEqual([
      'sonnet',
      'low',
    ]);
    act(() => result.current.select('a'));
    expect(result.current.active?.model).toBe('opus');

    // Back to Claude Code's default.
    act(() => result.current.setRunOptions('a', { model: null, effort: null }));
    expect(stored().find((c) => c.id === 'a')).toMatchObject({ model: null, effort: null });
  });

  it('drops a stored pick Rust would refuse on load', () => {
    window.localStorage.setItem(
      'cerebro.conversations',
      JSON.stringify([conversation('a', { model: '--model', effort: 'turbo' })]),
    );
    const chat = stubChat();
    const { result } = renderHook(() => useConversations(chat));
    expect([result.current.active?.model, result.current.active?.effort]).toEqual([null, null]);
  });
});

describe('useConversations — a turn outlives its panel (M57.6)', () => {
  const LIVE = { run: 8, attach: 'run-0008', assistantId: 'a-2' };
  const S1 = '00000000-0000-4000-8000-0000000000b1';
  const S2 = '00000000-0000-4000-8000-0000000000b2';
  const midTurn: ChatMessage[] = [
    { id: 'a-1', role: 'user', text: 'summarise note-a', tools: [] },
    { id: 'a-2', role: 'assistant', text: 'half', tools: [], streaming: true, seq: 6 },
  ];
  const seed = (...threads: Conversation[]) =>
    window.localStorage.setItem('cerebro.conversations', JSON.stringify(threads));

  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(agentIpc.stopAgent).mockClear();
    vi.mocked(agentIpc.cancelInteraction).mockClear();
    vi.mocked(agentIpc.listInteractions).mockReset();
    vi.mocked(agentIpc.listInteractions).mockResolvedValue([]);
    useUiStore.setState({ panelConversation: null });
  });

  it('a switch saves live with the messages', () => {
    seed(conversation('c-1'), conversation('c-2'));
    window.localStorage.setItem('cerebro.activeConversation', 'c-1');
    const chat = stubChat({ messages: midTurn, streaming: true, live: LIVE });
    const { result } = renderHook(() => useConversations(chat));
    act(() => result.current.select('c-2'));
    const left = stored().find((c) => c.id === 'c-1');
    expect(left?.live).toEqual(LIVE);
    expect(left?.messages.map((m) => m.text)).toEqual(['summarise note-a', 'half']);
    expect(left?.messages[1].seq).toBe(6);
    expect(vi.mocked(chat.restore).mock.calls.at(-1)?.[0]).toEqual([]);
  });

  it('saves the skeleton with live as soon as the turn has its run', () => {
    let chat = stubChat();
    const { rerender } = renderHook(() => useConversations(chat));
    chat = stubChat({ messages: midTurn, streaming: true, live: LIVE });
    rerender();
    expect(stored()[0].live).toEqual(LIVE);
    expect(stored()[0].messages).toHaveLength(2);
  });

  it('the unmount save keeps live and the reply’s seq, not an interrupted mark', () => {
    const chat = stubChat({ messages: midTurn, streaming: true, sessionId: S1, live: LIVE });
    const { unmount } = renderHook(() => useConversations(chat));
    unmount();
    const saved = stored()[0];
    expect(saved.live).toEqual(LIVE);
    expect(saved.messages[1].seq).toBe(6);
    expect(saved.messages[1].interrupted).toBeUndefined();
    expect(saved.messages.some((m) => 'streaming' in m)).toBe(false);
  });

  it('hydrate hands live to restore, and reads no transcript for it', () => {
    seed(conversation('c-1', { messages: midTurn, sessionId: S1, live: LIVE }));
    const chat = stubChat();
    renderHook(() => useConversations(chat, undefined, undefined, '/demo-vault'));
    const call = vi.mocked(chat.restore).mock.calls.at(-1);
    expect(call?.[1]).toBe(S1);
    expect(call?.[3]).toEqual(LIVE);
    expect(vi.mocked(agentIpc.readCliTranscript)).not.toHaveBeenCalledWith(
      '/demo-vault',
      S1,
      expect.anything(),
    );
  });

  it('deleting a thread stops its run and cancels its card, active or not', async () => {
    vi.mocked(agentIpc.listInteractions).mockResolvedValue([
      {
        id: 'e'.repeat(32),
        kind: 'permission',
        tool_name: 'Bash',
        tool_id: 't-1',
        session_id: S2,
        summary: 'Bash',
        input: '{}',
        asked_at: '2026-10-14T12:00:00.000Z',
      },
    ]);
    seed(
      conversation('c-1'),
      conversation('c-2', { messages: midTurn, sessionId: S2, live: LIVE }),
    );
    window.localStorage.setItem('cerebro.activeConversation', 'c-1');
    const chat = stubChat({ live: { run: 3, attach: 'run-0003', assistantId: 'x' } });
    const { result } = renderHook(() =>
      useConversations(chat, undefined, undefined, '/demo-vault'),
    );
    act(() => result.current.remove('c-2'));
    expect(vi.mocked(agentIpc.stopAgent)).toHaveBeenCalledExactlyOnceWith(8);
    await vi.waitFor(() =>
      expect(vi.mocked(agentIpc.cancelInteraction)).toHaveBeenCalledWith('e'.repeat(32)),
    );
    act(() => result.current.remove('c-1'));
    expect(vi.mocked(agentIpc.stopAgent)).toHaveBeenLastCalledWith(3);
  });

  it('deleting a thread removes its review notes (M58.5)', () => {
    seed(conversation('c-1'), conversation('c-2'));
    window.localStorage.setItem('cerebro.activeConversation', 'c-1');
    useReviewNotesStore.setState({ notes: [] });
    const note = {
      vault: '/demo-vault',
      runId: null,
      commit: 'c'.repeat(40),
      path: 'a.md',
      side: 'new' as const,
      start: 1,
      end: 1,
      excerpt: '',
      text: 'Fix.',
    };
    useReviewNotesStore.getState().add({ ...note, conversationId: 'c-1' });
    useReviewNotesStore.getState().add({ ...note, conversationId: 'c-2' });
    const { result } = renderHook(() =>
      useConversations(stubChat(), undefined, undefined, '/demo-vault'),
    );
    act(() => result.current.remove('c-2'));
    expect(useReviewNotesStore.getState().notes.map((n) => n.conversationId)).toEqual(['c-1']);
  });

  it('opens the conversation the run list asked for, on mount and while open', () => {
    seed(conversation('c-1'), conversation('c-2'), conversation('c-3'));
    window.localStorage.setItem('cerebro.activeConversation', 'c-1');
    useUiStore.setState({ panelConversation: 'c-2' });
    const chat = stubChat();
    const { result } = renderHook(() => useConversations(chat));
    expect(result.current.activeId).toBe('c-2');
    expect(useUiStore.getState().panelConversation).toBeNull();
    act(() => useUiStore.getState().showConversation('c-3'));
    expect(result.current.activeId).toBe('c-3');
    expect(useUiStore.getState().panelConversation).toBeNull();
  });
});

/**
 * Branch from here (M91.6): a new thread holding a reply and the turns
 * before it, opened, whose sends fork the reply's session at its anchor
 * until the thread has a session of its own.
 */
describe('useConversations branches a thread (M91.6)', () => {
  const SOURCE = '00000000-0000-4000-8000-000000000001';
  const FIRST = '00000000-0000-4000-8000-000000000011';
  const SECOND = '00000000-0000-4000-8000-000000000022';
  const MINTED = '00000000-0000-4000-8000-000000000033';
  const ROADMAP: Place = { kind: 'list', id: 'roadmap', collection: 'product' };
  const thread: ChatMessage[] = [
    { id: 'u-1', role: 'user', text: 'What is at risk?', tools: [] },
    {
      id: 'a-1',
      role: 'assistant',
      text: 'The scanner delivery.',
      tools: [],
      anchor: { sessionId: SOURCE, uuid: FIRST },
      changesets: [],
    },
    { id: 'u-2', role: 'user', text: 'And if it slips?', tools: [] },
    {
      id: 'a-2',
      role: 'assistant',
      text: 'The rollout moves a week.',
      tools: [],
      anchor: { sessionId: SOURCE, uuid: SECOND },
    },
  ];
  const source = (over: Partial<Conversation> = {}): Conversation => ({
    id: 'c-source',
    title: 'Release risks',
    usesDefaultTitle: false,
    sessionId: SOURCE,
    messages: thread,
    createdAt: '2026-01-01T00:00:00.000Z',
    archived: false,
    vault: '/demo-vault',
    place: ROADMAP,
    placeLabel: 'Roadmap',
    model: 'sonnet',
    effort: 'high',
    ...over,
  });
  const seed = (...threads: Conversation[]) =>
    window.localStorage.setItem('cerebro.conversations', JSON.stringify(threads));

  /** A chat stand-in whose restore holds the thread it is handed, as the
   * real hook does, so the list mirrors the thread it opened. */
  const holding = (): AgentChat => {
    const chat = stubChat();
    chat.restore = vi.fn((messages: ChatMessage[], sessionId: string | null) => {
      chat.messages = messages;
      chat.sessionId = sessionId;
    });
    return chat;
  };

  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.setState({ toasts: [], panelConversation: null });
    vi.mocked(agentIpc.stopAgent).mockClear();
    vi.mocked(agentIpc.cancelInteraction).mockClear();
    vi.mocked(agentIpc.readCliTranscript).mockClear();
  });

  it('opens a new thread holding the turns up to the reply, forking its session there', () => {
    seed(conversation('c-other'), source());
    const chat = holding();
    const { result } = renderHook(() =>
      useConversations(chat, undefined, undefined, '/demo-vault'),
    );
    expect(result.current.activeId).toBe('c-other');
    let id: string | null = null;
    act(() => {
      id = result.current.branchFrom('c-source', 'a-1');
    });
    expect(id).not.toBeNull();
    expect(result.current.activeId).toBe(id);
    const branch = result.current.active;
    expect(branch).toMatchObject({
      title: 'Release risks',
      usesDefaultTitle: false,
      sessionId: null,
      fork: { from: SOURCE, at: FIRST },
      vault: '/demo-vault',
      place: ROADMAP,
      placeLabel: 'Roadmap',
      model: 'sonnet',
      effort: 'high',
    });
    expect(branch?.messages).toEqual(thread.slice(0, 2));
    // Opened in the chat hook with its fork, and nothing read: it has no
    // session file of its own yet.
    expect(vi.mocked(chat.restore).mock.calls.at(-1)).toEqual([
      thread.slice(0, 2),
      null,
      undefined,
      null,
      { from: SOURCE, at: FIRST },
    ]);
    expect(agentIpc.readCliTranscript).not.toHaveBeenCalled();
    expect(result.current.transcript).toEqual({ state: 'idle' });
    // Persisted first in the list, beside its source, which keeps every turn.
    const saved = stored();
    expect(saved[0]).toMatchObject({ id, fork: { from: SOURCE, at: FIRST } });
    expect(saved.find((c) => c.id === 'c-source')?.messages).toHaveLength(4);
    expect(result.current.conversations[0].id).toBe(id);
  });

  it('copies the open thread as its chat hook holds it, without its live turn', () => {
    seed(source({ messages: thread.slice(0, 3) }));
    const chat = holding();
    const { result, rerender } = renderHook(() => useConversations(chat));
    // The turn since: its reasoning in memory only, and a new one streaming.
    const reasoned: ChatMessage = {
      ...thread[3],
      parts: [
        { kind: 'reasoning', id: 'r-1', text: 'Weighing the dates.' },
        { kind: 'text', id: 't-1', text: 'The rollout moves a week.' },
      ],
    };
    chat.messages = [
      ...thread.slice(0, 3),
      reasoned,
      { id: 'u-3', role: 'user', text: 'Who decides?', tools: [] },
      { id: 'a-3', role: 'assistant', text: 'Half an an', tools: [], streaming: true, seq: 4 },
    ];
    chat.streaming = true;
    rerender();
    act(() => {
      result.current.branchFrom('c-source', 'a-2');
    });
    const branch = result.current.active;
    expect(branch?.messages).toEqual([...thread.slice(0, 3), reasoned]);
    expect(branch?.fork).toEqual({ from: SOURCE, at: SECOND });
    // The thread it leaves keeps its turn running and its card waiting.
    expect(agentIpc.stopAgent).not.toHaveBeenCalled();
    expect(agentIpc.cancelInteraction).not.toHaveBeenCalled();
    expect(stored().find((c) => c.id === 'c-source')?.messages).toHaveLength(6);
  });

  it('copies no run reach from the open thread: the branch has not run yet', () => {
    seed(source());
    const chat = holding();
    const { result, rerender } = renderHook(() => useConversations(chat));
    const reach = {
      connectors: [],
      missing: [],
      missing_more: 0,
      inherits: false,
      permission_mode: 'default',
      cerebro: true,
      families: {},
    };
    chat.messages = thread.map((m) => (m.role === 'assistant' ? { ...m, reach } : m));
    rerender();
    let id: string | null = null;
    act(() => {
      id = result.current.branchFrom('c-source', 'a-2');
    });
    expect(result.current.active?.messages).toEqual(thread);
    const saved = stored().find((c) => c.id === id);
    expect(saved?.reach ?? null).toBeNull();
  });

  it('forks a reply carried from an earlier branch at the session its anchor names', () => {
    const OLDER = '00000000-0000-4000-8000-000000000044';
    seed(
      source({
        sessionId: null,
        fork: { from: OLDER, at: SECOND },
        messages: thread.map((m) =>
          m.anchor === undefined ? m : { ...m, anchor: { sessionId: OLDER, uuid: m.anchor.uuid } },
        ),
      }),
    );
    const chat = holding();
    const { result } = renderHook(() => useConversations(chat));
    act(() => {
      result.current.branchFrom('c-source', 'a-1');
    });
    expect(result.current.active?.fork).toEqual({ from: OLDER, at: FIRST });
  });

  it('refuses, with a toast and no new thread, a reply with no anchor or no reply at all', () => {
    seed(
      source({
        messages: [thread[0], { ...thread[1], anchor: undefined }, thread[2], thread[3]],
      }),
    );
    const chat = holding();
    const { result } = renderHook(() => useConversations(chat));
    const restores = vi.mocked(chat.restore).mock.calls.length;
    for (const [thread, messageId, words] of [
      ['c-source', 'a-1', NO_BRANCH_POINT],
      ['c-source', 'u-2', NO_BRANCH_POINT],
      ['c-source', 'a-404', NO_SUCH_REPLY],
      ['c-404', 'a-2', NO_SUCH_REPLY],
    ] as const) {
      let id: string | null = 'unset';
      act(() => {
        id = result.current.branchFrom(thread, messageId);
      });
      expect(id, messageId).toBeNull();
      expect(useUiStore.getState().toasts.at(-1)?.message, messageId).toBe(words);
    }
    expect(result.current.conversations.map((c) => c.id)).toEqual(['c-source']);
    expect(result.current.activeId).toBe('c-source');
    expect(vi.mocked(chat.restore).mock.calls.length).toBe(restores);
  });

  it('spends the fork once the chat hook names the session Rust minted, and not before', () => {
    seed(source());
    const chat = holding();
    const { result, rerender } = renderHook(() => useConversations(chat));
    let id: string | null = null;
    act(() => {
      id = result.current.branchFrom('c-source', 'a-1');
    });
    // A send that failed leaves the thread with no session: its fork waits
    // for the retry.
    chat.messages = [
      ...thread.slice(0, 2),
      { id: 'u-3', role: 'user', text: 'Who decides?', tools: [] },
      { id: 'a-3', role: 'assistant', text: '', tools: [], error: 'Claude Code was not found.' },
    ];
    rerender();
    expect(stored().find((c) => c.id === id)).toMatchObject({
      sessionId: null,
      fork: { from: SOURCE, at: FIRST },
    });
    expect(stored().find((c) => c.id === id)?.messages).toHaveLength(4);
    chat.sessionId = MINTED;
    rerender();
    const saved = stored().find((c) => c.id === id);
    expect(saved?.sessionId).toBe(MINTED);
    expect(saved !== undefined && 'fork' in saved).toBe(false);
    expect(result.current.active?.fork).toBeUndefined();
  });
});
