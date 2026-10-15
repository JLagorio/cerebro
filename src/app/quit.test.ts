// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuitRequest } from '@/lib/ipc';
import {
  __resetQuit,
  beginLeaving,
  isQuitting,
  markLeft,
  prepareQuit,
  QUIT_ANYWAY_MS,
  STAYED_TOAST,
  useQuitHost,
  type QuitDeps,
} from './quit';

const REQUEST: QuitRequest = { deadlineMs: 5_000 };

/** Deps that log each step and its budget, each overridable. */
function harness(overrides: Partial<QuitDeps> = {}) {
  const steps: string[] = [];
  let failures = 0;
  let handler: ((request: QuitRequest) => void) | null = null;
  const unlisten = vi.fn(() => {
    handler = null;
  });
  const deps: QuitDeps = {
    blurFocused: () => steps.push('blur'),
    pageWriteFailures: () => failures,
    flushOpenPages: async (ms) => {
      steps.push(`flush ${ms}`);
    },
    settlePageWrites: async (ms) => {
      steps.push(`settle ${ms}`);
      return true;
    },
    beginLeaving: async (ms) => {
      steps.push(`leave ${ms}`);
    },
    endLeaving: () => steps.push('end leaving'),
    finishQuit: async () => {
      steps.push('finish');
    },
    cancelQuit: async () => {
      steps.push('cancel');
    },
    toast: (message) => steps.push(`toast ${message}`),
    listenQuitRequested: async (h) => {
      handler = h;
      return unlisten;
    },
    ...overrides,
  };
  return {
    deps,
    steps,
    unlisten,
    fail: () => {
      failures += 1;
    },
    ask: (request: QuitRequest = REQUEST) => handler?.(request),
    listening: () => handler !== null,
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => __resetQuit());
afterEach(() => {
  vi.useRealTimers();
  __resetQuit();
});

describe('prepareQuit', () => {
  it('blurs, flushes, settles, leaves, settles and finishes, on budgets from the deadline', async () => {
    const h = harness();
    expect(await prepareQuit(REQUEST, h.deps)).toBe('finished');
    expect(h.steps).toEqual([
      'blur',
      'flush 2500',
      'settle 750',
      'leave 750',
      'settle 750',
      'finish',
    ]);
  });

  it('cuts off a hung flush and a hung write, and still finishes before the deadline', async () => {
    vi.useFakeTimers();
    let finishedAt: number | null = null;
    const start = Date.now();
    const hang = () => new Promise<never>(() => undefined);
    const h = harness({
      flushOpenPages: hang,
      settlePageWrites: hang,
      beginLeaving: hang,
      finishQuit: async () => {
        finishedAt = Date.now() - start;
      },
    });
    const outcome = prepareQuit(REQUEST, h.deps);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await outcome).toBe('finished');
    expect(finishedAt).not.toBeNull();
    expect(finishedAt!).toBeLessThan(5_000);
  });

  it('stays open with a toast when a save fails, and neither leaves nor finishes', async () => {
    const h = harness();
    h.deps.settlePageWrites = async (ms) => {
      h.steps.push(`settle ${ms}`);
      h.fail();
      return true;
    };
    expect(await prepareQuit(REQUEST, h.deps)).toBe('stayed');
    expect(h.steps).toEqual([
      'blur',
      'flush 2500',
      'settle 750',
      'end leaving',
      'cancel',
      `toast ${STAYED_TOAST}`,
    ]);
  });

  it('stays open with a toast when a save made on leave fails', async () => {
    const h = harness();
    let settles = 0;
    h.deps.settlePageWrites = async (ms) => {
      h.steps.push(`settle ${ms}`);
      settles += 1;
      if (settles === 2) h.fail();
      return true;
    };
    expect(await prepareQuit(REQUEST, h.deps)).toBe('stayed');
    expect(h.steps).toEqual([
      'blur',
      'flush 2500',
      'settle 750',
      'leave 750',
      'settle 750',
      'end leaving',
      'cancel',
      `toast ${STAYED_TOAST}`,
    ]);
  });

  it('finishes despite a failed save when told to quit anyway', async () => {
    const h = harness();
    h.deps.flushOpenPages = async () => {
      h.fail();
    };
    expect(await prepareQuit(REQUEST, h.deps, true)).toBe('finished');
    expect(h.steps).toContain('finish');
    expect(h.steps).not.toContain('cancel');
  });

  it('stays on an unexpected throw, or finishes under quit anyway, and never rejects', async () => {
    const boom = () => Promise.reject(new Error('boom'));
    const stays = harness({ flushOpenPages: boom });
    expect(await prepareQuit(REQUEST, stays.deps)).toBe('stayed');
    expect(stays.steps).toContain('cancel');
    expect(stays.steps).not.toContain('finish');

    const goes = harness({ beginLeaving: boom });
    expect(await prepareQuit(REQUEST, goes.deps, true)).toBe('finished');
    expect(goes.steps).toContain('finish');

    const worst = harness({
      blurFocused: () => {
        throw new Error('blur');
      },
      cancelQuit: boom,
      toast: () => {
        throw new Error('toast');
      },
      finishQuit: boom,
    });
    await expect(prepareQuit(REQUEST, worst.deps)).resolves.toBe('stayed');
    await expect(prepareQuit(REQUEST, worst.deps, true)).resolves.toBe('finished');
  });
});

describe('beginLeaving', () => {
  it('resolves when the quit screen mounts, or at its budget', async () => {
    let left = false;
    const leaving = beginLeaving(60_000).then(() => (left = true));
    expect(isQuitting()).toBe(true);
    await settle();
    expect(left).toBe(false);
    markLeft();
    await leaving;
    expect(left).toBe(true);

    vi.useFakeTimers();
    let timedOut = false;
    void beginLeaving(100).then(() => (timedOut = true));
    await vi.advanceTimersByTimeAsync(100);
    expect(timedOut).toBe(true);
  });
});

describe('useQuitHost', () => {
  it('ignores a second request while one runs', async () => {
    let release!: () => void;
    const h = harness();
    h.deps.flushOpenPages = (ms) => {
      h.steps.push(`flush ${ms}`);
      return new Promise<void>((resolve) => (release = resolve));
    };
    renderHook(() => useQuitHost(h.deps));
    await settle();
    h.ask();
    await settle();
    h.ask();
    await settle();
    release();
    await vi.waitFor(() => expect(h.steps).toContain('finish'));
    expect(h.steps.filter((step) => step === 'blur')).toHaveLength(1);
  });

  it('quits anyway within 30 s of a stay, and not after', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = harness();
    let failing = true;
    h.deps.settlePageWrites = async () => {
      if (failing) h.fail();
      return true;
    };
    renderHook(() => useQuitHost(h.deps));
    await settle();

    h.ask();
    await vi.waitFor(() => expect(h.steps).toContain('cancel'));
    vi.setSystemTime(Date.now() + QUIT_ANYWAY_MS - 1_000);
    h.ask();
    await vi.waitFor(() => expect(h.steps).toContain('finish'));

    // A finish clears the stay: the next failure stays open again.
    h.steps.length = 0;
    h.ask();
    await vi.waitFor(() => expect(h.steps).toContain('cancel'));
    expect(h.steps).not.toContain('finish');

    // So does time.
    h.steps.length = 0;
    vi.setSystemTime(Date.now() + QUIT_ANYWAY_MS + 1);
    h.ask();
    await vi.waitFor(() => expect(h.steps).toContain('cancel'));
    expect(h.steps).not.toContain('finish');
    failing = false;
  });

  it('unlistens on unmount', async () => {
    const h = harness();
    const { unmount } = renderHook(() => useQuitHost(h.deps));
    await settle();
    expect(h.listening()).toBe(true);
    unmount();
    expect(h.unlisten).toHaveBeenCalledTimes(1);
    expect(h.listening()).toBe(false);
  });

  it('unlistens even when unmounted before the listener binds', async () => {
    const h = harness();
    const { unmount } = renderHook(() => useQuitHost(h.deps));
    unmount();
    await settle();
    expect(h.unlisten).toHaveBeenCalledTimes(1);
  });
});
