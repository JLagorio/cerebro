import { describe, expect, it, vi } from 'vitest';
import { makeThumbQueue } from './thumbQueue';
import type { Thumbnail } from '@/engine/thumbs';
const none: Thumbnail = { state: 'none', reason: 'unsupported' };
describe('thumbnail queue', () => {
  it('runs four at once in FIFO order and shares only identical in-flight keys', async () => {
    const release: ((value: Thumbnail) => void)[] = [];
    const read = vi.fn(() => new Promise<Thumbnail>((done) => release.push(done)));
    const request = makeThumbQueue(read);
    const jobs = Array.from({ length: 6 }, (_, i) => request('0', `${i}.png`, 200, 'visit'));
    expect(request('0', '0.png', 256, 'visit')).toBe(jobs[0]);
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(4);
    expect(read.mock.calls.map((args: unknown[]) => args[1])).toEqual([
      '0.png',
      '1.png',
      '2.png',
      '3.png',
    ]);
    release[0](none);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(5));
    expect(read).toHaveBeenLastCalledWith('0', '4.png', 256);
    release[1](none);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(6));
    release.slice(2).forEach((done) => done(none));
    await Promise.all(jobs);
    const again = request('0', '0.png', 256, 'visit');
    expect(again).not.toBe(jobs[0]);
    await Promise.resolve();
    release[6](none);
    await again;
  });
  it('does not issue a queued root-zero read after its visit ends', async () => {
    let release!: (value: Thumbnail) => void;
    const read = vi.fn(
      () =>
        new Promise<Thumbnail>((done) => {
          release = done;
        }),
    );
    const request = makeThumbQueue(read, 1);
    const first = request('0', 'a.png', 128, 'first');
    let live = true;
    const second = request('0', 'b.png', 128, 'first', () => live);
    await Promise.resolve();
    live = false;
    release(none);
    await first;
    expect(await second).toEqual({ state: 'none', reason: 'notFound' });
    expect(read).toHaveBeenCalledOnce();
  });
  it('a failed request releases its slot and does not become a cached rejection', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(none);
    const request = makeThumbQueue(read, 1);
    await expect(request('0', 'a.png', 128, 'one')).rejects.toThrow('offline');
    expect(await request('0', 'b.png', 128, 'one')).toEqual(none);
    expect(await request('0', 'a.png', 128, 'two')).toEqual(none);
  });
  it('keeps a shared queued request when its first reader unmounts', async () => {
    let release!: (value: Thumbnail) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Thumbnail>((done) => {
            release = done;
          }),
      )
      .mockResolvedValue(none);
    const request = makeThumbQueue(read, 1);
    const first = request('0', 'busy.png', 128, 'one');
    let mounted = true;
    const queued = request('0', 'shared.png', 128, 'one', () => mounted);
    expect(request('0', 'shared.png', 128, 'one', () => true)).toBe(queued);
    await Promise.resolve();
    mounted = false;
    release(none);
    await first;
    expect(await queued).toEqual(none);
    expect(read).toHaveBeenLastCalledWith('0', 'shared.png', 128);
  });
});
