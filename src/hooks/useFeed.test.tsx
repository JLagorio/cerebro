import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useFeed } from './useFeed';
it('reports unavailable and recovers only when the version changes', async () => {
  const read = vi.fn().mockRejectedValueOnce(Error('disk')).mockResolvedValue(['row']);
  const { result, rerender } = renderHook(({ version }) => useFeed('/vault', read, version), {
    initialProps: { version: 0 },
  });
  await waitFor(() => expect(result.current.kind).toBe('unavailable'));
  rerender({ version: 1 });
  await waitFor(() => expect(result.current).toEqual({ kind: 'ready', data: ['row'] }));
  expect(read).toHaveBeenCalledTimes(2);
});
it('ignores a response after leaving its vault', async () => {
  let finish!: (rows: string[]) => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(['new']);
  const { result, rerender } = renderHook(({ vault }) => useFeed(vault, read), {
    initialProps: { vault: '/old' },
  });
  rerender({ vault: '/new' });
  await waitFor(() => expect(result.current).toEqual({ kind: 'ready', data: ['new'] }));
  await act(async () => finish(['old']));
  expect(result.current).toEqual({ kind: 'ready', data: ['new'] });
});
it('has no vault to read when none is open', async () => {
  const read = vi.fn();
  const { result } = renderHook(() => useFeed(null, read));
  await waitFor(() => expect(result.current.kind).toBe('unavailable'));
  expect(read).not.toHaveBeenCalled();
});
it('does not paint a previous vault answer before the new effect runs', async () => {
  const seen: { vault: string; kind: string }[] = [];
  const read = vi
    .fn()
    .mockResolvedValueOnce(['old'])
    .mockImplementation(() => new Promise(() => {}));
  const { result, rerender } = renderHook(
    ({ vault }) => {
      const feed = useFeed(vault, read);
      seen.push({ vault, kind: feed.kind });
      return feed;
    },
    { initialProps: { vault: '/old' } },
  );
  await waitFor(() => expect(result.current.kind).toBe('ready'));
  rerender({ vault: '/new' });
  expect(seen.filter((row) => row.vault === '/new').every((row) => row.kind === 'loading')).toBe(
    true,
  );
});
