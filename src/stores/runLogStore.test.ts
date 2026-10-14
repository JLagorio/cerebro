import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunLogEntry } from '@/engine/runLog';
import { useRunLogStore } from './runLogStore';

const KEY = 'cerebro.runLog';

const entry = (id: string, over: Partial<RunLogEntry> = {}): RunLogEntry => ({
  id,
  at: '2026-08-03T10:00:00Z',
  owner: 'job',
  label: 'Release scout',
  source: 'records/agents/scout.md',
  trigger: 'schedule',
  scope: null,
  files: [],
  status: 'ok',
  ...over,
});

const ids = (entries: readonly RunLogEntry[]) => entries.map((e) => e.id);

/** A store built from whatever storage holds now, as a launch builds it. */
async function relaunch() {
  vi.resetModules();
  return (await import('./runLogStore')).useRunLogStore;
}

beforeEach(() => {
  useRunLogStore.getState().clear();
});

describe('useRunLogStore (M53.20)', () => {
  it('loads the stored log, old rows included, and drops malformed rows', async () => {
    // A row written before durableId and dueAt existed still loads: the log
    // moved stores, not formats.
    window.localStorage.setItem(
      KEY,
      JSON.stringify([entry('new', { durableId: 'd-1' }), { id: 7 }, 'junk', entry('old')]),
    );
    expect(ids((await relaunch()).getState().entries)).toEqual(['new', 'old']);
  });

  it('loads an unparseable log as an empty one', async () => {
    window.localStorage.setItem(KEY, '{not json');
    expect((await relaunch()).getState().entries).toEqual([]);
  });

  it('starts empty when storage cannot be read', async () => {
    // On the instance, not Storage.prototype: the test setup's localStorage
    // is a plain object, not a Storage (uiStore.test.ts says why).
    const getItem = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      expect((await relaunch()).getState().entries).toEqual([]);
    } finally {
      getItem.mockRestore();
    }
  });

  it('records newest first and keeps the latest 200', () => {
    for (let i = 0; i < 205; i++) useRunLogStore.getState().append(entry(`r${i}`));
    const kept = ids(useRunLogStore.getState().entries);
    expect(kept).toHaveLength(200);
    expect(kept[0]).toBe('r204');
    expect(kept[199]).toBe('r5');
  });

  it('writes every append through to storage', async () => {
    useRunLogStore.getState().append(entry('a'));
    useRunLogStore.getState().append(entry('b'));
    expect(ids(JSON.parse(window.localStorage.getItem(KEY) ?? '[]'))).toEqual(['b', 'a']);
    expect(ids((await relaunch()).getState().entries)).toEqual(['b', 'a']);
  });

  it('keeps an entry for the session when storage refuses it, and throws nothing', () => {
    // Private mode: recording a run must never fail the run.
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(() => useRunLogStore.getState().append(entry('a'))).not.toThrow();
      expect(ids(useRunLogStore.getState().entries)).toEqual(['a']);
      expect(window.localStorage.getItem(KEY)).toBeNull();
    } finally {
      setItem.mockRestore();
    }
  });

  it('clear empties memory and storage', async () => {
    useRunLogStore.getState().append(entry('a'));
    useRunLogStore.getState().clear();
    expect(useRunLogStore.getState().entries).toEqual([]);
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect((await relaunch()).getState().entries).toEqual([]);
  });
});
