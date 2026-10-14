import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coalescedRefresh, writeFence, type PassOutcome } from './trailingRefresh';

afterEach(() => {
  vi.useRealTimers();
});

/** A promise and the function that settles it. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let every pending reaction run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A pass whose runs park until released, one deferred per run. */
function parkedPasses(): {
  pass: () => Promise<PassOutcome>;
  runs: Array<ReturnType<typeof deferred<PassOutcome>>>;
  active: () => number;
  maxActive: () => number;
} {
  const runs: Array<ReturnType<typeof deferred<PassOutcome>>> = [];
  let active = 0;
  let maxActive = 0;
  return {
    runs,
    active: () => active,
    maxActive: () => maxActive,
    pass: async () => {
      const run = deferred<PassOutcome>();
      runs.push(run);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        return await run.promise;
      } finally {
        active -= 1;
      }
    },
  };
}

describe('coalescedRefresh (M58.2)', () => {
  it('five calls while a pass runs give two passes and one shared promise', async () => {
    const p = parkedPasses();
    const refresh = coalescedRefresh(p.pass, () => undefined);
    const first = refresh();
    await vi.waitFor(() => expect(p.runs).toHaveLength(1));
    const later = [refresh(), refresh(), refresh(), refresh(), refresh()];
    for (const call of later) expect(call).toBe(first);
    p.runs[0].resolve('done');
    await vi.waitFor(() => expect(p.runs).toHaveLength(2));
    // Not before the trailing pass, which started after those calls.
    let settled = false;
    void first.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    p.runs[1].resolve('done');
    await Promise.all([first, ...later]);
    expect(p.runs).toHaveLength(2);
    expect(p.maxActive()).toBe(1);
  });

  it('calls in the same tick share the first pass; a call after a cycle ends starts a new one', async () => {
    const pass = vi.fn(async (): Promise<PassOutcome> => 'done');
    const refresh = coalescedRefresh(pass, () => undefined);
    const a = refresh();
    const b = refresh();
    expect(b).toBe(a);
    await a;
    expect(pass).toHaveBeenCalledTimes(1);
    const c = refresh();
    expect(c).not.toBe(a);
    await c;
    expect(pass).toHaveBeenCalledTimes(2);
  });

  it("'again' runs one more pass in the same cycle", async () => {
    const outcomes: PassOutcome[] = ['again', 'done'];
    const pass = vi.fn(async () => outcomes.shift() ?? 'done');
    const refresh = coalescedRefresh(pass, () => undefined);
    await refresh();
    expect(pass).toHaveBeenCalledTimes(2);
  });

  it('a pass that calls the refresh while it runs gets a trailing pass, never a parallel one', async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    let inner: Promise<void> | null = null;
    const refresh: () => Promise<void> = coalescedRefresh(
      async () => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (calls === 1) inner = refresh();
        await flush();
        active -= 1;
        return 'done';
      },
      () => undefined,
    );
    const outer = refresh();
    await outer;
    expect(inner).toBe(outer);
    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
  });

  it('a throwing pass never rejects; onFailed fires once when the last pass failed', async () => {
    const onFailed = vi.fn();
    const p = parkedPasses();
    const refresh = coalescedRefresh(async () => {
      await p.pass();
      throw new Error('scan failed');
    }, onFailed);
    const first = refresh();
    await vi.waitFor(() => expect(p.runs).toHaveLength(1));
    const second = refresh();
    p.runs[0].resolve('done');
    await vi.waitFor(() => expect(p.runs).toHaveLength(2));
    p.runs[1].resolve('done');
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    // Fail, fail: one cycle, one hook call.
    expect(onFailed).toHaveBeenCalledOnce();
  });

  it('a failed pass followed by a good trailing pass calls onFailed not at all', async () => {
    const onFailed = vi.fn();
    const p = parkedPasses();
    const refresh = coalescedRefresh(p.pass, onFailed);
    const first = refresh();
    await vi.waitFor(() => expect(p.runs).toHaveLength(1));
    void refresh();
    p.runs[0].resolve('failed');
    await vi.waitFor(() => expect(p.runs).toHaveLength(2));
    p.runs[1].resolve('done');
    await first;
    expect(onFailed).not.toHaveBeenCalled();
  });
});

describe('writeFence (M58.2)', () => {
  it('begin and end each move the generation, and a second end is a no-op', () => {
    const fence = writeFence(() => undefined);
    const idle = fence.mark();
    expect(idle.pending).toBe(0);
    const end = fence.begin();
    const during = fence.mark();
    expect(fence.moved(idle)).toBe(true);
    expect(during.pending).toBe(1);
    end();
    expect(fence.moved(during)).toBe(true);
    const after = fence.mark();
    expect(after.pending).toBe(0);
    end();
    expect(fence.moved(after)).toBe(false);
    expect(fence.mark().pending).toBe(0);
  });

  it('settled resolves at once when idle, with no timer', async () => {
    vi.useFakeTimers();
    const fence = writeFence(() => undefined);
    await fence.settled(5_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settled resolves on the last end, and clears its timer', async () => {
    vi.useFakeTimers();
    const fence = writeFence(() => undefined);
    const endA = fence.begin();
    const endB = fence.begin();
    let done = false;
    void fence.settled(5_000).then(() => (done = true));
    endA();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    endB();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settled resolves after the budget at the latest', async () => {
    vi.useFakeTimers();
    const fence = writeFence(() => undefined);
    fence.begin();
    let done = false;
    void fence.settled(5_000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it('owe, then the last end, calls onOwed once', () => {
    const onOwed = vi.fn();
    const fence = writeFence(onOwed);
    const endA = fence.begin();
    const endB = fence.begin();
    fence.owe();
    endA();
    expect(onOwed).not.toHaveBeenCalled();
    endB();
    expect(onOwed).toHaveBeenCalledOnce();
    // Paid: a later write that settles owes nothing.
    fence.begin()();
    expect(onOwed).toHaveBeenCalledOnce();
  });
});

/**
 * Never gated on visibility (M58.2): triggers ride on rescans, so a refresh
 * path that skipped a hidden window would stop its automations too.
 */
describe('refresh path tripwire', () => {
  it.each(['src/lib/trailingRefresh.ts', 'src/stores/vaultStore.ts', 'src/editor/openPages.ts'])(
    '%s reads no visibility or focus',
    (file) => {
      const source = readFileSync(join(__dirname, '../..', file), 'utf8');
      expect(source).not.toMatch(/document\.(visibilityState|hidden)|hasFocus\(/);
    },
  );
});
