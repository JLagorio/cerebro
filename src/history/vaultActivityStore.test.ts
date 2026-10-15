// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryActivity } from '@/lib/ipc';

vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return { ...actual, vaultActivity: vi.fn() };
});

import { vaultActivity } from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import { REREAD_MS, resetVaultActivity, useVaultActivity } from './vaultActivityStore';

const EMPTY: HistoryActivity = {
  writes: { state: 'read', rows: [], more: false },
  runs: { state: 'read', rows: [], more: false },
  app_sessions: { state: 'read', rows: [], more: false },
  recording_since: { state: 'read', at: null },
};

function Two() {
  useVaultActivity();
  useVaultActivity();
  return null;
}

beforeEach(() => {
  vi.mocked(vaultActivity).mockReset();
  vi.mocked(vaultActivity).mockResolvedValue(EMPTY);
  resetVaultActivity();
  useVaultStore.setState({ vaultPath: '/demo-vault', entries: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useVaultActivity', () => {
  it('reads once per vault and window, however many sections share it', async () => {
    const { rerender } = render(createElement(Two));
    rerender(createElement(Two));
    await act(async () => {});
    expect(vaultActivity).toHaveBeenCalledTimes(1);
    const [vault, since, until] = vi.mocked(vaultActivity).mock.calls[0];
    expect(vault).toBe('/demo-vault');
    expect(Date.parse(until) - Date.parse(since)).toBeGreaterThan(370 * 86_400_000);
  });

  it('is ready with the read and the day it was read for', async () => {
    const { result } = renderHook(() => useVaultActivity());
    expect(result.current.read.kind).toBe('loading');
    await act(async () => {});
    expect(result.current.read).toMatchObject({ kind: 'ready', data: EMPTY });
  });

  it('reads again a second after the entries settle', async () => {
    vi.useFakeTimers();
    render(createElement(Two));
    await act(async () => {});
    expect(vaultActivity).toHaveBeenCalledTimes(1);
    act(() => useVaultStore.setState({ entries: [makeEntry({ path: 'a.md' })] }));
    act(() => vi.advanceTimersByTime(REREAD_MS / 2));
    act(() => useVaultStore.setState({ entries: [makeEntry({ path: 'b.md' })] }));
    act(() => vi.advanceTimersByTime(REREAD_MS - 1));
    expect(vaultActivity).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(1));
    expect(vaultActivity).toHaveBeenCalledTimes(2);
  });

  it('reloads on Retry', async () => {
    const { result } = renderHook(() => useVaultActivity());
    await act(async () => {});
    await act(async () => result.current.reload());
    expect(vaultActivity).toHaveBeenCalledTimes(2);
  });

  it('reads a rejected read as unavailable, with its reason', async () => {
    vi.mocked(vaultActivity).mockRejectedValueOnce(new Error('History could not be read: gone'));
    const { result } = renderHook(() => useVaultActivity());
    await act(async () => {});
    expect(result.current.read).toEqual({
      kind: 'unavailable',
      reason: 'History could not be read: gone',
    });
  });

  it('reads afresh when History opens again', async () => {
    const first = render(createElement(Two));
    await act(async () => {});
    first.unmount();
    render(createElement(Two));
    await act(async () => {});
    expect(vaultActivity).toHaveBeenCalledTimes(2);
  });
});
