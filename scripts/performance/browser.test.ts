// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page, Route } from '@playwright/test';
const doubles = vi.hoisted(() => ({
  browser: { newContext: vi.fn(), version: () => 'protocol-fake', close: vi.fn() },
  child: { exitCode: 0, kill: vi.fn() },
}));
vi.mock('@playwright/test', () => ({
  chromium: {
    launchServer: async () => ({
      wsEndpoint: () => 'ws://protocol-fake',
      process: () => doubles.child,
    }),
    connect: async () => doubles.browser,
  },
}));
import { launchDriver, milestone } from './browser';
import { buildCorpus, reliabilityMatrix } from './corpus';

const fixture = reliabilityMatrix().find((row) => row.kind === 'search')!;
const corpus = buildCorpus(fixture);
const options = {
  output: '/tmp/not-written',
  samples: 1,
  preflight: true,
  cases: [],
  fixtureMs: 1000,
  overallMs: 1000,
  seed: 93,
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function fakePage() {
  const locator = {
    fill: vi.fn(),
    waitFor: vi.fn(),
    isVisible: vi.fn(() => false),
    click: vi.fn(),
    filter: vi.fn(),
    first: vi.fn(),
    or: vi.fn(),
  };
  locator.filter.mockReturnValue(locator);
  locator.first.mockReturnValue(locator);
  locator.or.mockReturnValue(locator);
  return {
    on: vi.fn(),
    route: vi.fn(),
    setDefaultTimeout: vi.fn(),
    close: vi.fn(),
    addInitScript: vi.fn(),
    goto: vi.fn(),
    waitForFunction: vi.fn(),
    evaluate: vi.fn(() => false),
    keyboard: { press: vi.fn() },
    getByRole: vi.fn(() => locator),
    getByTestId: vi.fn(() => locator),
  };
}
function fakeContext(page = fakePage()) {
  return {
    route: vi.fn(),
    routeWebSocket: vi.fn(),
    close: vi.fn(),
    newPage: vi.fn(async () => page as unknown as Page),
    newCDPSession: vi.fn(async () => ({
      send: vi.fn(async () => ({ metrics: [] })),
      detach: vi.fn(),
    })),
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  doubles.browser.newContext.mockReset();
  doubles.browser.close.mockReset().mockResolvedValue(undefined);
  doubles.child.kill.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('bounded browser ownership', () => {
  it('returns a startup timeout even when context allocation never answers', async () => {
    doubles.browser.newContext.mockReturnValue(new Promise(() => undefined));
    const driver = await launchDriver('http://127.0.0.1:1');
    let result: Awaited<ReturnType<typeof driver.measure>> | undefined;
    void driver.measure(fixture, corpus, options).then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(1001);
    expect(result?.observations.find((row) => row.phase === 'readiness')?.status).toBe('timeout');
    expect(result?.correctness).toBe('failed');
    await driver.close();
  });

  it('closes a context allocated after expiry without creating its page', async () => {
    const allocation = deferred<BrowserContext>();
    doubles.browser.newContext.mockReturnValue(allocation.promise);
    const context = fakeContext();
    const driver = await launchDriver('http://127.0.0.1:1');
    void driver.measure(fixture, corpus, options);
    await vi.advanceTimersByTimeAsync(1001);
    allocation.resolve(context as unknown as BrowserContext);
    await vi.advanceTimersByTimeAsync(0);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(context.newPage).not.toHaveBeenCalled();
    await driver.close();
  });

  it.each(['route', 'routeWebSocket'] as const)(
    'bounds a stalled %s setup and closes its context',
    async (method) => {
      const context = fakeContext();
      context[method].mockReturnValue(new Promise(() => undefined));
      doubles.browser.newContext.mockResolvedValue(context);
      const driver = await launchDriver('http://127.0.0.1:1');
      const pending = driver.measure(fixture, corpus, options);
      await vi.advanceTimersByTimeAsync(1001);
      expect((await pending).observations.find((row) => row.phase === 'readiness')?.status).toBe(
        'timeout',
      );
      expect(context.close).toHaveBeenCalledTimes(1);
      expect(context.newPage).not.toHaveBeenCalled();
      await driver.close();
    },
  );

  it('cleans up a partial setup rejection and installs the origin route before any page', async () => {
    const context = fakeContext();
    context.newPage.mockRejectedValue(new Error('page allocation refused'));
    doubles.browser.newContext.mockResolvedValue(context);
    const driver = await launchDriver('http://127.0.0.1:1');
    const result = await driver.measure(fixture, corpus, options);
    expect(result.correctness).toBe('failed');
    expect(result.failure).toContain('page allocation refused');
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(context.route.mock.invocationCallOrder[0]).toBeLessThan(
      context.newPage.mock.invocationCallOrder[0],
    );
    const handler = context.route.mock.calls[0]?.[1] as
      ((route: Route) => Promise<void>) | undefined;
    expect(handler).toBeTypeOf('function');
    if (handler) {
      const popup = {
        request: () => ({ url: () => 'http://127.0.0.1:2/popup' }),
        abort: vi.fn(),
        continue: vi.fn(),
      };
      await handler(popup as unknown as Route);
      expect(popup.abort).toHaveBeenCalledTimes(1);
      expect(popup.continue).not.toHaveBeenCalled();
      const own = {
        request: () => ({ url: () => 'http://127.0.0.1:1/assets/app.js' }),
        abort: vi.fn(),
        continue: vi.fn(),
      };
      await handler(own as unknown as Route);
      expect(own.continue).toHaveBeenCalledTimes(1);
    }
    await driver.close();
  });

  it('closes both the owned context and a page that arrives after its setup deadline', async () => {
    const allocation = deferred<Page>();
    const context = fakeContext();
    const page = fakePage();
    context.newPage.mockReturnValue(allocation.promise);
    doubles.browser.newContext.mockResolvedValue(context);
    const driver = await launchDriver('http://127.0.0.1:1');
    void driver.measure(fixture, corpus, options);
    await vi.advanceTimersByTimeAsync(1001);
    expect(context.close).toHaveBeenCalledTimes(1);
    allocation.resolve(page as unknown as Page);
    await vi.advanceTimersByTimeAsync(0);
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(page.addInitScript).not.toHaveBeenCalled();
    await driver.close();
  });

  it('records an absent frontend_ready mark as a timeout row, never a zero, and goes on', async () => {
    const page = fakePage();
    // The mark poll answers null; frames and elapsed time answer a number;
    // the vault-write check answers that nothing was written.
    page.evaluate.mockImplementation(((fn: () => unknown) => {
      const source = String(fn);
      if (source.includes('getEntriesByName')) return Promise.resolve(null);
      if (source.includes('__cerebroMockWrites')) return Promise.resolve(false);
      return Promise.resolve(4);
    }) as never);
    doubles.browser.newContext.mockResolvedValue(fakeContext(page));
    const driver = await launchDriver('http://127.0.0.1:1');
    const result = await driver.measure(fixture, corpus, { ...options, preflight: false });
    expect(result.correctness).toBe('passed');
    expect(result.observations.find((row) => row.phase === 'frontend-ready')).toMatchObject({
      status: 'timeout',
      samples: [],
      p95: null,
    });
    expect(result.observations.find((row) => row.phase === 'filter')?.status).toBe('measured');
    await driver.close();
  });

  it('reads a milestone relative to its start, and a non-number as absent', async () => {
    const page = fakePage();
    page.evaluate.mockResolvedValueOnce(250 as never).mockResolvedValueOnce('late' as never);
    expect(await milestone(page as unknown as Page, 'editor_ready', 100)).toBe(150);
    expect(await milestone(page as unknown as Page, 'frontend_ready', 0)).toBeNull();
  });

  it('resets attribution before timed boot after preflight reached memory', async () => {
    const preflight = fakeContext();
    const timedPage = fakePage();
    timedPage.goto.mockReturnValue(new Promise(() => undefined));
    const timed = fakeContext(timedPage);
    doubles.browser.newContext.mockResolvedValueOnce(preflight).mockResolvedValueOnce(timed);
    const driver = await launchDriver('http://127.0.0.1:1');
    const pending = driver.measure(fixture, corpus, { ...options, preflight: false });
    await vi.advanceTimersByTimeAsync(1001);
    const result = await pending;
    expect(preflight.newCDPSession).toHaveBeenCalledTimes(1);
    expect(result.diagnostics?.stage).toBe('production page navigation');
    expect(result.observations.find((row) => row.phase === 'readiness')?.status).toBe('timeout');
    expect(result.observations.find((row) => row.phase === 'memory')?.status).toBe('unavailable');
    expect(preflight.close).toHaveBeenCalledTimes(1);
    expect(timed.close).toHaveBeenCalledTimes(1);
    await driver.close();
  });
});
