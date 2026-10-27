import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetOpenPages, flushOpenPages, unresolvedOpenPages } from '@/editor/openPages';
import { useVaultStore } from '@/stores/vaultStore';
import { readNote, saveNote } from '@/lib/ipc';
import { useDiagramFile } from './useDiagramFile';
vi.mock('@/lib/ipc', async (original) => ({
  ...(await original<typeof import('@/lib/ipc')>()),
  readNote: vi.fn(),
  saveNote: vi.fn(),
}));
beforeEach(() => {
  __resetOpenPages();
  useVaultStore.setState({ vaultPath: '/diagram-test' });
  vi.mocked(readNote).mockResolvedValue('graph TD\n  A[old]\n');
  vi.mocked(saveNote).mockReset().mockResolvedValue('written-hash');
});
afterEach(() => {
  cleanup();
  __resetOpenPages();
});

describe('diagram save participant', () => {
  it('saves the pending debounce before a dependent action while mounted', async () => {
    const { result } = renderHook(() => useDiagramFile('a.mmd'));
    await waitFor(() => expect(result.current.code).not.toBeNull());
    act(() => result.current.handleChange('graph TD\n  A[latest exact]\n'));
    let report!: Awaited<ReturnType<typeof flushOpenPages>>;
    await act(async () => {
      report = await flushOpenPages();
    });
    expect(saveNote).toHaveBeenCalledWith(
      '/diagram-test',
      'a.mmd',
      'graph TD\n  A[latest exact]\n',
    );
    expect(report.unresolvedOwnerIds).toEqual([]);
    expect(result.current.saveState).toBe('saved');
  });

  it('retains a prior failure and retries exact bytes without another edit', async () => {
    vi.mocked(saveNote).mockRejectedValue(new Error('disk full'));
    const { result } = renderHook(() => useDiagramFile('a.mmd'));
    await waitFor(() => expect(result.current.code).not.toBeNull());
    act(() => result.current.handleChange('graph TD\n  A[failed exact]\n'));
    await act(async () => {
      await flushOpenPages();
    });
    expect(result.current.saveState).toBe('failed');
    expect(
      unresolvedOpenPages().some((state) => state.latestDraft === 'graph TD\n  A[failed exact]\n'),
    ).toBe(true);
    vi.mocked(saveNote).mockResolvedValue('retry-confirmed');
    await act(async () => {
      await flushOpenPages();
    });
    expect(saveNote).toHaveBeenCalledTimes(2);
    expect(result.current.saveState).toBe('saved');
    expect(unresolvedOpenPages()).toEqual([]);
  });

  it('reopens failed text from the retained owner', async () => {
    vi.mocked(saveNote).mockRejectedValue(new Error('disk full'));
    const first = renderHook(() => useDiagramFile('a.mmd'));
    await waitFor(() => expect(first.result.current.code).not.toBeNull());
    act(() => first.result.current.handleChange('graph TD\n  A[retained]\n'));
    await act(async () => {
      await flushOpenPages();
    });
    first.unmount();
    const reopened = renderHook(() => useDiagramFile('a.mmd'));
    await waitFor(() => expect(reopened.result.current.code).toBe('graph TD\n  A[retained]\n'));
    expect(reopened.result.current.saveState).toBe('failed');
  });
});
