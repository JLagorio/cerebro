// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEntry } from '@/test/factories';
import { useVaultStore } from './vaultStore';
import {
  OPEN_LOG_KEY,
  pruneOpenLogToSnapshot,
  recordPersonOpen,
  useOpenLogStore,
  useRecency,
} from './openLogStore';

const NOW = Date.UTC(2026, 9, 14, 12);

const stored = () => JSON.parse(window.localStorage.getItem(OPEN_LOG_KEY) ?? 'null') as unknown;
const paths = (vault: string) => (useOpenLogStore.getState().logs[vault] ?? []).map((r) => r.path);

beforeEach(() => {
  window.localStorage.removeItem(OPEN_LOG_KEY);
  useOpenLogStore.setState({ logs: {}, saved: true });
  useVaultStore.setState({ vaultPath: '/v', entriesVault: '/v', status: 'ready', entries: [] });
});

afterEach(() => vi.restoreAllMocks());

describe('openLogStore', () => {
  it('keeps each vault its own log under cerebro.openLog', () => {
    const { record } = useOpenLogStore.getState();
    record('/v', 'a.md', NOW);
    record('/w', 'b.md', NOW);
    expect(stored()).toEqual({
      '/v': [{ path: 'a.md', opens: [NOW], count: 1 }],
      '/w': [{ path: 'b.md', opens: [NOW], count: 1 }],
    });
  });

  it('keeps the session log and says it is unsaved when the write throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    useOpenLogStore.getState().record('/v', 'a.md', NOW);
    expect(paths('/v')).toEqual(['a.md']);
    expect(useOpenLogStore.getState().saved).toBe(false);
  });

  it('records, remaps, prunes, forgets and clears', () => {
    const s = useOpenLogStore.getState();
    s.record('/v', 'docs/old/a.md', NOW - 2);
    s.record('/v', 'b.md', NOW - 1);
    s.record('/v', 'gone.md', NOW);
    expect(paths('/v')).toEqual(['gone.md', 'b.md', 'docs/old/a.md']);
    s.remap('/v', 'docs/old', 'docs/new');
    expect(paths('/v')).toEqual(['gone.md', 'b.md', 'docs/new/a.md']);
    s.prune('/v', new Set(['b.md', 'docs/new/a.md']));
    expect(paths('/v')).toEqual(['b.md', 'docs/new/a.md']);
    s.forget('/v', 'b.md');
    expect(paths('/v')).toEqual(['docs/new/a.md']);
    s.clear('/v');
    expect(paths('/v')).toEqual([]);
    expect(stored()).toEqual({});
  });

  it('records a person open in the open vault, and nothing with no vault', () => {
    recordPersonOpen('a.md');
    expect(paths('/v')).toEqual(['a.md']);
    useVaultStore.setState({ vaultPath: null });
    recordPersonOpen('b.md');
    expect(useOpenLogStore.getState().logs).toEqual({ '/v': expect.any(Array) });
    expect(paths('/v')).toEqual(['a.md']);
  });

  it('prunes to the snapshot only when it is a ready snapshot of this vault', () => {
    useOpenLogStore.getState().record('/v', 'gone.md', NOW);
    useVaultStore.setState({ entries: [makeEntry({ path: 'kept.md' })], status: 'scanning' });
    pruneOpenLogToSnapshot();
    expect(paths('/v')).toEqual(['gone.md']);
    useVaultStore.setState({ status: 'ready', entriesVault: '/w' });
    pruneOpenLogToSnapshot();
    expect(paths('/v')).toEqual(['gone.md']);
    useVaultStore.setState({ entriesVault: '/v' });
    pruneOpenLogToSnapshot();
    expect(paths('/v')).toEqual([]);
  });

  it('useRecency reads only the current vault', () => {
    const s = useOpenLogStore.getState();
    s.record('/v', 'mine.md', NOW);
    s.record('/w', 'theirs.md', NOW);
    const { result } = renderHook(() => useRecency(NOW));
    expect(result.current.order('mine.md')).toBe(0);
    expect(result.current.weight('mine.md')).toBe(1);
    expect(result.current.order('theirs.md')).toBe(Infinity);
    act(() => useVaultStore.setState({ vaultPath: '/w' }));
    expect(result.current.order('theirs.md')).toBe(0);
    expect(result.current.weight('mine.md')).toBe(0);
  });
});
