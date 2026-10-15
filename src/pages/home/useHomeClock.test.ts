import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useHomeClock } from './useHomeClock';
afterEach(() => vi.useRealTimers());
it('ticks only when a new minute arrives and clears its interval on unmount', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-28T12:00:10Z'));
  const { result, unmount } = renderHook(useHomeClock);
  expect(result.current.toISOString()).toBe('2026-07-28T12:00:00.000Z');
  act(() => vi.advanceTimersByTime(30_000));
  expect(result.current.toISOString()).toBe('2026-07-28T12:00:00.000Z');
  act(() => vi.advanceTimersByTime(30_000));
  expect(result.current.toISOString()).toBe('2026-07-28T12:01:00.000Z');
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
