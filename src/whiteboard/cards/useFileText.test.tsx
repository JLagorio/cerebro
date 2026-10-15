import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';
import { resetFileTextCache, useFileText } from './useFileText';
beforeEach(() => {
  resetFileTextCache();
  useVaultStore.setState({ vaultPath: '/vault' });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('two callers share a read and a new hash reads again', async () => {
  const read = vi
    .spyOn(ipc, 'readCanvasFile')
    .mockResolvedValue({ ok: true, content: '{}', hash: 'one' });
  const a = renderHook(({ hash }) => useFileText('a.canvas', hash), {
    initialProps: { hash: 'one' },
  });
  const b = renderHook(() => useFileText('a.canvas', 'one'));
  await waitFor(() => expect(a.result.current).toEqual({ state: 'ready', text: '{}' }));
  await waitFor(() => expect(b.result.current.state).toBe('ready'));
  expect(read).toHaveBeenCalledTimes(1);
  a.rerender({ hash: 'two' });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
});
it('missing and failure differ; a failed read is retried on remount', async () => {
  const read = vi
    .spyOn(ipc, 'readCanvasFile')
    .mockResolvedValueOnce({ ok: false, refusal: { code: 'missing', message: 'Missing' } })
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ ok: true, content: '{}', hash: 'one' });
  const first = renderHook(() => useFileText('a.canvas', 'one'));
  await waitFor(() => expect(first.result.current.state).toBe('missing'));
  first.unmount();
  const second = renderHook(() => useFileText('a.canvas', 'one'));
  await waitFor(() => expect(second.result.current.state).toBe('unavailable'));
  second.unmount();
  const third = renderHook(() => useFileText('a.canvas', 'one'));
  await waitFor(() => expect(third.result.current.state).toBe('ready'));
  expect(read).toHaveBeenCalledTimes(3);
});
it('diagram bytes stay raw and a late old-vault read cannot paint the new vault', async () => {
  let release!: (value: string) => void;
  vi.spyOn(ipc, 'readNote')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue('%% raw\nflowchart LR\nB');
  const { result } = renderHook(() => useFileText('a.mmd', 'same'));
  act(() => useVaultStore.setState({ vaultPath: '/other' }));
  await waitFor(() =>
    expect(result.current).toEqual({ state: 'ready', text: '%% raw\nflowchart LR\nB' }),
  );
  await act(async () => release('Old'));
  expect(result.current).toEqual({ state: 'ready', text: '%% raw\nflowchart LR\nB' });
});
