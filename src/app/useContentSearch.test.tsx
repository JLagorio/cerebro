import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  CONTENT_DEBOUNCE_MS,
  CONTENT_LIMIT,
  useContentSearch,
  type ContentSearch,
} from '@/app/useContentSearch';
import type { VaultSearch } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';

const searchVault = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc')>()),
  searchVault,
}));

/** An answer naming the query it answered, so a test can tell which landed. */
const answerFor = (query: string): VaultSearch => ({
  hits: [{ path: `${query}.md`, title: query, type: null, parts: [] }],
  total: 1,
  widened: false,
  capped: 0,
});

/** A call the test resolves or rejects by hand. */
function deferred() {
  let resolve: (value: VaultSearch) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<VaultSearch>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

interface Props {
  vault: string | null;
  query: string;
  enabled: boolean;
}

const mount = (props: Props) =>
  renderHook((p: Props) => useContentSearch(p.vault, p.query, p.enabled), {
    initialProps: props,
  });

const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

const pathsOf = (state: ContentSearch) =>
  state.status === 'ready' ? state.result.hits.map((h) => h.path) : state.status;

beforeEach(() => {
  vi.useFakeTimers();
  searchVault.mockReset();
  searchVault.mockImplementation(async (_vault: string, query: string) => answerFor(query));
  useUiStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useContentSearch', () => {
  it('makes no call under three characters', async () => {
    const { result } = mount({ vault: '/v', query: ' dr ', enabled: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(searchVault).not.toHaveBeenCalled();
    expect(result.current).toEqual({ status: 'idle' });
  });

  it('counts code points, so three emoji are a query', async () => {
    mount({ vault: '/v', query: '\u{1F680}\u{1F680}\u{1F680}', enabled: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS);
    });
    expect(searchVault).toHaveBeenCalledTimes(1);
  });

  it('calls once, 250 ms after the last keystroke', async () => {
    const { result, rerender } = mount({ vault: '/v', query: 'dra', enabled: true });
    expect(result.current).toEqual({ status: 'pending' });
    for (const query of ['drai', 'drain', 'draining']) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS - 10);
      });
      rerender({ vault: '/v', query, enabled: true });
    }
    expect(searchVault).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS - 1);
    });
    expect(searchVault).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(searchVault).toHaveBeenCalledTimes(1);
    expect(searchVault).toHaveBeenCalledWith('/v', 'draining', CONTENT_LIMIT);
    await settle();
    expect(pathsOf(result.current)).toEqual(['draining.md']);
  });

  it('drops an older answer that resolves last', async () => {
    const older = deferred();
    const newer = deferred();
    searchVault.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const { result, rerender } = mount({ vault: '/v', query: 'draining', enabled: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS);
    });
    rerender({ vault: '/v', query: 'drained', enabled: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS);
    });
    expect(searchVault).toHaveBeenCalledTimes(2);
    await act(async () => newer.resolve(answerFor('drained')));
    await act(async () => older.resolve(answerFor('draining')));
    expect(pathsOf(result.current)).toEqual(['drained.md']);
  });

  it('drops the answer in flight when the vault switches', async () => {
    const first = deferred();
    searchVault.mockReturnValueOnce(first.promise);
    const { result, rerender } = mount({ vault: '/v', query: 'draining', enabled: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS);
    });
    rerender({ vault: '/w', query: 'draining', enabled: true });
    await act(async () => first.resolve(answerFor('stale')));
    expect(result.current).toEqual({ status: 'pending' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS);
    });
    expect(searchVault).toHaveBeenLastCalledWith('/w', 'draining', CONTENT_LIMIT);
    expect(pathsOf(result.current)).toEqual(['draining.md']);
  });

  it('turns a rejection into unavailable, with no toast', async () => {
    searchVault.mockRejectedValue(new Error('disk gone'));
    const { result } = mount({ vault: '/v', query: 'draining', enabled: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS);
    });
    expect(result.current).toEqual({ status: 'unavailable' });
    expect(useUiStore.getState().toasts).toEqual([]);
  });

  it('drops the pending call when disabled', async () => {
    const { result, rerender } = mount({ vault: '/v', query: 'draining', enabled: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS - 50);
    });
    rerender({ vault: '/v', query: 'draining', enabled: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS * 4);
    });
    expect(searchVault).not.toHaveBeenCalled();
    expect(result.current).toEqual({ status: 'idle' });
  });

  it('makes no call without a vault', async () => {
    mount({ vault: null, query: 'draining', enabled: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS * 4);
    });
    expect(searchVault).not.toHaveBeenCalled();
  });
});
