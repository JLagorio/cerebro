// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChangesHeal } from './useChangesHeal';
import type { ConversationChangesets, RunChangeset } from '@/engine/changeset';
import * as gitIpc from '@/lib/gitIpc';
import { failNext, resetFaults } from '@/lib/mockFaults';
import { resetMockFs } from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';

/**
 * The Changes card's heal (M92.12): `conversation_changes`, asked only while
 * the rail can be seen, as it shows, when the session changes and when a
 * turn ends; never while it is folded away or hidden, and never polled. A
 * read that failed is unavailable, never no runs (CV-05).
 */

const VAULT = '/demo-vault';
const SESSION = '00000000-0000-4000-8000-000000000092';
const NEXT = '00000000-0000-4000-8000-000000000093';

const run = (runId: string): RunChangeset => ({
  kept_out_of_git: null,
  state: 'not_recorded',
  run_id: runId,
  reason: 'no commit was recorded for this run',
  files: [],
});
const read = (...runIds: string[]): ConversationChangesets => ({
  changesets: runIds.map(run),
  truncated: false,
});

interface Props {
  sessionId: string | null;
  visible: boolean;
  streaming: boolean;
}

function heal(initialProps: Props, wrapper?: typeof StrictMode) {
  return renderHook(
    ({ sessionId, visible, streaming }: Props) =>
      useChangesHeal(VAULT, sessionId, { visible, streaming }),
    { initialProps, wrapper },
  );
}

beforeEach(() => {
  resetMockFs();
  useUiStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  resetFaults();
  vi.restoreAllMocks();
});

describe('useChangesHeal (M92.12)', () => {
  it('asks nothing while the rail is hidden or folded, or with no session', () => {
    const ask = vi.spyOn(gitIpc, 'conversationChanges');
    const hidden = heal({ sessionId: SESSION, visible: false, streaming: false });
    expect(hidden.result.current).toBeNull();
    const unsaved = heal({ sessionId: null, visible: true, streaming: false });
    expect(unsaved.result.current).toBeNull();
    const vaultless = renderHook(() =>
      useChangesHeal(null, SESSION, { visible: true, streaming: false }),
    );
    expect(vaultless.result.current).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });

  it('reads as the rail shows, and its answer is the heal', async () => {
    const ask = vi.spyOn(gitIpc, 'conversationChanges').mockResolvedValue({
      ...read('run-a', 'run-b'),
      truncated: true,
    });
    const { result } = heal({ sessionId: SESSION, visible: true, streaming: false });
    expect(result.current).toBeNull();
    await waitFor(() =>
      expect(result.current).toEqual({
        state: 'read',
        changesets: [run('run-a'), run('run-b')],
        truncated: true,
      }),
    );
    expect(ask).toHaveBeenCalledWith(VAULT, SESSION);
  });

  it('asks once on mount under StrictMode', async () => {
    const ask = vi.spyOn(gitIpc, 'conversationChanges').mockResolvedValue(read('run-a'));
    const { result } = heal({ sessionId: SESSION, visible: true, streaming: false }, StrictMode);
    await waitFor(() => expect(result.current?.state).toBe('read'));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('reads again when a turn ends and when the rail shows again, and never in between', async () => {
    const ask = vi.spyOn(gitIpc, 'conversationChanges').mockResolvedValue(read('run-a'));
    const { result, rerender } = heal({ sessionId: SESSION, visible: true, streaming: false });
    await waitFor(() => expect(result.current?.state).toBe('read'));
    expect(ask).toHaveBeenCalledTimes(1);
    // A turn runs: what it changes lands as it ends, so nothing is asked.
    rerender({ sessionId: SESSION, visible: true, streaming: true });
    rerender({ sessionId: SESSION, visible: true, streaming: true });
    expect(ask).toHaveBeenCalledTimes(1);
    ask.mockResolvedValue(read('run-a', 'run-b'));
    rerender({ sessionId: SESSION, visible: true, streaming: false });
    await waitFor(() => expect(result.current).toMatchObject({ changesets: [{}, {}] }));
    expect(ask).toHaveBeenCalledTimes(2);
    // Folded away, a turn that runs and ends asks nothing; the last answer
    // stays.
    rerender({ sessionId: SESSION, visible: false, streaming: false });
    rerender({ sessionId: SESSION, visible: false, streaming: true });
    rerender({ sessionId: SESSION, visible: false, streaming: false });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({ changesets: [{}, {}] });
    // Shown again, it reads once.
    rerender({ sessionId: SESSION, visible: true, streaming: false });
    rerender({ sessionId: SESSION, visible: true, streaming: false });
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(3));
  });

  it('holds nothing for another session until its own answer lands, and a late one for the old never lands', async () => {
    let release!: (answer: ConversationChangesets) => void;
    const ask = vi
      .spyOn(gitIpc, 'conversationChanges')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(read('run-next'));
    const { result, rerender } = heal({ sessionId: SESSION, visible: true, streaming: false });
    rerender({ sessionId: NEXT, visible: true, streaming: false });
    expect(result.current).toBeNull();
    await waitFor(() =>
      expect(result.current).toMatchObject({ changesets: [{ run_id: 'run-next' }] }),
    );
    release(read('run-old'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current).toMatchObject({ changesets: [{ run_id: 'run-next' }] });
    expect(ask).toHaveBeenNthCalledWith(2, VAULT, NEXT);
  });

  it('reads unavailable when the read fails, never no runs, and toasts nothing', async () => {
    failNext('conversation_changes');
    const { result } = heal({ sessionId: SESSION, visible: true, streaming: false });
    await waitFor(() => expect(result.current).toEqual({ state: 'unavailable' }));
    expect(useUiStore.getState().toasts).toEqual([]);
  });
});
