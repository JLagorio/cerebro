import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ChatMessage } from './types';
import type { AgentChat, TurnContext } from './useAgentChat';
import { HANDOFF_FULL, useUpNext, type SendNow, type SkillResolution } from './useUpNext';
import { statusOf, useReviewNotesStore } from '@/stores/reviewNotesStore';
import { useUiStore } from '@/stores/uiStore';
import { useUpNextStore } from '@/stores/upNextStore';

afterEach(cleanup);

const turnOf = (label: string): TurnContext => ({
  systemPrompt: () => label,
  place: null,
  conversationId: 'c-1',
});

const user = (text: string): ChatMessage => ({ id: `u-${text}`, role: 'user', text, tools: [] });
const reply = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'a-1',
  role: 'assistant',
  text: 'An answer.',
  tools: [],
  ...over,
});

/** The chat hook as Up next reads it: what a test sets, and a Stop it can
 * script. `busy()` and `stop` are stable, as the real hook's are. */
function fakeChat() {
  const state = {
    streaming: false,
    stopping: false,
    waiting: false,
    messages: [] as ChatMessage[],
  };
  const stop = vi.fn();
  const busy = () => state.streaming || state.stopping || state.waiting;
  const view = (): AgentChat => ({ ...state, busy, stop }) as unknown as AgentChat;
  return { state, stop, view };
}

const resolve = vi.fn((text: string): SkillResolution =>
  text.trim().startsWith('/')
    ? {
        text: text.trim(),
        skill: { path: 'skills/weekly.md' },
        expand: expandSkill,
        narrowing: { allowedTools: ['get_note'] },
      }
    : { text: text.trim(), skill: null, expand: null, narrowing: {} },
);
const expandSkill = vi.fn(() => Promise.resolve('EXPANDED BODY'));

function setup() {
  const chat = fakeChat();
  // A send makes the conversation busy in the same tick, as the real one's
  // turnInFlight does.
  const sendNow = vi.fn<SendNow>(() => {
    chat.state.streaming = true;
  });
  let turn = turnOf('context: Roadmap');
  const hook = renderHook(() =>
    useUpNext({
      chat: chat.view(),
      conversationId: 'c-1',
      vault: '/vault',
      getTurn: () => turn,
      resolve,
      sendNow,
    }),
  );
  /** Change the chat's state and render, as a run's event would. */
  const set = (next: Partial<typeof chat.state>) =>
    act(() => {
      Object.assign(chat.state, next);
      hook.rerender();
    });
  const walk = (label: string) => {
    turn = turnOf(label);
  };
  return { ...hook, chat, sendNow, set, walk };
}

const queue = () => useUpNextStore.getState().queues['c-1'];

describe('useUpNext (M57.5)', () => {
  beforeEach(() => {
    useUpNextStore.setState({ queues: {} });
    useUiStore.setState({ toasts: [] });
    resolve.mockClear();
    expandSkill.mockClear();
  });

  it('freezes all skill restrictions while the queued turn waits', () => {
    const narrowing = {
      allowedTools: ['get_note'],
      connectors: ['gmail'],
      disallowedTools: ['mcp__gmail__trash_thread'],
    };
    resolve.mockReturnValueOnce({
      text: '/draft-reply abc',
      skill: { path: 'skills/draft-reply.md' },
      expand: expandSkill,
      narrowing,
    });
    const { result, set, sendNow } = setup();
    set({ streaming: true });
    act(() => {
      result.current.submit({ text: '/draft-reply abc' });
    });
    narrowing.allowedTools.push('create_note');
    narrowing.connectors.push('notion');
    narrowing.disallowedTools.length = 0;
    set({ streaming: false, messages: [user('first'), reply()] });
    expect(sendNow.mock.calls[0][2]).toEqual({
      allowedTools: ['get_note'],
      connectors: ['gmail'],
      disallowedTools: ['mcp__gmail__trash_thread'],
    });
  });

  it('starts the head with its frozen context once a turn ends on its own', () => {
    const { result, set, sendNow, walk } = setup();
    set({ streaming: true, messages: [user('first'), reply({ streaming: true })] });
    let answer = '';
    act(() => {
      answer = result.current.submit({ text: 'follow up' });
    });
    expect(answer).toBe('queued');
    expect(sendNow).not.toHaveBeenCalled();
    // The person walks elsewhere while the entry waits.
    walk('context: Inbox');
    set({ streaming: false, messages: [user('first'), reply()] });
    expect(sendNow).toHaveBeenCalledOnce();
    const [text, message, tools, frozen] = sendNow.mock.calls[0];
    expect(text).toBe('follow up');
    expect(typeof message).toBe('function');
    expect(tools).toEqual({});
    expect((frozen as TurnContext).systemPrompt({} as never)).toBe('context: Roadmap');
    expect(result.current.entries).toEqual([]);
  });

  it.each([
    ['cancelled', { cancelled: true as const, interrupted: true }],
    ['failed', { error: 'API Error: 500' }],
    ['interrupted', { interrupted: true }],
  ])('holds after a %s turn, and Resume starts the head', (_, ended) => {
    const { result, set, sendNow } = setup();
    set({ streaming: true });
    act(() => void result.current.submit({ text: 'later' }));
    set({ streaming: false, messages: [user('first'), reply(ended)] });
    expect(sendNow).not.toHaveBeenCalled();
    expect(result.current.held).toBe(true);
    act(() => result.current.resume());
    expect(sendNow).toHaveBeenCalledOnce();
    expect(sendNow.mock.calls[0][0]).toBe('later');
    expect(result.current.held).toBe(false);
  });

  it('Steer moves its entry first, stops the turn, and starts it only after Done', () => {
    const { result, set, sendNow, chat } = setup();
    set({ streaming: true });
    act(() => void result.current.submit({ text: 'one' }));
    act(() => void result.current.submit({ text: 'two' }));
    const two = result.current.entries[1].id;
    act(() => result.current.steer(two));
    expect(chat.stop).toHaveBeenCalledOnce();
    expect(result.current.entries.map((e) => e.text)).toEqual(['two', 'one']);
    expect(result.current.steering).toBe(two);
    // Stopping: the child is in its grace, so nothing starts yet.
    set({ stopping: true });
    expect(sendNow).not.toHaveBeenCalled();
    // A second Steer while the first is starting does nothing.
    act(() => result.current.steer(result.current.entries[1].id));
    expect(chat.stop).toHaveBeenCalledOnce();
    expect(result.current.steering).toBe(two);
    // The stopped run's Done: the steered entry starts, and Up next is not
    // held for the cancel Steer caused.
    set({
      streaming: false,
      stopping: false,
      messages: [user('first'), reply({ cancelled: true, interrupted: true })],
    });
    expect(sendNow).toHaveBeenCalledOnce();
    expect(sendNow.mock.calls[0][0]).toBe('two');
    expect(result.current.held).toBe(false);
    expect(result.current.steering).toBeNull();
    expect(result.current.entries.map((e) => e.text)).toEqual(['one']);
  });

  it('Steer with a card open starts at once: the card has no child to wait for', () => {
    const { result, set, sendNow, chat } = setup();
    set({ streaming: true, waiting: true });
    act(() => void result.current.submit({ text: 'instead' }));
    chat.stop.mockImplementationOnce(() => {
      // The real hook refuses the card and ends the turn in the same call.
      Object.assign(chat.state, {
        streaming: false,
        waiting: false,
        messages: [user('first'), reply({ cancelled: true })],
      });
    });
    act(() => result.current.steer(result.current.entries[0].id));
    set({});
    expect(sendNow).toHaveBeenCalledOnce();
    expect(sendNow.mock.calls[0][0]).toBe('instead');
  });

  it('never starts an entry whose editor is open, and starts it once closed', () => {
    const { result, set, sendNow } = setup();
    set({ streaming: true });
    act(() => void result.current.submit({ text: 'draft' }));
    act(() => result.current.beginEdit(result.current.entries[0].id));
    set({ streaming: false, messages: [user('first'), reply()] });
    expect(sendNow).not.toHaveBeenCalled();
    act(() => result.current.edit(result.current.entries[0].id, 'draft, better'));
    act(() => result.current.endEdit());
    expect(sendNow).toHaveBeenCalledOnce();
    expect(sendNow.mock.calls[0][0]).toBe('draft, better');
  });

  it('starts nothing while a card waits for the person', () => {
    const { result, set, sendNow } = setup();
    set({ streaming: true, waiting: true });
    let answer = '';
    act(() => {
      answer = result.current.submit({ text: 'queued behind the card' });
    });
    expect(answer).toBe('queued');
    set({});
    expect(sendNow).not.toHaveBeenCalled();
  });

  it('queues a handoff while busy and sends one when idle', () => {
    const { result, set, sendNow } = setup();
    act(
      () =>
        void result.current.submit({
          text: 'Ask to revise · A',
          prompt: 'REVISE A',
          handoff: true,
        }),
    );
    expect(sendNow).toHaveBeenCalledWith('Ask to revise · A', 'REVISE A');
    set({ streaming: true });
    act(
      () =>
        void result.current.submit({
          text: 'Ask to revise · B',
          prompt: 'REVISE B',
          handoff: true,
        }),
    );
    expect(sendNow).toHaveBeenCalledOnce();
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]).toMatchObject({
      text: 'Ask to revise · B',
      prompt: 'REVISE B',
    });
    // A handoff is never read as a skill.
    expect(resolve).not.toHaveBeenCalled();
    set({ streaming: false, messages: [user('x'), reply()] });
    expect(sendNow).toHaveBeenLastCalledWith(
      'Ask to revise · B',
      'REVISE B',
      {},
      expect.anything(),
    );
  });

  it('refuses a handoff Up next cannot hold, with one toast', () => {
    const { result, set } = setup();
    set({ streaming: true });
    for (let i = 0; i < 10; i += 1) act(() => void result.current.submit({ text: `m${i}` }));
    expect(result.current.full).toBe(true);
    let answer = '';
    act(() => {
      answer = result.current.submit({ text: 'Ask · C', prompt: 'C', handoff: true });
    });
    expect(answer).toBe('full');
    expect(useUiStore.getState().toasts).toHaveLength(1);
    expect(JSON.stringify(useUiStore.getState().toasts)).toContain(HANDOFF_FULL);
    // Typed text that does not fit keeps its draft instead: no toast.
    act(() => void result.current.submit({ text: 'typed' }));
    expect(useUiStore.getState().toasts).toHaveLength(1);
    expect(queue()?.entries).toHaveLength(10);
  });

  it('sends a skill entry’s expansion, read when it was queued', async () => {
    const { result, set, sendNow } = setup();
    set({ streaming: true });
    act(() => void result.current.submit({ text: '/weekly go' }));
    expect(expandSkill).toHaveBeenCalledOnce();
    set({ streaming: false, messages: [user('x'), reply()] });
    const [text, message, tools] = sendNow.mock.calls[0];
    expect(text).toBe('/weekly go');
    expect(tools).toEqual({ allowedTools: ['get_note'] });
    await expect((message as () => Promise<string>)()).resolves.toBe('EXPANDED BODY');
    expect(expandSkill).toHaveBeenCalledOnce();
  });

  it('holds a thread’s Up next when the panel leaves it mid-turn', () => {
    const chat = fakeChat();
    const sendNow = vi.fn();
    let conversationId = 'c-1';
    const { result, rerender } = renderHook(() =>
      useUpNext({
        chat: chat.view(),
        conversationId,
        vault: '/vault',
        getTurn: () => turnOf('ctx'),
        resolve,
        sendNow,
      }),
    );
    act(() => {
      chat.state.streaming = true;
      rerender();
    });
    act(() => void result.current.submit({ text: 'for c-1' }));
    act(() => {
      conversationId = 'c-2';
      chat.state.streaming = false;
      rerender();
    });
    expect(useUpNextStore.getState().queues['c-1']?.held).toBe(true);
    expect(sendNow).not.toHaveBeenCalled();
  });
});

describe('useUpNext with review notes (M58.5)', () => {
  beforeEach(() => {
    useUpNextStore.setState({ queues: {} });
    useUiStore.setState({ toasts: [] });
    useReviewNotesStore.setState({ notes: [] });
    resolve.mockClear();
  });

  const PROMPT =
    'I reviewed your changes and left a note on `a.md`, line 1 after your change:\n\nFix.';

  /** One queued note, and the input that sends it. */
  function aNote() {
    const note = useReviewNotesStore.getState().add({
      vault: '/vault',
      conversationId: 'c-1',
      runId: 'run-1',
      commit: 'c'.repeat(40),
      path: 'a.md',
      side: 'new',
      start: 1,
      end: 1,
      excerpt: '',
      text: 'Fix.',
    });
    if (note === null) throw new Error('the note was refused');
    return { id: note.id, input: { text: PROMPT, notes: { ids: [note.id] } } };
  }
  const status = (id: string) => {
    const note = useReviewNotesStore.getState().notes.find((n) => n.id === id);
    if (note === undefined) throw new Error('no note');
    return statusOf(note);
  };

  it('sends at once when idle, as written, and stamps the notes sent', () => {
    const { result, sendNow } = setup();
    const { id, input } = aNote();
    let answer = '';
    act(() => {
      answer = result.current.submit(input);
    });
    expect(answer).toBe('sent');
    expect(sendNow).toHaveBeenCalledWith(PROMPT);
    expect(resolve).not.toHaveBeenCalled();
    expect(status(id)).toBe('sent');
  });

  it('queues while busy, holding the notes until the entry is dispatched', () => {
    const { result, set, sendNow } = setup();
    const { id, input } = aNote();
    set({ streaming: true });
    let answer = '';
    act(() => {
      answer = result.current.submit(input);
    });
    expect(answer).toBe('queued');
    expect(result.current.entries[0].notes?.ids).toEqual([id]);
    expect(status(id)).toBe('waiting');
    expect(useReviewNotesStore.getState().notes[0].sentAt).toBeUndefined();
    set({ streaming: false, messages: [user('x'), reply()] });
    expect(sendNow).toHaveBeenCalledOnce();
    expect(sendNow.mock.calls[0][0]).toBe(PROMPT);
    expect(status(id)).toBe('sent');
  });

  it('stamps them sent at Steer’s dispatch, not when Steer is pressed', () => {
    const { result, set, sendNow } = setup();
    set({ streaming: true });
    act(() => void result.current.submit({ text: 'one' }));
    const { id, input } = aNote();
    act(() => void result.current.submit(input));
    act(() => result.current.steer(result.current.entries[1].id));
    expect(status(id)).toBe('waiting');
    set({
      streaming: false,
      messages: [user('first'), reply({ cancelled: true, interrupted: true })],
    });
    expect(sendNow.mock.calls[0][0]).toBe(PROMPT);
    expect(status(id)).toBe('sent');
  });

  it('returns the notes to queued when their entry is removed', () => {
    const { result, set, sendNow } = setup();
    const { id, input } = aNote();
    set({ streaming: true });
    act(() => void result.current.submit(input));
    act(() => result.current.remove(result.current.entries[0].id));
    expect(status(id)).toBe('queued');
    set({ streaming: false, messages: [user('x'), reply()] });
    expect(sendNow).not.toHaveBeenCalled();
  });

  it('holds nothing when Up next is full', () => {
    const { result, set } = setup();
    set({ streaming: true });
    for (let i = 0; i < 10; i += 1) act(() => void result.current.submit({ text: `m${i}` }));
    const { id, input } = aNote();
    let answer = '';
    act(() => {
      answer = result.current.submit(input);
    });
    expect(answer).toBe('full');
    expect(useReviewNotesStore.getState().notes[0].heldBy).toBeUndefined();
    expect(status(id)).toBe('queued');
  });
});
