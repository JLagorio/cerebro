import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile, openDestination } from './boot';
const PATH = 'boards/render.canvas';
const SOURCE = JSON.stringify({
  vendor: { untouched: true },
  nodes: [
    {
      id: 'g',
      type: 'group',
      label: 'Release plan',
      x: -40,
      y: -45,
      width: 850,
      height: 450,
      color: '4',
    },
    {
      id: 'text',
      type: 'text',
      text: '# Launch\n\n- First milestone\n- **Second milestone**\n\n[[Home|Project home]]',
      x: 0,
      y: 0,
      width: 250,
      height: 200,
      color: '1',
      vendor: 'kept',
    },
    {
      id: 'round',
      type: 'text',
      text: 'Round decision',
      x: 320,
      y: 0,
      width: 200,
      height: 160,
      color: '#1965aa',
    },
    {
      id: 'diamond',
      type: 'text',
      text: 'Ship it?',
      x: 590,
      y: 0,
      width: 180,
      height: 160,
      color: '3',
    },
    {
      id: 'file',
      type: 'file',
      file: 'notes/launch.md',
      x: 0,
      y: 260,
      width: 250,
      height: 100,
      color: '5',
    },
    {
      id: 'link',
      type: 'link',
      url: 'https://example.com/launch',
      x: 320,
      y: 260,
      width: 300,
      height: 100,
      color: '6',
    },
  ],
  edges: [
    { id: 'flow', fromNode: 'text', toNode: 'round', label: 'Review' },
    {
      id: 'next',
      fromNode: 'round',
      toNode: 'diamond',
      fromSide: 'right',
      toSide: 'left',
      color: '2',
    },
  ],
  cerebro: {
    version: 1,
    cards: { round: { shape: 'ellipse' }, diamond: { shape: 'diamond' } },
    vendor: 'also kept',
  },
});
async function openBoard(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Render');
  await page
    .getByTestId('quick-open-result')
    .filter({ hasText: 'Render' })
    .or(page.getByTestId('quick-open-content-result').filter({ hasText: 'Render' }))
    .first()
    .click();
  await expect(page.getByTestId('wb-scene')).toBeVisible();
}
async function seed(page: Page, savedCamera = false) {
  await boot(page);
  await page.evaluate(({ path, source }) => window.__cerebroMockFs.set(path, source), {
    path: PATH,
    source: SOURCE,
  });
  if (savedCamera)
    await page.evaluate(
      (path) =>
        localStorage.setItem(
          'cerebro.whiteboard.cameras',
          JSON.stringify([
            {
              key: JSON.stringify(['/demo-vault', path]),
              transform: { scale: 1.5, offset: { x: 40, y: 50 } },
            },
          ]),
        ),
      PATH,
    );
  await openBoard(page);
}
async function exportChoice(page: Page, label: string) {
  await page.getByRole('button', { name: 'Export whiteboard' }).click();
  await page.getByRole('menuitem', { name: label }).click();
}
test('draws every item, pans and zooms without a write, and remembers the camera', async ({
  page,
}, info) => {
  await seed(page, true);
  await expect(page.getByTestId('wb-node')).toHaveCount(6);
  await expect(page.getByTestId('wb-edge')).toHaveCount(2);
  await expect(page.getByTestId('canvas-summary')).toHaveText('6 cards · 2 connections');
  const view = page.getByTestId('canvas-viewport');
  const box = await view.boundingBox();
  expect(box).not.toBeNull();
  const first = await page
    .getByTestId('wb-node')
    .filter({ has: page.locator('[stroke="var(--canvas-1)"]') })
    .boundingBox();
  expect(first!.width).toBeGreaterThan(100);
  const plane = page.getByTestId('canvas-plane');
  const before = await plane.getAttribute('style');
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(40, 60);
  await expect(plane).not.toHaveAttribute('style', before!);
  await expect(page.getByRole('button', { name: 'Reset zoom' })).toHaveText('150%');
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -60);
  await page.keyboard.up('Control');
  await expect(page.getByRole('button', { name: 'Reset zoom' })).toHaveText('165%');
  // Return to150% and keep its exact pan as well as its scale.
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await expect(page.getByRole('button', { name: 'Reset zoom' })).toHaveText('150%');
  const moved = await plane.getAttribute('style');
  await openDestination(page, 'Home');
  await openBoard(page);
  await expect(plane).toHaveAttribute('style', moved!);
  expect(await readMockFile(page, PATH)).toBe(SOURCE);
  expect(
    await page.evaluate((path) => window.__cerebroMockWrites.filter((w) => w.path === path), PATH),
  ).toEqual([]);
  await page.getByRole('button', { name: 'Fit diagram' }).click();
  const light = await page
    .getByTestId('wb-board')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.screenshot({ path: info.outputPath('whiteboard-light.png'), animations: 'disabled' });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await expect
    .poll(() => page.getByTestId('wb-board').evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toBe(light);
  expect(
    await page
      .getByTestId('wb-node')
      .filter({ has: page.locator('[stroke="var(--canvas-5)"]') })
      .locator('g')
      .evaluate((el) => getComputedStyle(el).stroke),
  ).toBe('rgb(63, 184, 208)');
  await page.screenshot({ path: info.outputPath('whiteboard-dark.png'), animations: 'disabled' });
});
test('exports every card with literal paints as SVG and PNG', async ({ page, context }, info) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await seed(page);
  await exportChoice(page, 'Copy SVG');
  await expect(page.getByTestId('toast-host')).toContainText('SVG copied');
  const svg = await page.evaluate(() => navigator.clipboard.readText());
  for (const text of [
    'Launch',
    'First milestone',
    'Second milestone',
    'Project home',
    'Round decision',
    'Ship it?',
    'notes/launch.md',
    'https://example.com/launch',
    'Release plan',
    'Review',
  ])
    expect(svg).toContain(text);
  expect(svg).not.toContain('var(');
  expect(svg).not.toContain('color-mix(');
  expect(svg).not.toContain('href=');
  const downloadPromise = page.waitForEvent('download');
  await exportChoice(page, 'Save SVG…');
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Render.svg');
  await download.saveAs(info.outputPath('Render.svg'));
  expect(readFileSync(info.outputPath('Render.svg'), 'utf8')).toContain('Round decision');
  const pngPromise = page.waitForEvent('download');
  await exportChoice(page, 'Save PNG…');
  const png = await pngPromise;
  expect(png.suggestedFilename()).toBe('Render.png');
  await png.saveAs(info.outputPath('Render.png'));
  expect([...readFileSync(info.outputPath('Render.png')).subarray(0, 8)]).toEqual([
    137, 80, 78, 71, 13, 10, 26, 10,
  ]);
  await exportChoice(page, 'Copy PNG');
  await expect(page.getByTestId('toast-host')).toContainText('PNG copied');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await exportChoice(page, 'Copy SVG');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('rgb(63, 184, 208)');
  const dark = await page.evaluate(() => navigator.clipboard.readText());
  expect(dark).not.toContain('var(');
  expect(await readMockFile(page, PATH)).toBe(SOURCE);
});

test('standalone bounds contain outward curves and long connection labels', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await boot(page);
  const source = JSON.stringify({
    nodes: [
      { id: 'a', type: 'text', text: 'Wide card', x: 0, y: 0, width: 800, height: 800 },
      { id: 'b', type: 'text', text: 'Second card', x: 0, y: 1200, width: 800, height: 800 },
    ],
    edges: [
      { id: 'loop', fromNode: 'a', toNode: 'a', label: 'W'.repeat(200) },
      { id: 'out', fromNode: 'a', toNode: 'b', fromSide: 'right', toSide: 'right' },
    ],
  });
  await page.evaluate(({ path, source }) => window.__cerebroMockFs.set(path, source), {
    path: PATH,
    source,
  });
  await openBoard(page);
  const measurements = await page.getByTestId('wb-scene').evaluate((svg) => {
    const frame = (svg as SVGSVGElement).viewBox.baseVal;
    return {
      frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
      drawn: [
        ...svg.querySelectorAll('[data-edge-id] path,[data-edge-id] text,[data-edge-id] polygon'),
      ].map((el) => {
        const b = (el as SVGGraphicsElement).getBBox();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      }),
    };
  });
  for (const box of measurements.drawn) {
    expect(box.x).toBeGreaterThanOrEqual(measurements.frame.x);
    expect(box.y).toBeGreaterThanOrEqual(measurements.frame.y);
    expect(box.x + box.width).toBeLessThanOrEqual(measurements.frame.x + measurements.frame.width);
    expect(box.y + box.height).toBeLessThanOrEqual(
      measurements.frame.y + measurements.frame.height,
    );
  }
  await exportChoice(page, 'Copy SVG');
  await expect(page.getByTestId('toast-host')).toContainText('SVG copied');
  const saved = await page.evaluate(() => navigator.clipboard.readText());
  expect(saved).toContain('W'.repeat(200));
  expect(await readMockFile(page, PATH)).toBe(source);
});
