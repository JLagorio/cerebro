import { describe, expect, it, vi } from 'vitest';
import { retryableOnce } from './retryableOnce';

describe('retryableOnce (M93.12)', () => {
  it('shares one start among callers in flight, and keeps a good engine', async () => {
    const start = vi.fn(async () => 'engine');
    const get = retryableOnce(start);
    const [a, b] = await Promise.all([get(), get()]);
    expect([a, b, await get()]).toEqual(['engine', 'engine', 'engine']);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('starts afresh after a failed start, instead of refusing until relaunch', async () => {
    const start = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('worker would not start'))
      .mockResolvedValueOnce('engine');
    const get = retryableOnce(start);
    await expect(get()).rejects.toThrow('worker would not start');
    await expect(get()).resolves.toBe('engine');
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('starts afresh once a started engine expires, and only for that engine', async () => {
    const expiries: (() => void)[] = [];
    let built = 0;
    const get = retryableOnce(async (expire) => {
      expiries.push(expire);
      return ++built;
    });
    expect(await get()).toBe(1);
    expiries[0]();
    expect(await get()).toBe(2);
    expiries[0]();
    expect(await get()).toBe(2);
  });
});
