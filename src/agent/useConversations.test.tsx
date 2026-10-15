import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

// The transcript read is Rust's (M56.3); each test says what it answers.
vi.mock('./agentIpc', () => ({
  readCliTranscript: vi.fn(async () => ({
    state: 'unavailable',
    reason: 'not_recorded',
    retention_days: 30,
  })),
  // M57.6: deleting a thread ends its turn.
  stopAgent: vi.fn(async () => true),
  listInteractions: vi.fn(async () => []),
  cancelInteraction: vi.fn(async () => true),
}));

import * as agentIpc from './agentIpc';
import { useConversations } from './useConversations';
import type { AgentChat } from './useAgentChat';
import type { AgentStreamEvent, ChatMessage, Conversation, TranscriptRead } from './types';
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
