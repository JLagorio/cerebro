import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as agentIpc from './agentIpc';
import type { ContextUseAnswer, ContextUseRecorded } from './agentIpc';
import { useContextUse } from './useContextUse';
import { failNext, resetFaults } from '@/lib/mockFaults';
import * as mock from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';

/**
 * The context pull (M91.5): `agentContextUsage` answers from the book a
 * run's reader files (the mock's, in the browser), and `useContextUse`
 * pulls it when it mounts, when the session changes and when a turn ends,
 * never on a timer. Nothing seen is not recorded, and a read that failed is
 * unavailable: two different sentences (CV-05).
 */

const VAULT = '/demo-vault';
const FIRST = '2026-10-22T12:00:02.000Z';
const LATER = '2026-10-22T12:00:08.000Z';

let sessions = 0;

/** A session id no other case has filed anything under. */
function freshSession(): string {
  sessions += 1;
  return `00000000-0000-4000-8000-${String(900_000 + sessions).padStart(12, '0')}`;
}

function reading(used: number, at = FIRST): ContextUseRecorded {
  return { state: 'recorded', used, window: 200_000, model: 'claude-sonnet-5', at };
}

/** Run one mock turn of `sessionId` to its Done, and read the book as the
 * Done arrives: what a panel pulling at the turn's end would read. */
async function turnOf(sessionId: string, attended = true): Promise<ContextUseAnswer> {
  const start = await agentIpc.runAgent(VAULT, {
    message: 'hello',
    sessionId,
    shell: 'off',
    connectors: false,
    attended,
  });
  if (!('run' in start)) throw new Error('a run with no lane is never deferred or settled');
  return new Promise((resolve) => {
    const stop = agentIpc.onAgentEvent((event) => {
      if (event.kind !== 'Done') return;
      stop();
      resolve(agentIpc.mockContextBook.read(sessionId));
    }, start.run);
  });
}

beforeEach(() => {
  mock.resetMockFs();
  useUiStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  resetFaults();
  vi.restoreAllMocks();
});

describe('agentContextUsage (M91.5)', () => {
  it('answers not recorded for a session nothing was filed for, never 0', async () => {
    await expect(agentIpc.agentContextUsage(freshSession())).resolves.toEqual({
      state: 'not_recorded',
    });
  });

  it('answers a filed reading as Rust sends it, an unreported window and model left out', async () => {
    const session = freshSession();
    agentIpc.mockContextBook.record(session, reading(124_000, LATER));
    await expect(agentIpc.agentContextUsage(session)).resolves.toEqual({
      state: 'recorded',
      used: 124_000,
      window: 200_000,
      model: 'claude-sonnet-5',
      at: LATER,
    });
    agentIpc.mockContextBook.record(session, { state: 'recorded', used: 6_108, at: LATER });
    const answer = await agentIpc.agentContextUsage(session);
    expect(answer).toEqual({ state: 'recorded', used: 6_108, at: LATER });
    expect(Object.keys(answer)).toEqual(['state', 'used', 'at']);
  });

  it('rejects a read the lab told to fail: no answer, not a reading of none', async () => {
    const session = freshSession();
    agentIpc.mockContextBook.record(session, reading(124_000));
    failNext('agent_context_usage');
    await expect(agentIpc.agentContextUsage(session)).rejects.toThrow(
      'state lab: agent_context_usage was told to fail once',
    );
  });

  it('is filed by an attended mock turn before its Done, and grows with the next', async () => {
    const session = freshSession();
    const first = await turnOf(session);
    expect(first).toMatchObject({ state: 'recorded', window: 200_000, model: 'mock-default' });
    if (first.state !== 'recorded') throw new Error('the turn filed a reading');
    expect(first.used).toBeGreaterThan(14_000);
    expect(Number.isNaN(Date.parse(first.at))).toBe(false);
    const second = await turnOf(session);
    if (second.state !== 'recorded') throw new Error('the next turn filed one too');
    expect(second.used).toBeGreaterThan(first.used);
    await expect(agentIpc.agentContextUsage(session)).resolves.toEqual(second);
  });

  it('files nothing for a run nobody watches, as Rust files nothing', async () => {
    expect(await turnOf(freshSession(), false)).toEqual({ state: 'not_recorded' });
  });

  it('lets the session recorded longest ago go past its cap', () => {
    const book = agentIpc.mockContextBook;
    const kept = freshSession();
    const dropped = freshSession();
    book.record(kept, reading(1));
    book.record(dropped, reading(2));
    for (let n = 0; n < agentIpc.MOCK_CONTEXT_SESSIONS - 2; n += 1) {
      book.record(freshSession(), reading(n + 3));
    }
    // A session's next reading replaces its last and makes it the newest.
    book.record(kept, reading(9_412, LATER));
    book.record(freshSession(), reading(7));
    expect(book.read(dropped)).toEqual({ state: 'not_recorded' });
    expect(book.read(kept)).toEqual(reading(9_412, LATER));
  });
});

describe('useContextUse (M91.5)', () => {
  it('asks nothing for a conversation with no session, which has nothing recorded', () => {
    const pull = vi.spyOn(agentIpc, 'agentContextUsage');
    const { result } = renderHook(() => useContextUse(null, { streaming: false }));
    expect(result.current).toEqual({ state: 'not_recorded' });
    expect(pull).not.toHaveBeenCalled();
  });

  it('loads, then reads the session’s latest reading', async () => {
    const session = freshSession();
    agentIpc.mockContextBook.record(session, reading(124_000));
    const { result } = renderHook(() => useContextUse(session, { streaming: false }));
    expect(result.current).toEqual({ state: 'loading' });
    await waitFor(() => expect(result.current).toEqual(reading(124_000)));
  });

  it('asks once on mount under StrictMode, and that answer lands', async () => {
    const session = freshSession();
    agentIpc.mockContextBook.record(session, reading(124_000));
    const pull = vi.spyOn(agentIpc, 'agentContextUsage');
    const { result } = renderHook(() => useContextUse(session, { streaming: false }), {
      wrapper: StrictMode,
    });
    await waitFor(() => expect(result.current).toEqual(reading(124_000)));
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it('reads not recorded for a session nothing was filed for', async () => {
    const session = freshSession();
    const { result } = renderHook(() => useContextUse(session, { streaming: false }));
    await waitFor(() => expect(result.current).toEqual({ state: 'not_recorded' }));
  });

  it('reads unavailable when the read fails, never not recorded, and toasts nothing', async () => {
    const session = freshSession();
    agentIpc.mockContextBook.record(session, reading(124_000));
    failNext('agent_context_usage');
    const { result } = renderHook(() => useContextUse(session, { streaming: false }));
    await waitFor(() => expect(result.current).toEqual({ state: 'unavailable' }));
    expect(useUiStore.getState().toasts).toEqual([]);
  });

  it('reads an answer it cannot read as unavailable, never as a figure', async () => {
    vi.spyOn(agentIpc, 'agentContextUsage').mockResolvedValue({
      state: 'recorded',
      used: Number.NaN,
      at: FIRST,
    });
    const session = freshSession();
    const { result } = renderHook(() => useContextUse(session, { streaming: false }));
    await waitFor(() => expect(result.current).toEqual({ state: 'unavailable' }));
  });

  it('pulls again when a turn ends, and only then', async () => {
    const session = freshSession();
    agentIpc.mockContextBook.record(session, reading(6_108));
    const pull = vi.spyOn(agentIpc, 'agentContextUsage');
    const { result, rerender } = renderHook(
      ({ streaming }) => useContextUse(session, { streaming }),
      { initialProps: { streaming: false } },
    );
    await waitFor(() => expect(result.current).toEqual(reading(6_108)));
    expect(pull).toHaveBeenCalledTimes(1);
    // A turn starts and runs: its reading is filed only as it ends, so
    // nothing is asked meanwhile, and the last reading stays.
    rerender({ streaming: true });
    agentIpc.mockContextBook.record(session, reading(9_412, LATER));
    rerender({ streaming: true });
    expect(pull).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual(reading(6_108));
    // It ends: one pull, which the new reading answers.
    rerender({ streaming: false });
    await waitFor(() => expect(result.current).toEqual(reading(9_412, LATER)));
    expect(pull).toHaveBeenCalledTimes(2);
    rerender({ streaming: false });
    expect(pull).toHaveBeenCalledTimes(2);
  });

  it('reads a failed pull at a turn’s end as unavailable, and the next end reads again', async () => {
    const session = freshSession();
    agentIpc.mockContextBook.record(session, reading(6_108));
    const { result, rerender } = renderHook(
      ({ streaming }) => useContextUse(session, { streaming }),
      { initialProps: { streaming: false } },
    );
    await waitFor(() => expect(result.current).toEqual(reading(6_108)));
    rerender({ streaming: true });
    failNext('agent_context_usage');
    rerender({ streaming: false });
    await waitFor(() => expect(result.current).toEqual({ state: 'unavailable' }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    rerender({ streaming: true });
    rerender({ streaming: false });
    await waitFor(() => expect(result.current).toEqual(reading(6_108)));
  });

  it('loads afresh for another session, and a late answer for the old one never lands', async () => {
    const old = freshSession();
    const next = freshSession();
    agentIpc.mockContextBook.record(next, reading(41_200));
    let release!: (answer: ContextUseAnswer) => void;
    const pull = vi.spyOn(agentIpc, 'agentContextUsage').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { result, rerender } = renderHook(({ id }) => useContextUse(id, { streaming: false }), {
      initialProps: { id: old },
    });
    expect(result.current).toEqual({ state: 'loading' });
    rerender({ id: next });
    expect(result.current).toEqual({ state: 'loading' });
    await waitFor(() => expect(result.current).toEqual(reading(41_200)));
    await act(async () => release(reading(999_999)));
    expect(result.current).toEqual(reading(41_200));
    expect(pull.mock.calls).toEqual([[old], [next]]);
  });

  it('reads what a mock turn filed once its turn ends', async () => {
    const session = freshSession();
    const { result, rerender } = renderHook(
      ({ streaming }) => useContextUse(session, { streaming }),
      { initialProps: { streaming: true } },
    );
    await waitFor(() => expect(result.current).toEqual({ state: 'not_recorded' }));
    const filed = await turnOf(session);
    rerender({ streaming: false });
    await waitFor(() => expect(result.current).toEqual(filed));
  });
});
