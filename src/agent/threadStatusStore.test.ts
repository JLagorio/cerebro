import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentStreamEvent, Conversation, PendingInteraction } from './types';
import type { RunState } from '@/engine/ai/threadStatus';

/** The adapter's two listeners, held so a test can speak for Rust. */
const wire = vi.hoisted(() => ({
  events: new Set<(event: AgentEvent) => void>(),
  starts: new Set<(turn: { run: number; attach: string }) => void>(),
}));

vi.mock('./agentIpc', () => ({
  onAgentEvent: vi.fn((listener: (event: AgentEvent) => void) => {
    wire.events.add(listener);
    return () => wire.events.delete(listener);
  }),
  onRunStarted: vi.fn((listener: (turn: { run: number; attach: string }) => void) => {
    wire.starts.add(listener);
    return () => wire.starts.delete(listener);
  }),
  runState: vi.fn(async (): Promise<RunState> => 'running'),
  listInteractions: vi.fn(async (): Promise<PendingInteraction[]> => []),
}));

import * as agentIpc from './agentIpc';
import {
  THREAD_STATUS_HELD,
  resetThreadStatus,
  useThreadStatusStore,
  useThreadStatuses,
  type ThreadStatuses,
  type TurnFlags,
} from './threadStatusStore';

/**
 * The conversation list's status book (M92.7): what Rust's book says waits
 * on the person, and what its journal says of each run a thread left going,
 * learned from a run's start, its Interaction and its Done, never a token.
 * Nothing survives a restart, so nothing infers Working after one.
 */

const VAULT = '/vault';
const runState = vi.mocked(agentIpc.runState);
const listInteractions = vi.mocked(agentIpc.listInteractions);
const store = () => useThreadStatusStore.getState();

let seq = 0;
/** Rust's channel: one event of run `run`. */
function emit(run: number, event: AgentStreamEvent) {
  seq += 1;
  act(() => {
    for (const listener of [...wire.events]) listener({ ...event, run, seq } as AgentEvent);
  });
}
/** A run this window started, as its handle comes back. */
function start(run: number, attach: string) {
  act(() => {
    for (const listener of [...wire.starts]) listener({ run, attach });
  });
}

function card(id: string, session: string): PendingInteraction {
  return {
    id,
    kind: 'permission',
    tool_name: 'mcp__cerebro__append_to_note',
    tool_id: `toolu_${id}`,
    session_id: session,
    summary: 'append to note · notes/inbox.md',
    input: '{}',
    asked_at: '2026-10-23T09:00:00Z',
  };
}

/** A promise a test settles by hand. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  resetThreadStatus();
  runState.mockReset();
  runState.mockResolvedValue('running');
  listInteractions.mockReset();
  listInteractions.mockResolvedValue([]);
});

afterEach(() => {
  // Unmounted first: a reset under a mounted list renders it outside act.
  cleanup();
  resetThreadStatus();
});

describe('the book', () => {
  it('starts unread, and reads the vault it watches', async () => {
    expect(store().book).toEqual({ state: 'unread' });
    listInteractions.mockResolvedValue([card('c1', 's1')]);
    store().watch(VAULT);
    store().readCards();
    await waitFor(() =>
      expect(store().book).toEqual({ state: 'read', cards: [{ sessionId: 's1' }] }),
    );
    expect(listInteractions).toHaveBeenCalledWith(VAULT);
  });

  it('reads nothing before a list watches a vault', () => {
    store().readCards();
    expect(listInteractions).not.toHaveBeenCalled();
    expect(store().book).toEqual({ state: 'unread' });
  });

  it('reads a book it cannot read as unavailable, never as empty, until a read lands', async () => {
    store().watch(VAULT);
    listInteractions.mockRejectedValueOnce(new Error('the book is locked'));
    store().readCards();
    await waitFor(() => expect(store().book).toEqual({ state: 'unavailable' }));
    store().readCards();
    await waitFor(() => expect(store().book).toEqual({ state: 'read', cards: [] }));
  });

  it('lands only the latest read', async () => {
    store().watch(VAULT);
    const slow = deferred<PendingInteraction[]>();
    listInteractions.mockReturnValueOnce(slow.promise);
    listInteractions.mockResolvedValueOnce([card('c2', 's2')]);
    store().readCards();
    store().readCards();
    await waitFor(() =>
      expect(store().book).toEqual({ state: 'read', cards: [{ sessionId: 's2' }] }),
    );
    await act(async () => slow.resolve([card('c1', 's1')]));
    expect(store().book).toEqual({ state: 'read', cards: [{ sessionId: 's2' }] });
  });

  it('starts another vault’s book unread', async () => {
    listInteractions.mockResolvedValue([card('c1', 's1')]);
    store().watch(VAULT);
    store().readCards();
    await waitFor(() => expect(store().book.state).toBe('read'));
    store().watch('/elsewhere');
    expect(store().book).toEqual({ state: 'unread' });
  });
});

describe('the listener', () => {
  it('binds once for the app’s life, however many lists watch', () => {
    store().watch(VAULT);
    store().watch(VAULT);
    store().watch('/elsewhere');
    resetThreadStatus();
    store().watch(VAULT);
    expect(vi.mocked(agentIpc.onAgentEvent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(agentIpc.onRunStarted)).toHaveBeenCalledTimes(1);
  });

  it('reads the book again at an Interaction, its card filed under the run that asked', async () => {
    store().watch(VAULT);
    start(4, 'durable-4');
    expect(store().runs).toEqual({ 'durable-4': 'running' });
    await waitFor(() => expect(listInteractions).toHaveBeenCalledTimes(1));
    listInteractions.mockResolvedValue([card('c1', 's9')]);
    emit(4, { kind: 'Interaction', interaction: card('c1', 's9') });
    expect(listInteractions).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(store().book).toEqual({
        state: 'read',
        cards: [{ sessionId: 's9', run: 'durable-4' }],
      }),
    );
  });

  it('files a card by its session alone when the asking run’s start was never heard', async () => {
    store().watch(VAULT);
    listInteractions.mockResolvedValue([card('c1', 's9')]);
    emit(7, { kind: 'Interaction', interaction: card('c1', 's9') });
    await waitFor(() =>
      expect(store().book).toEqual({ state: 'read', cards: [{ sessionId: 's9' }] }),
    );
  });

  it('files a card under its run once a journal read vouches for the pair', async () => {
    // A reload forgot the start: the card comes first, then the list reads
    // the run its thread left going.
    store().watch(VAULT);
    listInteractions.mockResolvedValue([card('c1', 's9')]);
    emit(7, { kind: 'Interaction', interaction: card('c1', 's9') });
    await waitFor(() =>
      expect(store().book).toEqual({ state: 'read', cards: [{ sessionId: 's9' }] }),
    );
    runState.mockResolvedValueOnce('done');
    store().readRuns([{ run: 7, attach: 'durable-7' }]);
    await waitFor(() =>
      expect(store().book).toEqual({
        state: 'read',
        cards: [{ sessionId: 's9', run: 'durable-7' }],
      }),
    );
  });

  it('reads the book again at a start: a resume takes its card off', async () => {
    store().watch(VAULT);
    listInteractions.mockResolvedValue([card('c1', 's9')]);
    store().readCards();
    await waitFor(() => expect(store().book).toMatchObject({ cards: [{ sessionId: 's9' }] }));
    listInteractions.mockResolvedValue([]);
    start(5, 'durable-5');
    await waitFor(() => expect(store().book).toEqual({ state: 'read', cards: [] }));
  });

  it('ends at its Done a run whose start it heard: a detached run stops working', () => {
    start(4, 'durable-4');
    emit(4, { kind: 'Done' });
    expect(store().runs).toEqual({ 'durable-4': 'done' });
  });

  it('names nothing with a tag whose start it never heard: the next launch numbers runs again', () => {
    // A thread saved before a restart left run 3 going under its old key; this
    // launch's own run 3 ends.
    emit(3, { kind: 'Done' });
    expect(store().runs).toEqual({});
  });

  it('files a run done when its Done came before its start', () => {
    emit(6, { kind: 'Done' });
    start(6, 'durable-6');
    expect(store().runs).toEqual({ 'durable-6': 'done' });
  });

  it('keeps a run done: a run never starts again', () => {
    start(8, 'durable-8');
    emit(8, { kind: 'Done' });
    start(8, 'durable-8');
    expect(store().runs).toEqual({ 'durable-8': 'done' });
  });

  it('learns from a start, an Interaction and a Done, never from a token', () => {
    store().watch(VAULT);
    start(4, 'durable-4');
    const changes = vi.fn();
    const off = useThreadStatusStore.subscribe(changes);
    listInteractions.mockClear();
    for (let i = 0; i < 50; i += 1) emit(4, { kind: 'TextDelta', text: `token ${i}` });
    emit(4, { kind: 'ThinkingDelta', text: 'thinking' });
    emit(4, { kind: 'ToolStart', tool_name: 'Read', tool_id: 'toolu_r', input: '{}' });
    emit(4, { kind: 'ToolDone', tool_id: 'toolu_r', output: 'ok' });
    emit(4, { kind: 'Init', session_id: 's4' });
    emit(4, { kind: 'Result', text: 'done', duration_ms: 1_200 });
    off();
    expect(changes).not.toHaveBeenCalled();
    expect(listInteractions).not.toHaveBeenCalled();
  });
});

describe('the journal’s answers', () => {
  it('asks once per run, and again only for one whose read failed', async () => {
    runState.mockResolvedValueOnce('running').mockResolvedValueOnce('unavailable');
    const turns = [
      { run: 1, attach: 'durable-1' },
      { run: 2, attach: 'durable-2' },
    ];
    store().readRuns(turns);
    store().readRuns(turns);
    expect(runState).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(store().runs).toEqual({ 'durable-1': 'running', 'durable-2': 'unavailable' }),
    );
    runState.mockResolvedValueOnce('done');
    store().readRuns(turns);
    expect(runState).toHaveBeenCalledTimes(3);
    expect(runState).toHaveBeenLastCalledWith({ run: 2, attach: 'durable-2' });
    await waitFor(() => expect(store().runs['durable-2']).toBe('done'));
  });

  it('reads a read that rejects as unavailable, never unknown', async () => {
    runState.mockRejectedValueOnce(new Error('the journal is locked'));
    store().readRuns([{ run: 1, attach: 'durable-1' }]);
    await waitFor(() => expect(store().runs).toEqual({ 'durable-1': 'unavailable' }));
  });

  it('takes a journal’s answer as the pair: that run’s Done ends it', async () => {
    store().readRuns([{ run: 5, attach: 'durable-5' }]);
    await waitFor(() => expect(store().runs).toEqual({ 'durable-5': 'running' }));
    emit(5, { kind: 'Done' });
    expect(store().runs).toEqual({ 'durable-5': 'done' });
  });

  it('files done when the run’s Done came while its read was out', async () => {
    const late = deferred<RunState>();
    runState.mockReturnValueOnce(late.promise);
    store().readRuns([{ run: 5, attach: 'durable-5' }]);
    emit(5, { kind: 'Done' });
    await act(async () => late.resolve('running'));
    expect(store().runs).toEqual({ 'durable-5': 'done' });
  });

  it('keeps a run done whatever a read sent before its Done answers after it', async () => {
    runState.mockResolvedValueOnce('unavailable');
    store().readRuns([{ run: 9, attach: 'durable-9' }]);
    await waitFor(() => expect(store().runs['durable-9']).toBe('unavailable'));
    const late = deferred<RunState>();
    runState.mockReturnValueOnce(late.promise);
    store().readRuns([{ run: 9, attach: 'durable-9' }]);
    start(9, 'durable-9');
    emit(9, { kind: 'Done' });
    await act(async () => late.resolve('running'));
    expect(store().runs['durable-9']).toBe('done');
  });

  it('holds at most its cap of runs, the oldest dropped first', () => {
    for (let run = 1; run <= THREAD_STATUS_HELD + 2; run += 1) start(run, `durable-${run}`);
    const kept = Object.keys(store().runs);
    expect(kept).toHaveLength(THREAD_STATUS_HELD);
    expect(kept[0]).toBe('durable-3');
  });

  it('forgets everything at a reset, as a restart does: no read sent before it lands', async () => {
    const late = deferred<RunState>();
    runState.mockReturnValueOnce(late.promise);
    store().readRuns([{ run: 1, attach: 'durable-1' }]);
    start(2, 'durable-2');
    resetThreadStatus();
    await act(async () => late.resolve('running'));
    expect(store().runs).toEqual({});
    emit(2, { kind: 'Done' });
    expect(store().runs).toEqual({});
  });
});

/** A thread in the list. */
function thread(id: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: id,
    usesDefaultTitle: false,
    sessionId: null,
    messages: [],
    createdAt: '2026-10-23T09:00:00Z',
    archived: false,
    ...over,
  };
}

const live = (run: number, attach: string) => ({ run, attach, assistantId: `${attach}-a` });

describe('useThreadStatuses', () => {
  /** What the list hands the hook. */
  interface Props {
    conversations: Conversation[];
    active: string;
    turn?: TurnFlags;
    shown: boolean;
  }

  /** Let every read the effects sent land, inside act. */
  const settled = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

  async function statusesOf(
    conversations: Conversation[],
    { active = 'open', turn, shown = true }: { active?: string; turn?: TurnFlags; shown?: boolean },
  ) {
    const hook = renderHook<ThreadStatuses, Props>(
      (props) =>
        useThreadStatuses(props.conversations, props.active, props.turn, VAULT, props.shown),
      { initialProps: { conversations, active, turn, shown } },
    );
    await settled();
    return hook;
  }

  it('reads each thread’s status, the open one’s from its own flags', async () => {
    listInteractions.mockResolvedValue([card('c1', 's-asked')]);
    runState.mockImplementation(async ({ attach }) =>
      attach === 'durable-1' ? 'running' : 'done',
    );
    const { result } = await statusesOf(
      [
        thread('open', { sessionId: 's-asked', live: live(3, 'durable-3') }),
        thread('working', { sessionId: 's1', live: live(1, 'durable-1') }),
        thread('asked', { sessionId: 's-asked' }),
        thread('ended', { sessionId: 's2', live: live(2, 'durable-2') }),
        thread('blank'),
      ],
      { turn: { streaming: false, waiting: false } },
    );
    expect(Object.fromEntries(result.current.statuses)).toEqual({
      open: 'idle',
      working: 'working',
      asked: 'needs_you',
      ended: 'idle',
      blank: 'idle',
    });
    expect(result.current.unavailable).toBe(false);
  });

  it('reads the open thread from the book and the journal when no flags are handed over', async () => {
    const { result } = await statusesOf(
      [thread('open', { sessionId: 's1', live: live(1, 'durable-1') })],
      { turn: undefined },
    );
    expect(result.current.statuses.get('open')).toBe('working');
  });

  it('reads nothing while the list is not shown, and reads as it opens', async () => {
    const conversations = [thread('a', { sessionId: 's1', live: live(1, 'durable-1') })];
    const { rerender, result } = await statusesOf(conversations, { shown: false });
    expect(listInteractions).not.toHaveBeenCalled();
    expect(runState).not.toHaveBeenCalled();
    expect(result.current.statuses.get('a')).toBe('unknown');
    rerender({ conversations, active: 'open', shown: true });
    await settled();
    expect(result.current.statuses.get('a')).toBe('working');
    expect(listInteractions).toHaveBeenCalledTimes(1);
    expect(runState).toHaveBeenCalledTimes(1);
  });

  it('reads the book again as a thread leaves the open slot', async () => {
    const conversations = [thread('a', { sessionId: 's1' }), thread('b', { sessionId: 's2' })];
    const { rerender } = await statusesOf(conversations, { active: 'a' });
    expect(listInteractions).toHaveBeenCalledTimes(1);
    rerender({ conversations, active: 'b', shown: true });
    await settled();
    expect(listInteractions).toHaveBeenCalledTimes(2);
  });

  it('reads nothing again for a list rebuilt with the same facts, and keeps its statuses', async () => {
    const make = () => [
      thread('a', { sessionId: 's1', live: live(1, 'durable-1') }),
      thread('b', { sessionId: 's2' }),
    ];
    const { rerender, result } = await statusesOf(make(), { active: 'b' });
    expect(result.current.statuses.get('a')).toBe('working');
    const before = result.current.statuses;
    // Every token of a streaming reply renders the list again, from a new array.
    for (let i = 0; i < 50; i += 1) rerender({ conversations: make(), active: 'b', shown: true });
    await settled();
    expect(result.current.statuses).toBe(before);
    expect(listInteractions).toHaveBeenCalledTimes(1);
    expect(runState).toHaveBeenCalledTimes(1);
  });

  it('says once that statuses are unavailable when a run’s read failed', async () => {
    runState.mockResolvedValue('unavailable');
    const { result } = await statusesOf(
      [thread('a', { sessionId: 's1', live: live(1, 'durable-1') })],
      {},
    );
    expect(result.current.unavailable).toBe(true);
    expect(result.current.statuses.get('a')).toBe('unavailable');
  });

  it('says so when the book could not be read, never a quiet list', async () => {
    listInteractions.mockRejectedValue(new Error('the book is locked'));
    const { result } = await statusesOf([thread('a', { sessionId: 's1' })], {});
    expect(result.current.unavailable).toBe(true);
    expect(result.current.statuses.get('a')).toBe('unavailable');
  });

  it('never infers Working after a restart: a run the journal no longer holds is unknown', async () => {
    runState.mockResolvedValue('unknown');
    const { result } = await statusesOf(
      [thread('left', { sessionId: 's1', live: live(3, 'durable-before-restart') })],
      {},
    );
    expect(runState).toHaveBeenCalledTimes(1);
    expect(store().runs['durable-before-restart']).toBe('unknown');
    expect(result.current.statuses.get('left')).toBe('unknown');
    expect(result.current.unavailable).toBe(false);
    // This launch's own run 3 starts and ends; the thread's old run is not it.
    start(3, 'durable-now');
    emit(3, { kind: 'Done' });
    await settled();
    expect(result.current.statuses.get('left')).toBe('unknown');
  });

  it('clears Working at a detached run’s Done', async () => {
    const { result } = await statusesOf(
      [thread('left', { sessionId: 's1', live: live(4, 'durable-4') }), thread('open')],
      {},
    );
    start(4, 'durable-4');
    await settled();
    expect(result.current.statuses.get('left')).toBe('working');
    emit(4, { kind: 'Done' });
    expect(result.current.statuses.get('left')).toBe('idle');
  });
});
