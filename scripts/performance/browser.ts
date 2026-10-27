import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { stripVTControlCharacters } from 'node:util';
import type { BenchmarkCase, Corpus } from './corpus';
import {
  PHASES,
  measurement,
  typingSamples,
  type BenchmarkResult,
  type Observation,
  type Phase,
} from './report';
import { TimeoutError, withDeadline, type Options } from './measure';

type BrowserProbe = {
  __performanceSeeded?: boolean;
  __performanceStart?: number;
  __performanceFirst?: number | null;
  __performanceObserver?: MutationObserver;
  __cerebroMockFs?: Map<string, string>;
  __cerebroMockWrites?: unknown[];
  __performanceTasks?: { at: number; duration: number }[];
  __performanceTaskObserver?: PerformanceObserver;
  __performanceTasksTruncated?: boolean;
  __performanceKeys?: number[];
  __performanceTyping?: boolean;
  __performanceSerialize?: number[];
  __performanceSerializeObserver?: PerformanceObserver;
};

/** Characters per typing burst. Each burst is one save window: it types at
 * frame pace, well inside the debounce, then waits for its save to land. */
export const BURST = 10;
/** How long a missing app milestone is awaited before it is a timeout row. */
export const MILESTONE_MS = { frontend_ready: 5_000, editor_ready: 15_000 } as const;

/** All timing boundaries below observe the shipped app. No source modules are imported into it. */
async function frames(page: Page): Promise<number> {
  return page.evaluate(async () => {
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
    return performance.now();
  });
}
async function mark(page: Page, selector?: string): Promise<void> {
  await page.evaluate((selector) => {
    const host = window as Window & BrowserProbe;
    host.__performanceObserver?.disconnect();
    host.__performanceStart = performance.now();
    host.__performanceFirst = null;
    if (!selector) return;
    const observe = () => {
      const node = document.querySelector<HTMLElement>(selector);
      if (node && node.getBoundingClientRect().height > 0) {
        host.__performanceFirst = performance.now() - host.__performanceStart!;
        host.__performanceObserver?.disconnect();
      }
    };
    host.__performanceObserver = new MutationObserver(observe);
    host.__performanceObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    observe();
  }, selector);
}
async function elapsed(page: Page): Promise<number> {
  await frames(page);
  return page.evaluate(
    () => performance.now() - (window as Window & BrowserProbe).__performanceStart!,
  );
}

async function seed(page: Page, corpus: Corpus): Promise<void> {
  const initialize = ({ files, conversation }: Pick<Corpus, 'files' | 'conversation'>) => {
    localStorage.setItem('cerebro.autoLearn', 'false');
    localStorage.setItem('cerebro.themeMode', 'light');
    if (conversation) {
      localStorage.setItem('cerebro.conversations', JSON.stringify([conversation]));
      localStorage.setItem('cerebro.activeConversation', 'performance-transcript');
    }
    let disk: Map<string, string> | undefined;
    // Install before the mock's module assignment, before the first vault scan.
    Object.defineProperty(window, '__cerebroMockFs', {
      configurable: true,
      get: () => disk,
      set: (next: Map<string, string>) => {
        disk = next;
        next.clear();
        for (const file of files) next.set(file.path, file.content);
        (window as Window & BrowserProbe).__performanceSeeded = true;
      },
    });
  };
  // tsx preserves the names of functions with a generated __name helper.
  // Playwright transfers closures as source, without their module helper.
  // Install its identity behavior in the SAME init script before that source;
  // ordering between separate addInitScript calls is intentionally undefined.
  await page.addInitScript({
    content: `globalThis.__name = (fn) => fn; (${initialize.toString()})(${JSON.stringify({ files: corpus.files, conversation: corpus.conversation })});`,
  });
}
async function boot(page: Page, url: string, stage: (name: string) => void): Promise<void> {
  stage('production page navigation');
  await page.goto(url);
  stage('corpus seed assignment');
  await page.waitForFunction(() => (window as Window & BrowserProbe).__performanceSeeded === true);
  const demo = page.getByRole('button', { name: 'Open demo vault', exact: true });
  const rail = page.getByTestId('app-rail');
  stage('vault chooser or shell');
  await demo.or(rail).first().waitFor();
  if (await demo.isVisible()) await demo.click();
  await rail.waitFor();
  stage('fonts ready');
  await page.evaluate(() => document.fonts.ready);
}

type Recorder = (phase: Phase, sample: number, unit?: Observation['unit'], reason?: string) => void;
/** A phase whose observation never arrived within its bound: never a zero. */
type Missing = (phase: Phase, reason: string) => void;

/**
 * The app's own performance mark (`src/lib/perfMarks.ts`), as milliseconds
 * since `since` on the page clock, or null when it never came. The page polls
 * its timeline; the product never reads these marks itself.
 */
export async function milestone(
  page: Page,
  name: keyof typeof MILESTONE_MS,
  since: number,
): Promise<number | null> {
  const at = await page.evaluate(
    async ({ milestone, since, timeout }) => {
      const deadline = performance.now() + timeout;
      for (;;) {
        const mark = performance
          .getEntriesByName(milestone, 'mark')
          .find((entry) => entry.startTime >= since);
        if (mark) return mark.startTime;
        if (performance.now() > deadline) return null;
        await new Promise((done) => setTimeout(done, 25));
      }
    },
    { milestone: name, since, timeout: MILESTONE_MS[name] },
  );
  return typeof at === 'number' && Number.isFinite(at) ? Math.max(0, at - since) : null;
}
async function observeScroll(page: Page, selector: string, count: number, record: Recorder) {
  for (let i = 0; i < count; i++) {
    const sample = await page.evaluate(
      async ({ selector, i }) => {
        let node = document.querySelector<HTMLElement>(selector);
        while (
          node &&
          !(
            node.scrollHeight > node.clientHeight &&
            /auto|scroll/.test(getComputedStyle(node).overflowY)
          )
        )
          node = node.parentElement;
        if (!node) throw new Error('No scrollable workload surface');
        const before = node.scrollTop;
        const start = performance.now();
        node.scrollTop = i % 2 === 0 ? node.scrollHeight : 0;
        await new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        );
        if (node.scrollTop === before) throw new Error('Scroll sample did not move the surface');
        return performance.now() - start;
      },
      { selector, i },
    );
    record(
      'scroll',
      sample,
      'ms',
      'Programmatic scrollTop change to two animation frames; not native wheel latency',
    );
  }
}

async function table(
  page: Page,
  fixture: BenchmarkCase,
  samples: number,
  record: Recorder,
  phase: (p: Phase) => void,
) {
  await page
    .getByTestId('app-rail')
    .getByRole('button', { name: 'Databases', exact: true })
    .click();
  const opener = page.getByTestId('sidebar-type').filter({ hasText: 'Benchmark' }).first();
  await opener.waitFor();
  phase('readiness');
  await mark(page, '[data-testid="table-row"]');
  await opener.click();
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-testid="table-row"]').length === count,
    fixture.count,
  );
  record(
    'readiness',
    await elapsed(page),
    'ms',
    'Database navigation to every expected row plus two animation frames; includes derivation and render',
  );
  const first = await page.evaluate(() => (window as Window & BrowserProbe).__performanceFirst);
  if (first !== null && first !== undefined)
    record(
      'first-content',
      first,
      'ms',
      'Navigation to first visible row insertion observed by MutationObserver',
    );
  const grid = page.getByTestId('table-view');
  if (Number(await grid.getAttribute('aria-colcount')) !== fixture.fields + 2)
    throw new Error('Declared table field count did not render');
  if (
    await page
      .locator('[data-testid="table-row"]')
      .first()
      .evaluate((node) => getComputedStyle(node).contentVisibility !== 'visible')
  )
    throw new Error('Unexpected offscreen content containment');
  await grid.focus();
  await frames(page);
  phase('input');
  const cursors = new Set<string>();
  for (let i = 0; i < samples; i++) {
    const sample = await grid.evaluate(async (grid) => {
      const start = performance.now();
      grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
      return { ms: performance.now() - start, active: grid.getAttribute('aria-activedescendant') };
    });
    if (!sample.active || cursors.has(sample.active))
      throw new Error('Synthetic key did not advance the real logical cursor');
    cursors.add(sample.active);
    record('input', sample.ms);
    if (sample.ms > 2000) throw new TimeoutError('Single input safety budget', 2000);
  }
  phase('scroll');
  await observeScroll(page, '[data-testid="table-view"]', samples, record);
  phase('filter');
  await page.getByTestId('view-control-search').click();
  const search = page.getByTestId('view-search-input');
  for (let i = 0; i < samples; i++) {
    await mark(page);
    await search.fill(`benchmark/${String(fixture.count - 1).padStart(5, '0')}.md`);
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="table-row"]').length === 1,
    );
    record(
      'filter',
      await elapsed(page),
      'ms',
      'View text filter to one matching row plus two animation frames',
    );
    await search.fill('');
    await page.waitForFunction(
      (count) => document.querySelectorAll('[data-testid="table-row"]').length === count,
      fixture.count,
    );
  }
  const writes = await page.evaluate(
    () => (window as Window & BrowserProbe).__cerebroMockWrites?.length,
  );
  if (writes !== 0) throw new Error('Read-only table workload made an unexpected vault write');
}

/** Install the per-key frame probe and the serializer observer once. */
async function installTypingProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = window as Window & BrowserProbe;
    host.__performanceKeys = [];
    host.__performanceSerialize = [];
    host.__performanceTyping = false;
    // The app clears each measure as it makes it; an observer still sees it.
    host.__performanceSerializeObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        if (entry.name === 'editor_serialize') host.__performanceSerialize!.push(entry.duration);
    });
    host.__performanceSerializeObserver.observe({ type: 'measure' });
    // From the key event's own timestamp to the end of the frame after its
    // handlers: a message posted from requestAnimationFrame runs once that
    // frame has been produced.
    document.addEventListener(
      'keydown',
      (event) => {
        if (!host.__performanceTyping) return;
        const start = event.timeStamp > 0 ? event.timeStamp : performance.now();
        requestAnimationFrame(() => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => host.__performanceKeys!.push(performance.now() - start);
          channel.port2.postMessage(null);
        });
      },
      { capture: true },
    );
  });
}

async function typingWorkload(page: Page, samples: number, record: Recorder) {
  await installTypingProbe(page);
  const writesTo = () =>
    page.evaluate(
      () =>
        ((window as Window & BrowserProbe).__cerebroMockWrites ?? []).filter(
          (write) => (write as { path?: string }).path === 'benchmark/document.md',
        ).length,
    );
  for (let burst = 0; burst < samples; burst++) {
    const token = ` k${burst.toString(36).padStart(2, '0')}`.padEnd(BURST, 'q');
    const writesBefore = await writesTo();
    await page.evaluate(() => {
      const host = window as Window & BrowserProbe;
      // Anything measured before this burst's first key belongs to no burst.
      host.__performanceSerializeObserver!.takeRecords();
      host.__performanceKeys = [];
      host.__performanceSerialize = [];
      host.__performanceTyping = true;
    });
    for (const [index, character] of [...token].entries()) {
      await page.keyboard.type(character);
      await page.waitForFunction(
        (count) => ((window as Window & BrowserProbe).__performanceKeys?.length ?? 0) >= count,
        index + 1,
      );
    }
    await page.evaluate(() => {
      (window as Window & BrowserProbe).__performanceTyping = false;
    });
    await page.waitForFunction(
      (token) =>
        (window as Window & BrowserProbe).__cerebroMockFs
          ?.get('benchmark/document.md')
          ?.includes(token) === true,
      token,
    );
    await frames(page);
    const observed = await page.evaluate(() => {
      const host = window as Window & BrowserProbe;
      for (const entry of host.__performanceSerializeObserver!.takeRecords())
        if (entry.name === 'editor_serialize') host.__performanceSerialize!.push(entry.duration);
      return { keys: host.__performanceKeys ?? [], serialize: host.__performanceSerialize ?? [] };
    });
    if (observed.keys.length !== BURST) throw new Error('A typed character produced no frame');
    const burstSamples = typingSamples({
      keystrokes: observed.keys,
      serializations: observed.serialize,
      writes: (await writesTo()) - writesBefore,
    });
    for (const sample of burstSamples.keystroke)
      record(
        'keystroke',
        sample,
        'ms',
        'Real key event (CDP) at the document end to the end of its next frame; includes handlers and render',
      );
    record(
      'serialize',
      burstSamples.serializeMsPerChange,
      'ms',
      `Serializer milliseconds per typed change: a ${BURST}-character burst's editor_serialize total until its save landed, divided by ${BURST}`,
    );
    record(
      'serialize-calls',
      burstSamples.serializeCalls,
      'count',
      `Serializer passes per ${BURST}-character burst, from its first key until its save landed`,
    );
    record(
      'writes',
      burstSamples.writes,
      'count',
      `Body writes per ${BURST}-character save window`,
    );
  }
  await page.evaluate(() =>
    (window as Window & BrowserProbe).__performanceSerializeObserver?.disconnect(),
  );
}

async function documentWorkload(
  page: Page,
  samples: number,
  record: Recorder,
  missing: Missing,
  phase: (p: Phase) => void,
) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Benchmark document');
  const option = page
    .getByRole('listbox', { name: 'Quick open results' })
    .getByTestId('quick-open-result')
    .filter({ hasText: 'Benchmark document' })
    .first();
  await option.waitFor();
  phase('readiness');
  await mark(page, '[data-testid="markdown-editor"] [contenteditable="true"]');
  const opened = await page.evaluate(() => performance.now());
  await option.click();
  phase('editor-ready');
  const ready = await milestone(page, 'editor_ready', opened);
  if (ready === null)
    missing(
      'editor-ready',
      `No editor_ready mark within ${MILESTONE_MS.editor_ready} ms of the open; the editor never announced readiness`,
    );
  else
    record(
      'editor-ready',
      ready,
      'ms',
      "Open click to the app's editor_ready mark: document loaded and its save listener attached",
    );
  phase('readiness');
  const editor = page.getByTestId('markdown-editor').locator('[contenteditable="true"]').first();
  await editor.waitFor();
  await page.waitForFunction(() =>
    document
      .querySelector('[data-testid="markdown-editor"] [contenteditable="true"]')
      ?.textContent?.includes('PERFORMANCE END'),
  );
  record(
    'readiness',
    await elapsed(page),
    'ms',
    'Page open to editable complete-document end sentinel plus two frames; parse/apply are not separately attributed',
  );
  const first = await page.evaluate(() => (window as Window & BrowserProbe).__performanceFirst);
  if (first !== null && first !== undefined) record('first-content', first);
  if (
    await page.evaluate(() => (window as Window & BrowserProbe).__cerebroMockWrites?.length !== 0)
  )
    throw new Error('Opening the document wrote bytes');
  phase('save-to-visible');
  await editor.focus();
  await editor.press('ControlOrMeta+End');
  for (let i = 0; i < samples; i++) {
    const marker = ` performance-save-${i}`;
    await mark(page);
    await page.keyboard.insertText(marker);
    await page.waitForFunction((marker) => {
      const host = window as Window & BrowserProbe;
      return (
        host.__cerebroMockFs?.get('benchmark/document.md')?.includes(marker) &&
        document.querySelector('[data-testid="markdown-editor"]')?.textContent?.includes(marker)
      );
    }, marker);
    record(
      'save-to-visible',
      await elapsed(page),
      'ms',
      'Text insertion through actual editor to mock file acknowledgement and visible content; includes autosave debounce, excludes native disk',
    );
  }
  phase('keystroke');
  await editor.press('ControlOrMeta+End');
  await typingWorkload(page, samples, record);
  phase('scroll');
  // Begin at the top so the first scroll proves a change even after typing at the end.
  await editor.press('ControlOrMeta+Home');
  await observeScroll(page, '[data-testid="markdown-editor"]', samples, record);
}

async function transcript(
  page: Page,
  fixture: BenchmarkCase,
  samples: number,
  record: Recorder,
  phase: (p: Phase) => void,
) {
  phase('readiness');
  await mark(page, '[data-testid="chat-message"]');
  await page.keyboard.press('ControlOrMeta+j');
  await page.waitForFunction((count) => {
    const panel = document.querySelector('[data-testid="ai-panel"]');
    return (
      panel !== null &&
      panel.getAttribute('data-minimized') !== 'true' &&
      document.querySelectorAll('[data-testid="chat-message"]').length === count
    );
  }, fixture.count);
  record(
    'readiness',
    await elapsed(page),
    'ms',
    'Open retained conversation presentation to all cached messages plus two frames; no live model or transcript file read',
  );
  const first = await page.evaluate(() => (window as Window & BrowserProbe).__performanceFirst);
  if (first !== null && first !== undefined) record('first-content', first);
  phase('scroll');
  // Chat opens at its end; first move up, then measure alternating extremes.
  await page.getByTestId('chat-scroll').evaluate((node) => {
    node.scrollTop = 0;
  });
  await frames(page);
  await observeScroll(page, '[data-testid="chat-scroll"]', samples, record);
  if (
    await page.evaluate(() => (window as Window & BrowserProbe).__cerebroMockWrites?.length !== 0)
  )
    throw new Error('Reading cached transcript wrote vault bytes');
}

async function searchWorkload(
  page: Page,
  samples: number,
  record: Recorder,
  phase: (p: Phase) => void,
) {
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByTestId('quick-open-input');
  phase('filter');
  for (let i = 0; i < samples; i++) {
    await input.fill('');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="quick-open-content-result"]').length === 0,
    );
    await mark(page);
    await input.fill('readableneedle');
    await page
      .getByTestId('quick-open-content-result')
      .filter({ hasText: 'note-9999.md' })
      .waitFor();
    record(
      'filter',
      await elapsed(page),
      'ms',
      '10,000-note human-readable mock body search to result plus two frames, including debounce; not Rust BM25 or agent-grant scope',
    );
  }
  // There is no public ready marker for an empty result, so this driver makes
  // no negative-result or grant-scope claim from a transiently empty list.
  if (
    await page.evaluate(() => (window as Window & BrowserProbe).__cerebroMockWrites?.length !== 0)
  )
    throw new Error('Search wrote vault bytes');
}

function missingReason(phase: Phase) {
  if (['scan', 'readable-corpus', 'tokenization'].includes(phase))
    return 'Native Rust phase is not exposed by the production browser mock; agent readable-scope/ranking acceptance requires a native runner';
  if (['derivation', 'render', 'editor-parse', 'editor-apply'].includes(phase))
    return 'No isolated production phase marks; composite readiness must not be attributed to this phase';
  return 'Not applicable to this workload or no observation recorded';
}

export async function launchDriver(url: string) {
  const launched = await chromium.launchServer({ headless: true });
  const browser = await chromium
    .connect(launched.wsEndpoint(), { timeout: 10000 })
    .catch((error: unknown) => {
      launched.process().kill('SIGKILL');
      throw error;
    });
  const killOwned = () => {
    const child = launched.process();
    if (child.exitCode === null) child.kill('SIGKILL');
  };
  const cleanups = new WeakMap<object, Promise<void>>();
  const cleanup = (resource: { close(): Promise<void> }, label: string) => {
    let pending = cleanups.get(resource);
    if (!pending) {
      pending = withDeadline(
        Promise.resolve().then(() => resource.close()),
        10000,
        label,
      ).catch((error: unknown) => {
        killOwned();
        throw error;
      });
      cleanups.set(resource, pending);
    }
    return pending;
  };
  let active: ((reason: Error) => BenchmarkResult) | null = null;
  let closing: Promise<void> | undefined;
  return {
    version: browser.version(),
    interrupt(reason: Error) {
      return active?.(reason) ?? null;
    },
    async measure(
      fixture: BenchmarkCase,
      corpus: Corpus,
      options: Options,
    ): Promise<BenchmarkResult> {
      if (active || closing) throw new Error('The performance driver is busy or closed');
      const result: BenchmarkResult = {
        caseId: fixture.id,
        runtime: 'browser-mock',
        correctness: 'not-run',
        observations: PHASES.map((phase) => measurement(phase, [], missingReason(phase))),
        diagnostics: { pageErrors: [], failedResources: [] },
      };
      const observations = new Map<Phase, Observation>();
      let activePhase: Phase = 'readiness';
      const start = Date.now();
      const controller = new AbortController();
      const ensureActive = () => {
        if (controller.signal.aborted) throw controller.signal.reason;
      };
      const snapshot = () => {
        result.observations = PHASES.map(
          (phase) =>
            observations.get(phase) ??
            measurement(
              phase,
              [],
              options.preflight
                ? 'Correctness-only preflight; timing values withheld'
                : missingReason(phase),
            ),
        );
        return structuredClone(result);
      };
      const interrupt = (reason: Error) => {
        if (!controller.signal.aborted) {
          result.correctness = 'failed';
          result.failure = stripVTControlCharacters(`${reason.name}: ${reason.message}`).slice(
            0,
            1000,
          );
          if (reason.name === 'TimeoutError') {
            const previous = observations.get(activePhase);
            observations.set(
              activePhase,
              measurement(
                activePhase,
                previous?.samples ?? [],
                result.failure,
                'timeout',
                previous?.unit,
              ),
            );
          }
          controller.abort(reason);
        }
        return snapshot();
      };
      active = interrupt;
      const acquire = async <T extends { close(): Promise<void> }>(
        pending: Promise<T>,
        label: string,
      ) => {
        const resource = await pending;
        // A timed-out allocation can still resolve. It must be disposed before
        // any continuation creates a page or installs workload code in it.
        if (controller.signal.aborted) {
          await cleanup(resource, label);
          ensureActive();
        }
        return resource;
      };
      // Correctness uses a separate fresh context. Its clock readings never
      // enter timed samples. Preflight-only runs withhold all timing values.
      for (const timed of options.preflight ? [false] : [false, true]) {
        activePhase = 'readiness';
        result.diagnostics!.stage = 'browser context allocation';
        let ownedContext: BrowserContext | undefined;
        let ownedPage: Page | undefined;
        const record: Recorder = (phase, sample, unit = 'ms', reason) => {
          if (!timed || controller.signal.aborted) return;
          const prior = observations.get(phase);
          observations.set(
            phase,
            measurement(
              phase,
              [...(prior?.samples ?? []), sample],
              reason ?? prior?.reason ?? undefined,
              undefined,
              unit,
            ),
          );
        };
        const missing: Missing = (phase, reason) => {
          if (!timed || controller.signal.aborted) return;
          const prior = observations.get(phase);
          observations.set(
            phase,
            measurement(phase, prior?.samples ?? [], reason, 'timeout', prior?.unit),
          );
        };
        try {
          await withDeadline(
            (async () => {
              ensureActive();
              const context = await acquire(
                browser.newContext({
                  viewport: { width: 1440, height: 900 },
                  timezoneId: 'UTC',
                  serviceWorkers: 'block',
                  acceptDownloads: false,
                }),
                'Late browser context cleanup',
              );
              ownedContext = context;
              ensureActive();
              result.diagnostics!.stage = 'context HTTP isolation';
              // Context routing covers the first popup navigation as well as
              // requests made by the original page. Install it before pages.
              await context.route('**/*', async (route) => {
                if (new URL(route.request().url()).origin === new URL(url).origin)
                  await route.continue();
                else await route.abort();
              });
              ensureActive();
              result.diagnostics!.stage = 'context WebSocket isolation';
              await context.routeWebSocket('**/*', (socket) => socket.close());
              ensureActive();
              result.diagnostics!.stage = 'browser page allocation';
              const page = await acquire(context.newPage(), 'Late browser page cleanup');
              ownedPage = page;
              ensureActive();
              page.on('pageerror', (error) => {
                if (result.diagnostics!.pageErrors.length < 20)
                  result.diagnostics!.pageErrors.push(error.message.slice(0, 500));
              });
              page.on('requestfailed', (request) => {
                if (result.diagnostics!.failedResources.length < 20)
                  result.diagnostics!.failedResources.push(new URL(request.url()).pathname);
              });
              page.setDefaultTimeout(Math.min(15000, options.fixtureMs));
              await seed(page, corpus);
              ensureActive();
              await boot(page, url, (stage) => {
                ensureActive();
                result.diagnostics!.stage = stage;
              });
              ensureActive();
              activePhase = 'frontend-ready';
              result.diagnostics!.stage = 'frontend_ready mark';
              const frontend = await milestone(page, 'frontend_ready', 0);
              if (frontend === null)
                missing(
                  'frontend-ready',
                  `No frontend_ready mark within ${MILESTONE_MS.frontend_ready} ms of the shell appearing`,
                );
              else
                record(
                  'frontend-ready',
                  frontend,
                  'ms',
                  "Navigation start to the app's frontend_ready mark: first shell commit for an open vault, including the vault chooser click",
                );
              activePhase = 'readiness';
              result.diagnostics!.stage = `${fixture.kind} workload`;
              if (timed)
                await page.evaluate(() => {
                  const host = window as Window & BrowserProbe;
                  if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) return;
                  host.__performanceTasks = [];
                  host.__performanceTasksTruncated = false;
                  host.__performanceTaskObserver = new PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                      if (host.__performanceTasks!.length < 1000)
                        host.__performanceTasks!.push({
                          at: entry.startTime,
                          duration: entry.duration,
                        });
                      else host.__performanceTasksTruncated = true;
                    }
                  });
                  host.__performanceTaskObserver.observe({ type: 'longtask', buffered: false });
                });
              const samples = timed ? options.samples : 1;
              const phase = (next: Phase) => {
                ensureActive();
                activePhase = next;
                result.diagnostics!.stage = `${fixture.kind}: ${next}`;
              };
              if (fixture.kind === 'table') await table(page, fixture, samples, record, phase);
              if (fixture.kind === 'document')
                await documentWorkload(page, samples, record, missing, phase);
              if (fixture.kind === 'transcript')
                await transcript(page, fixture, samples, record, phase);
              if (fixture.kind === 'search') await searchWorkload(page, samples, record, phase);
              phase('memory');
              const cdp = await context.newCDPSession(page);
              await cdp.send('Performance.enable');
              const { metrics } = await cdp.send('Performance.getMetrics');
              const heap = metrics.find((metric) => metric.name === 'JSHeapUsedSize');
              if (heap)
                record(
                  'memory',
                  heap.value,
                  'bytes',
                  'CDP renderer JavaScript heap at workload end; excludes native, GPU and total resident memory',
                );
              await cdp.detach();
            })(),
            Math.max(1, options.fixtureMs - (Date.now() - start)),
            `${fixture.id} ${timed ? 'timing' : 'preflight'}`,
            controller.signal,
          );
          result.correctness = 'passed';
        } catch (error) {
          interrupt(error instanceof Error ? error : new Error('Workload failed'));
          if (ownedPage)
            try {
              const state = await withDeadline(
                ownedPage.evaluate(() => ({
                  renderedRows: document.querySelectorAll('[data-testid="table-row"]').length,
                  seeded: (window as Window & BrowserProbe).__performanceSeeded === true,
                  visibleText: document.body.innerText.slice(0, 1000),
                  inputs: [...document.querySelectorAll('input')].slice(0, 20).map((input) => ({
                    label: input.getAttribute('aria-label') ?? '',
                    value: input.value.slice(0, 100),
                  })),
                  typeSource: (window as Window & BrowserProbe).__cerebroMockFs
                    ?.get('types/benchmark.md')
                    ?.slice(0, 4000),
                })),
                1000,
                'Failure diagnostics',
              );
              Object.assign(result.diagnostics!, state);
            } catch {
              /* A wedged renderer remains unavailable; do not extend its deadline. */
            }
          break;
        } finally {
          if (timed && ownedPage) {
            try {
              Object.assign(
                result.diagnostics!,
                await withDeadline(
                  ownedPage.evaluate(() => {
                    const host = window as Window & BrowserProbe;
                    for (const entry of host.__performanceTaskObserver?.takeRecords() ?? []) {
                      if (host.__performanceTasks!.length < 1000)
                        host.__performanceTasks!.push({
                          at: entry.startTime,
                          duration: entry.duration,
                        });
                      else host.__performanceTasksTruncated = true;
                    }
                    host.__performanceTaskObserver?.disconnect();
                    return {
                      longTasks: host.__performanceTasks ?? null,
                      longTasksTruncated: host.__performanceTasksTruncated ?? false,
                    };
                  }),
                  1000,
                  'Long-task observations',
                ),
              );
            } catch {
              result.diagnostics!.longTasks = null;
            }
          }
          // This destroys the only mutable corpus, including any editor writes.
          try {
            if (ownedContext) await cleanup(ownedContext, 'Browser context cleanup');
          } catch {
            result.correctness = 'failed';
            result.failure ??= 'Browser context cleanup exceeded its deadline';
          }
        }
        if (result.correctness === 'failed') break;
      }
      if (active === interrupt) active = null;
      return snapshot();
    },
    close() {
      if (!closing) {
        active?.(new Error('Browser shutdown interrupted the active fixture'));
        closing = withDeadline(browser.close(), 10000, 'Browser shutdown').finally(killOwned);
      }
      return closing;
    },
  };
}
