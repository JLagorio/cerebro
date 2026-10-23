import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
const label = process.argv[4] ?? 'after';
const samples = Number(process.argv[5] ?? 5);
const modulePath = label === 'before' ? '/src/views/BenchmarkBaseline.tsx' : '/src/views/TableView.tsx';
const environment = { at: new Date().toISOString(), platform: os.platform(), release: os.release(), architecture: os.arch(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryGiB: os.totalmem() / 1024 ** 3, loadBefore: os.loadavg(), node: process.version, viewport: { width: 1440, height: 900 }, samples, modulePath, mode: 'Vite development, unthrottled headless Chromium, sequential fixture mounts', externalNetwork: 'blocked; localhost:5382 only', input: 'Synthetic ArrowDown at row level; dispatch to two animation frames; all text fields 140px; title + 12/24 declared scalar fields; no record limit; no edits; each scroll +80px' };
console.log(JSON.stringify({ environment }));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
  else await route.abort();
});
await page.addInitScript(() => {
  localStorage.setItem('cerebro.autoLearn', 'false');
  localStorage.setItem('cerebro.themeMode', 'light');
});
await page.goto('http://localhost:5382/');
await page.getByRole('button', { name: 'Open demo vault' }).or(page.getByTestId('app-rail')).first().waitFor();
if (await page.getByRole('button', { name: 'Open demo vault' }).isVisible()) await page.getByRole('button', { name: 'Open demo vault' }).click();
await page.getByTestId('app-rail').waitFor();
const counts = process.argv[2] && process.argv[2] !== 'all' ? [Number(process.argv[2])] : [100, 1000, 5000];
const columns = process.argv[3] && process.argv[3] !== 'all' ? [Number(process.argv[3])] : [12, 24];
const results = [];
for (const count of counts) for (const cols of columns) {
  const result = await page.evaluate(async ({ count, cols, samples, modulePath, label }) => {
    const load = (path) => import(path);
    const [react, reactDom, { TableView }, { makeEntry }, { buildSchema }] = await Promise.all([
      load('/node_modules/.vite/deps/react.js'), load('/node_modules/.vite/deps/react-dom_client.js'),
      load(modulePath), load('/src/test/factories.ts'), load('/src/engine/schema.ts'),
    ]);
    const { createElement } = react.default ?? react;
    const { createRoot } = reactDom.default ?? reactDom;
    const names = Array.from({ length: cols }, (_, i) => `field${i}`);
    const type = makeEntry({ path: 'types/benchmark.md', title: 'Benchmark', type: 'Type', properties: { fields: Object.fromEntries(names.map((name) => [name, { kind: 'text' }])) } });
    const entries = Array.from({ length: count }, (_, i) => makeEntry({ path: `benchmark/${i}.md`, title: `Benchmark record ${i}`, type: 'Benchmark', properties: Object.fromEntries(names.map((name) => [name, `Value ${i}`])) }));
    const allEntries = [type, ...entries];
    const schema = buildSchema(allEntries);
    const holder = document.createElement('div');
    Object.assign(holder.style, { position: 'fixed', inset: '80px 50px', zIndex: '999', display: 'flex', background: 'white' });
    document.body.append(holder);
    const probeStyle = document.createElement('style');
    if(label === 'cv') probeStyle.textContent = '[data-testid=table-row]{content-visibility:auto;contain-intrinsic-size:auto 36px;}';
    document.head.append(probeStyle);
    const root = createRoot(holder);
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const tasks = [];
    const observer = new PerformanceObserver((list) => tasks.push(...list.getEntries().map((entry) => ({ at: entry.startTime, duration: entry.duration }))));
    observer.observe({ type: 'longtask', buffered: false });
    const start = performance.now();
    root.render(createElement(TableView, { entries, allEntries, schema, fields: schema.types.get('Benchmark').fields, presentation: { type: 'table', group: [], sort: [], columns: names.map((field) => ({ field, width: 140 })) } }));
    await frame();
    const mountedMs = performance.now() - start;
    const grid = holder.querySelector('[role=grid]');
    grid.focus();
    await frame();
    const warmedAt = performance.now();
    const responses = [];
    for (let i = 0; i < samples; i++) {
      const at = performance.now();
      grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await frame();
      responses.push(performance.now() - at);
    }
    for (let i = 0; i < 10; i++) { grid.scrollTop += 80; await frame(); }
    observer.disconnect();
    const p95 = [...responses].sort((a, b) => a - b)[Math.ceil(responses.length * .95) - 1];
    const box = grid.getBoundingClientRect();
    const data = { count, cols, host: { width: box.width, height: box.height, scrollWidth: grid.scrollWidth, scrollHeight: grid.scrollHeight }, inputMs: responses, mountedMs, p95InputMs: p95, maxWarmedTaskMs: Math.max(0, ...tasks.filter((task) => task.at >= warmedAt).map((task) => task.duration)), renderedRows: holder.querySelectorAll('[data-testid=table-row]').length };
    root.unmount(); holder.remove(); probeStyle.remove(); await frame();
    return data;
  }, { count, cols, samples, modulePath, label });
  results.push(result);
  console.log(JSON.stringify(result));
  await fs.writeFile(`/private/tmp/cerebro-m87-perf/${label}-${process.argv[2] ?? 'all'}-${process.argv[3] ?? 'all'}.json`, JSON.stringify({ environment, browser: await browser.version(), results, loadAfter: os.loadavg() }, null, 2));
}

await browser.close();
