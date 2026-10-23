import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

// Run only after the shared build/test/browser lanes have finished.
// Uses the shipped production bundle and its existing browser mock; no source
// imports, app instrumentation, hidden benchmark entry or real-vault writes.
const baseURL = process.env.CEREBRO_BENCH_URL ?? 'http://localhost:5392';
const output = process.env.CEREBRO_BENCH_OUTPUT ?? '/private/tmp/cerebro-m87-perf/production-retained.json';
const repo = process.env.CEREBRO_BENCH_REPO ?? process.cwd();
const require = createRequire(path.join(repo, 'package.json'));
const { chromium } = require('@playwright/test');
const dist = path.join(repo, 'dist');
const requested = process.argv[2] ?? 'all';
const fixtures = requested === 'all'
  ? [[1000, 12], [100, 12], [100, 24], [1000, 24], [5000, 12], [5000, 24]]
  : [requested.split('x').map(Number)];
if (fixtures.some(([rows, columns]) => !Number.isInteger(rows) || !Number.isInteger(columns)))
  throw new Error('Expected all or rowsxcolumns');
const preflight = process.env.CEREBRO_BENCH_PREFLIGHT === '1';
const samples = preflight ? 1 : 20;
const inputStopMs = 2000;
const fixtureDeadlineMs = 45000;
const overallDeadlineMs = 240000;
async function bundleSnapshot() {
  const allFiles = (await fs.readdir(dist, { recursive: true })).sort();
  const files = [];
  for (const name of allFiles) {
    if (!/\.(?:js|html|css)$/.test(name)) continue;
    const bytes = await fs.readFile(path.join(dist, name));
    files.push({ name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  return { files, fingerprint: crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}
const { files: bundleFiles, fingerprint } = await bundleSnapshot();
const concurrency = () => ({
  at: new Date().toISOString(),
  load: os.loadavg(),
  // Executable names only: never capture arguments or environments.
  executableNames: execFileSync('ps', ['-A', '-o', 'comm='], { encoding: 'utf8' }).trim().split('\n').map((line) => path.basename(line.trim())),
});
const environment = {
  at: new Date().toISOString(), mode: 'Production Vite preview; real app database navigation with existing browser mock',
  purpose: preflight ? 'Correctness-only preflight during other gates; no timing claims' : 'Quiet-lane production timing diagnostic',
  platform: os.platform(), release: os.release(), architecture: os.arch(), cpu: os.cpus()[0]?.model,
  logicalCpus: os.cpus().length, memoryGiB: os.totalmem() / 1024 ** 3, node: process.version,
  viewport: { width: 1440, height: 900 }, baseURL, fingerprint, bundleFiles,
  samples, inputStopMs, fixtureDeadlineMs, overallDeadlineMs, teardownDeadlineMs: 10000,
  network: 'Only the exact preview origin permitted; no external requests',
  input: 'Synthetic bubbling ArrowDown at focused real table grid; event dispatch to two animation frames. No edits. Title plus12/24 declared text fields with140px explicit widths. Fresh browser context per fixture. No result limit. Full sidebar and page header retained.',
  navigation: 'Seed in-memory markdown before Open demo vault; use actual Databases rail and Benchmark Type sidebar button. Measure page navigation to all expected DOM rows plus two frames separately from warmed input.',
  caveat: 'Unthrottled headless Chromium on shared machine. Synthetic key-to-two-frame timing is diagnostic; not trusted native input-to-photon or packaged WKWebView performance.',
};
const results = [];
const machine = { before: concurrency(), after: null };
let bundleAfter = null;
const browser = await chromium.launch({ headless: true });
const browserVersion = await browser.version();
const startedAt = Date.now();
let stopReason = null;
async function persist() {
  await fs.writeFile(output, JSON.stringify({ environment, browser: browserVersion, results, stopReason, machine, bundleAfter }, null, 2));
}
async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms); })]);
  } finally { clearTimeout(timer); }
}
try {
  for (const [count, cols] of fixtures) {
    if (Date.now() - startedAt > overallDeadlineMs) { stopReason = 'Overall budget reached before next fixture; remaining fixtures unmeasured'; break; }
    const context = await browser.newContext({ viewport: environment.viewport, timezoneId: 'UTC' });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.route('**/*', async (route) => {
      if (new URL(route.request().url()).origin === new URL(baseURL).origin) await route.continue();
      else await route.abort();
    });
    const result = { count, cols, status: 'pending', loadBefore: os.loadavg() };
    results.push(result);
    try {
      await bounded((async () => {
        await page.addInitScript(({ count, cols }) => {
          localStorage.setItem('cerebro.autoLearn', 'false');
          localStorage.setItem('cerebro.themeMode', 'light');
          const seed = (disk) => {
            const names = Array.from({ length: cols }, (_, i) => `field${i}`);
            disk.clear();
            const fields = names.map((name) => `  ${name}: { kind: text }`).join('\n');
            const columns = names.map((name) => `{ field: ${name}, width: 140 }`).join(', ');
            disk.set('types/benchmark.md', `---\ntype: Type\nfields:\n${fields}\nviews:\n  - id: benchmark\n    name: All\n    filters: null\n    presentation:\n      type: table\n      group: []\n      sort: []\n      columns: [${columns}]\n---\n# Benchmark\n`);
            for (let i = 0; i < count; i++) disk.set(`benchmark/${String(i).padStart(5, '0')}.md`, `---\ntype: Benchmark\n${names.map((name) => `${name}: Value ${i}`).join('\n')}\n---\n# Benchmark record ${i}\n`);
            window.__benchmarkSeedReady = true;
          };
          // The mock publishes its existing map during module initialization.
          // Seed synchronously at that assignment, before App's automatic
          // last-vault scan; a polling timer can lose that first-read race.
          let disk;
          Object.defineProperty(window, '__cerebroMockFs', {
            configurable: true,
            get: () => disk,
            set: (next) => { disk = next; seed(next); },
          });
        }, { count, cols });
        await page.goto(baseURL);
        await page.waitForFunction(() => window.__benchmarkSeedReady === true);
        const demo = page.getByRole('button', { name: 'Open demo vault', exact: true });
        const rail = page.getByTestId('app-rail');
        await demo.or(rail).first().waitFor();
        if (await demo.isVisible()) await demo.click();
        await rail.waitFor();
        await page.getByTestId('app-rail').getByRole('button', { name: 'Databases', exact: true }).click();
        const opener = page.getByTestId('sidebar-type').filter({ hasText: 'Benchmark' }).first();
        await opener.waitFor();
        await page.evaluate(() => { window.__benchmarkOpenStart = performance.now(); });
        await opener.click();
        await page.waitForFunction((count) => document.querySelectorAll('[data-testid="table-row"]').length === count, count);
        await page.evaluate(() => document.fonts.ready);
        const initial = await page.evaluate(async () => {
          const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          await frame();
          const grid = document.querySelector('[data-testid="table-view"]');
          const mountedMs = performance.now() - window.__benchmarkOpenStart;
          grid.focus();
          await frame();
          window.__benchmarkTasks = [];
          window.__benchmarkObserver = new PerformanceObserver((list) => window.__benchmarkTasks.push(...list.getEntries().map((entry) => ({ at: entry.startTime, duration: entry.duration }))));
          window.__benchmarkObserver.observe({ type: 'longtask', buffered: false });
          const box = grid.getBoundingClientRect();
          return { mountedMs, host: { x: box.x, y: box.y, width: box.width, height: box.height, scrollWidth: grid.scrollWidth, scrollHeight: grid.scrollHeight }, renderedRows: document.querySelectorAll('[data-testid="table-row"]').length, columnCount: grid.getAttribute('aria-colcount'), contentVisibility: getComputedStyle(document.querySelector('[data-testid="table-row"]')).contentVisibility };
        });
        Object.assign(result, initial, { inputMs: [], activeDescendants: [], status: 'measuring' });
        if (Number(initial.columnCount) !== cols + 2 || initial.renderedRows !== count || initial.contentVisibility !== 'visible')
          throw new Error('Expected complete uncontained fixture with title, gutter and every declared field');
        await persist();
        for (let sample = 0; sample < samples; sample++) {
          const observed = await page.evaluate(async () => {
            const grid = document.querySelector('[data-testid="table-view"]');
            const start = performance.now();
            grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            return { ms: performance.now() - start, active: grid.getAttribute('aria-activedescendant') };
          });
          result.inputMs.push(observed.ms);
          result.activeDescendants.push(observed.active);
          await persist();
          if (observed.ms > inputStopMs) { result.status = 'stopped-input-budget'; break; }
        }
        const metrics = await page.evaluate(async () => {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          window.__benchmarkObserver.disconnect();
          return { tasks: window.__benchmarkTasks, writes: window.__cerebroMockWrites.length, rows: document.querySelectorAll('[data-testid="table-row"]').length };
        });
        result.longTasks = metrics.tasks;
        result.maxWarmedTaskMs = Math.max(0, ...metrics.tasks.map((task) => task.duration));
        result.writes = metrics.writes;
        result.finalRenderedRows = metrics.rows;
        const sorted = [...result.inputMs].sort((a, b) => a - b);
        result.p95InputMs = preflight ? null : sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null;
        result.cursorActuallyMoved = result.activeDescendants.every(Boolean) && new Set(result.activeDescendants).size === result.inputMs.length;
        if (!result.cursorActuallyMoved || metrics.writes !== 0 || metrics.rows !== count) throw new Error('Fixture correctness validation failed');
        if (result.status === 'measuring') result.status = 'complete';
        if (preflight) await page.screenshot({ path: output.replace(/\.json$/, '.png'), animations: 'disabled' });
      })(), Math.min(fixtureDeadlineMs, overallDeadlineMs - (Date.now() - startedAt)), `${count}x${cols}`);
    } catch (error) {
      result.status = 'failed-or-timeout';
      result.error = String(error);
      stopReason = 'A fixture failed/timed out; remaining fixtures unmeasured';
    } finally {
      result.loadAfter = os.loadavg();
      await persist();
      await bounded(context.close(), 10000, 'Closing fixture context');
      console.log(JSON.stringify(result));
    }
    if (stopReason || result.status === 'stopped-input-budget') {
      stopReason ??= 'Single input exceeded2000ms; bounded diagnostic stopped, remaining fixtures unmeasured';
      break;
    }
  }
} finally {
  machine.after = concurrency();
  const after = await bundleSnapshot();
  bundleAfter = { fingerprint: after.fingerprint, unchanged: after.fingerprint === fingerprint };
  if (!bundleAfter.unchanged) stopReason = 'Production bundle changed during the run; timing results are invalid';
  await persist();
  await browser.close();
}
