import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetOpenPages,
  announceExternalWrites,
  flushOpenPages,
  hasOpenPages,
  onExternalWrite,
  registerFlush,
  holdEditor,
  editorHoldersOf,
  subscribeEditorHolders,
} from './openPages';
import { coalescedRefresh } from '@/lib/trailingRefresh';

afterEach(() => {
  __resetOpenPages();
  vi.useRealTimers();
});

/** A promise and the function that resolves it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Whether `promise` has settled, after letting pending reactions run. */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise((r) => setTimeout(r, 0));
  return settled;
}

/**
 * A turn lands every open page's pending save before its child starts
 * (M53.6), so the agent reads what is on screen. The flush is bounded: a hung
 * save must not hold the turn forever.
 */
describe('flushOpenPages', () => {
  it('waits for every registered flush', async () => {
    const a = deferred();
    const b = deferred();
    registerFlush(() => a.promise);
    registerFlush(() => b.promise);
    const flushed = flushOpenPages();
    a.resolve();
    expect(await hasSettled(flushed)).toBe(false);
    b.resolve();
    expect(await hasSettled(flushed)).toBe(true);
  });

  it('is not held up by a flush that rejects or throws', async () => {
    registerFlush(() => Promise.reject(new Error('disk full')));
    registerFlush(() => {
      throw new Error('gone');
    });
    await expect(flushOpenPages()).resolves.toBeUndefined();
  });

  it('gives up on a hung flush once its budget is spent', async () => {
    vi.useFakeTimers();
    registerFlush(() => new Promise<void>(() => undefined));
    let done = false;
    void flushOpenPages(5_000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    // Its timer is cleared, not left to fire into nothing.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('makes no timer when no page is open', async () => {
    vi.useFakeTimers();
    await flushOpenPages();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops flushing a page that unregistered', async () => {
    const flush = vi.fn(async () => undefined);
    const unregister = registerFlush(flush);
    unregister();
    await flushOpenPages();
    expect(flush).not.toHaveBeenCalled();
  });
});

/**
 * The agent's writes reach the open page by path (M53.6). The watcher drops
 * the echo of every write the app makes, so the announcement is the only
 * signal — and a per-path one, because a stamp to the second cannot tell a
 * page about a second write within one.
 */
describe('announceExternalWrites', () => {
  it('tells the page pending at once, and settled after the catch-up', async () => {
    const calls: string[] = [];
    onExternalWrite('notes/a.md', {
      pending: () => calls.push('pending'),
      settled: () => calls.push('settled'),
    });
    const caughtUp = deferred();
    const announced = announceExternalWrites(['notes/a.md'], () => {
      calls.push('catch-up');
      return caughtUp.promise;
    });
    // Synchronously: a save in the same tick already knows to hold.
    expect(calls).toEqual(['pending', 'catch-up']);
    expect(await hasSettled(announced)).toBe(false);
    caughtUp.resolve();
    await announced;
    expect(calls).toEqual(['pending', 'catch-up', 'settled']);
  });

  it('settles the page even when the catch-up fails, and never rejects', async () => {
    const settled = vi.fn();
    onExternalWrite('notes/a.md', { pending: () => undefined, settled });
    await expect(
      announceExternalWrites(['notes/a.md'], () => Promise.reject(new Error('scan failed'))),
    ).resolves.toBeUndefined();
    expect(settled).toHaveBeenCalledOnce();
  });

  it('leaves every other page alone', async () => {
    const other = { pending: vi.fn(), settled: vi.fn() };
    onExternalWrite('notes/b.md', other);
    await announceExternalWrites(['notes/a.md'], async () => undefined);
    // No paths is "somewhere": it catches up, and tells no page by path.
    const catchUp = vi.fn(async () => undefined);
    await announceExternalWrites([], catchUp);
    expect(catchUp).toHaveBeenCalledOnce();
    expect(other.pending).not.toHaveBeenCalled();
    expect(other.settled).not.toHaveBeenCalled();
  });

  it('stops telling a page that stopped listening', async () => {
    const page = { pending: vi.fn(), settled: vi.fn() };
    const stop = onExternalWrite('notes/a.md', page);
    stop();
    await announceExternalWrites(['notes/a.md'], async () => undefined);
    expect(page.pending).not.toHaveBeenCalled();
  });

  it('a burst of announcements catches up in one pass and one trailing pass', async () => {
    const passes: ReturnType<typeof deferred>[] = [];
    // The store's rescan, as both callers pass it: it coalesces itself.
    const catchUp = coalescedRefresh(
      async () => {
        const pass = deferred();
        passes.push(pass);
        await pass.promise;
        return 'done';
      },
      () => undefined,
    );
    const first = announceExternalWrites(['notes/a.md'], catchUp);
    await vi.waitFor(() => expect(passes).toHaveLength(1));
    // Two more writes while the first pass runs: the trailing pass covers
    // both, since it starts after either landed.
    const second = announceExternalWrites(['notes/a.md'], catchUp);
    const third = announceExternalWrites(['notes/b.md'], catchUp);
    passes[0].resolve();
    await vi.waitFor(() => expect(passes).toHaveLength(2));
    expect(await hasSettled(second)).toBe(false);
    passes[1].resolve();
    await Promise.all([first, second, third]);
    expect(passes).toHaveLength(2);
  });

  it('each announcement calls catchUp itself, synchronously', () => {
    const catchUp = vi.fn(() => new Promise<void>(() => undefined));
    void announceExternalWrites(['notes/a.md'], catchUp);
    void announceExternalWrites(['notes/b.md'], catchUp);
    void announceExternalWrites([], catchUp);
    expect(catchUp).toHaveBeenCalledTimes(3);
  });
});

it('hasOpenPages follows registration and disposal', () => {
  expect(hasOpenPages()).toBe(false);
  const dispose = registerFlush(async () => {});
  expect(hasOpenPages()).toBe(true);
  dispose();
  expect(hasOpenPages()).toBe(false);
});

it('editor owners are counted, reference-stable, and released independently of pending saves', () => {
  const hear = vi.fn();
  const stop = subscribeEditorHolders(hear);
  const release = holdEditor('a.md', 'p1');
  const first = editorHoldersOf('a.md');
  expect(first).toEqual(['p1']);
  const second = holdEditor('a.md', 'p1');
  expect(editorHoldersOf('a.md')).toBe(first);
  release();
  release();
  expect(editorHoldersOf('a.md')).toBe(first);
  expect(hear).toHaveBeenCalledTimes(1);
  const peek = holdEditor('b.md', 'peek');
  expect(editorHoldersOf('b.md')).toEqual(['peek']);
  second();
  expect(editorHoldersOf('a.md')).toEqual([]);
  peek();
  stop();
  expect(hear).toHaveBeenCalledTimes(4);
});
