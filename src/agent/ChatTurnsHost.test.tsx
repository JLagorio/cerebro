import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

/** What each run's journal holds, and which runs it no longer knows. */
const journals = new Map<
  number,
  { events: Array<Record<string, unknown>>; first: number; done: boolean }
>();
const unknownRuns = new Set<number>();
const listeners: Array<(event: Record<string, unknown>) => void> = [];

vi.mock('./agentIpc', () => ({
  // The real adapter's order: subscribe, answer, then the journal.
  attachRun: vi.fn(
    async (
      handle: { run: number },
      after: number,
      deliver: (event: unknown) => void,
      onState?: (state: string, done: boolean) => void,
    ) => {
      if (unknownRuns.has(handle.run)) {
        onState?.('unknown', false);
        return { state: 'unknown' };
      }
      let cursor = after;
      const take = (event: Record<string, unknown>) => {
        if (typeof event.seq === 'number') {
          if (event.seq <= cursor) return;
          cursor = event.seq;
        }
        deliver(event);
      };
      const scoped = (event: Record<string, unknown>) => {
        if (event.run === handle.run) take(event);
      };
      listeners.push(scoped);
      const journal = journals.get(handle.run);
      const state = journal !== undefined && after + 1 < journal.first ? 'gap' : 'held';
      onState?.(state, journal?.done ?? false);
      for (const event of journal?.events ?? []) take(event);
      return {
        state,
        done: journal?.done ?? false,
        detach: () => {
          const at = listeners.indexOf(scoped);
          if (at >= 0) listeners.splice(at, 1);
        },
      };
    },
  ),
}));

// M58.3: the host commits nothing; Rust commits each run's writes before its
// Done. Any commit from here would be a bug, so the adapter is watched.
const { gitCommit } = vi.hoisted(() => ({ gitCommit: vi.fn(async () => null) }));
vi.mock('@/lib/gitIpc', () => ({ gitCommit }));

import { ChatTurnsHost } from './ChatTurnsHost';
import type { RunRecord } from './runs';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The one settle (M57.6): a chat turn's end touches the vault here, once,
 * whether or not its panel is open.
 */

const storeRescan = useVaultStore.getState().rescan;
const rescan = vi.fn(async () => undefined);

const chat = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: 'r-1',
  owner: 'chat',
  label: 'tidy the inbox',
  place: null,
  path: null,
  conversationId: 'c-1',
  run: 8,
  attach: 'run-0008',
  startedAt: 0,
  ...over,
});

/** Number and hold one event of `run`, then hand it to whoever listens. */
function emit(run: number, event: Record<string, unknown>) {
  const journal = journals.get(run) ?? { events: [], first: 1, done: false };
  journals.set(run, journal);
  const tagged = { ...event, run, seq: journal.first + journal.events.length };
  journal.events.push(tagged);
  if (event.kind === 'Done') journal.done = true;
  act(() => [...listeners].forEach((l) => l(tagged)));
}

const write = (run: number, tool = 'mcp__cerebro__append_to_note') =>
  emit(run, { kind: 'ToolStart', tool_name: tool, tool_id: `t-${run}`, input: '{}' });

beforeEach(() => {
  journals.clear();
  unknownRuns.clear();
  listeners.length = 0;
  gitCommit.mockClear();
  rescan.mockClear();
  useVaultStore.setState({ vaultPath: '/vault', rescan });
  useUiStore.setState({ runs: [] });
});

afterEach(() => {
  cleanup();
  useVaultStore.setState({ rescan: storeRescan });
});

describe('ChatTurnsHost', () => {
  it('ends a chat run’s record at its Done, once', async () => {
    render(<ChatTurnsHost />);
    act(() => useUiStore.setState({ runs: [chat()] }));
    await vi.waitFor(() => expect(listeners).toHaveLength(1));
    emit(8, { kind: 'TextDelta', text: 'hi' });
    emit(8, { kind: 'Done' });
    expect(useUiStore.getState().runs).toEqual([]);
    expect(listeners).toHaveLength(0);
    expect(rescan).not.toHaveBeenCalled();
    expect(gitCommit).not.toHaveBeenCalled();
  });

  it('rescans a run that wrote, once, and never commits it', async () => {
    render(<ChatTurnsHost />);
    act(() => useUiStore.setState({ runs: [chat()] }));
    await vi.waitFor(() => expect(listeners).toHaveLength(1));
    write(8);
    write(8, 'MultiEdit');
    emit(8, { kind: 'Done' });
    emit(8, { kind: 'Done' });
    expect(rescan).toHaveBeenCalledOnce();
    expect(gitCommit).not.toHaveBeenCalled();
  });

  it('leaves a run that only read alone', async () => {
    render(<ChatTurnsHost />);
    act(() => useUiStore.setState({ runs: [chat()] }));
    await vi.waitFor(() => expect(listeners).toHaveLength(1));
    write(8, 'mcp__cerebro__get_note');
    emit(8, { kind: 'Done' });
    expect(rescan).not.toHaveBeenCalled();
    expect(gitCommit).not.toHaveBeenCalled();
  });

  it('counts a gap as written', async () => {
    journals.set(8, {
      events: [{ run: 8, seq: 7, kind: 'Done' }],
      first: 7,
      done: true,
    });
    useUiStore.setState({ runs: [chat()] });
    render(<ChatTurnsHost />);
    await vi.waitFor(() => expect(useUiStore.getState().runs).toEqual([]));
    expect(rescan).toHaveBeenCalledOnce();
    expect(gitCommit).not.toHaveBeenCalled();
  });

  it('settles a run the journal no longer knows as one that may have written', async () => {
    unknownRuns.add(8);
    useUiStore.setState({ runs: [chat()] });
    render(<ChatTurnsHost />);
    await vi.waitFor(() => expect(useUiStore.getState().runs).toEqual([]));
    expect(gitCommit).not.toHaveBeenCalled();
  });

  it('leaves a job run alone', async () => {
    const job = chat({ id: 'job-1', owner: 'job', path: 'notes/a.md', conversationId: null });
    useUiStore.setState({ runs: [job] });
    render(<ChatTurnsHost />);
    await act(async () => await Promise.resolve());
    expect(listeners).toHaveLength(0);
    expect(useUiStore.getState().runs).toEqual([job]);
  });

  it('settles a run that was done before the host attached, from the journal', async () => {
    write(8);
    emit(8, { kind: 'Done' });
    useUiStore.setState({ runs: [chat()] });
    render(<ChatTurnsHost />);
    await vi.waitFor(() => expect(useUiStore.getState().runs).toEqual([]));
    expect(rescan).toHaveBeenCalledOnce();
    expect(gitCommit).not.toHaveBeenCalled();
  });

  it('rescans a run that wrote in a vault with no history', async () => {
    render(<ChatTurnsHost />);
    act(() => useUiStore.setState({ runs: [chat()] }));
    await vi.waitFor(() => expect(listeners).toHaveLength(1));
    write(8);
    emit(8, { kind: 'Done' });
    expect(rescan).toHaveBeenCalledOnce();
    expect(gitCommit).not.toHaveBeenCalled();
  });

  it('a deferred Done does no end-of-turn work, and the resume’s Done settles once', async () => {
    render(<ChatTurnsHost />);
    act(() => useUiStore.setState({ runs: [chat()] }));
    await vi.waitFor(() => expect(listeners).toHaveLength(1));
    write(8);
    emit(8, { kind: 'Interaction', interaction: { id: 'x' } });
    emit(8, { kind: 'ToolDeferred', tool_id: 't-8', tool_name: 'mcp__cerebro__append_to_note' });
    emit(8, { kind: 'Done' });
    // The run's record ends, and nothing else happens yet.
    expect(useUiStore.getState().runs).toEqual([]);
    expect(rescan).not.toHaveBeenCalled();
    expect(gitCommit).not.toHaveBeenCalled();
    // The card's answer resumes the turn in a new run of the same thread.
    act(() => useUiStore.setState({ runs: [chat({ id: 'r-2', run: 9, attach: 'run-0009' })] }));
    await vi.waitFor(() => expect(listeners).toHaveLength(1));
    emit(9, { kind: 'TextDelta', text: 'Done.' });
    emit(9, { kind: 'Done' });
    expect(rescan).toHaveBeenCalledOnce();
    expect(gitCommit).not.toHaveBeenCalled();
  });

  it('lets go of a run whose record vanished', async () => {
    render(<ChatTurnsHost />);
    act(() => useUiStore.setState({ runs: [chat()] }));
    await vi.waitFor(() => expect(listeners).toHaveLength(1));
    act(() => useUiStore.setState({ runs: [] }));
    expect(listeners).toHaveLength(0);
  });
});
