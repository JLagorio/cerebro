import { expect, test, type Page, type Locator } from '@playwright/test';
import { boot, readMockFile } from './boot';
const PATH = 'boards/editor.canvas';
const SOURCE = JSON.stringify({
  vendor: { kept: 'yes' },
  nodes: [
    {
      id: 'g',
      type: 'group',
      label: 'Group',
      x: -30,
      y: -30,
      width: 500,
      height: 250,
      vendor: [1, 2],
    },
    {
      id: 'a',
      type: 'text',
      text: 'Alpha card',
      x: 20,
      y: 20,
      width: 100,
      height: 80,
      vendor: { kept: true },
    },
    { id: 'b', type: 'text', text: 'Beta card', x: 220, y: 20, width: 100, height: 80 },
  ],
  edges: [{ id: 'e', fromNode: 'a', toNode: 'b', vendor: 'connection' }],
});
async function seed(page: Page) {
  await boot(page);
  await page.evaluate(
    ({ path, source }) => {
      window.__cerebroMockFs.set(path, source);
      localStorage.setItem(
        'cerebro.whiteboard.snap',
        JSON.stringify({ grid: false, objects: false }),
      );
      localStorage.setItem(
        'cerebro.whiteboard.cameras',
        JSON.stringify([
          {
            key: JSON.stringify(['/demo-vault', path]),
            transform: { scale: 1, offset: { x: 160, y: 100 } },
          },
        ]),
      );
    },
    { path: PATH, source: SOURCE },
  );
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Editor');
  await page
    .getByTestId('quick-open-content-result')
    .filter({ hasText: 'Editor' })
    .or(page.getByTestId('quick-open-result').filter({ hasText: 'Editor' }))
    .first()
    .click();
  await expect(page.getByTestId('wb-input')).toBeVisible();
}
const card = (page: Page, id: string) =>
  page.locator(`[data-testid="wb-node"][data-node-id="${id}"]`);
async function point(locator: Locator, x = 0.5, y = 0.3) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('No board item box');
  return { x: box.x + box.width * x, y: box.y + box.height * y };
}
async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 3, from.y + dy / 3);
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 });
  await page.mouse.up();
}
async function read(page: Page) {
  return JSON.parse((await readMockFile(page, PATH))!);
}
async function writes(page: Page) {
  return page.evaluate(
    (path) => window.__cerebroMockWrites.filter((w) => w.path === path).length,
    PATH,
  );
}
test('a drag is one saved edit with unknown keys kept; Undo and Redo restore exact scenes', async ({
  page,
}, info) => {
  await seed(page);
  const from = await point(card(page, 'a'));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 10);
  await page.mouse.move(from.x + 64, from.y + 40, { steps: 4 });
  expect(await readMockFile(page, PATH)).toBe(SOURCE);
  expect(await writes(page)).toBe(0);
  await page.mouse.up();
  await expect
    .poll(async () => (await read(page)).nodes.find((n: { id: string }) => n.id === 'a').x)
    .toBe(84);
  expect(await writes(page)).toBe(1);
  const changed = await read(page);
  expect(changed).toEqual({
    ...JSON.parse(SOURCE),
    nodes: JSON.parse(SOURCE).nodes.map((n: { id: string; x: number; y: number }) =>
      n.id === 'a' ? { ...n, x: 84, y: 60 } : n,
    ),
  });
  await page.screenshot({ path: info.outputPath('board-selected.png'), animations: 'disabled' });
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => read(page)).toEqual(JSON.parse(SOURCE));
  expect(await writes(page)).toBe(2);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => read(page)).toEqual(changed);
  expect(await writes(page)).toBe(3);
});
test('Shift resize keeps ratio; marquee selects only cards; a group drag carries both members', async ({
  page,
}) => {
  await seed(page);
  const a = await point(card(page, 'a'));
  await page.mouse.click(a.x, a.y);
  const handle = await point(page.locator('[data-testid="wb-handle"][data-handle="se"]'), 0.5, 0.5);
  await page.keyboard.down('Shift');
  await drag(page, handle, 40, 20);
  await page.keyboard.up('Shift');
  await expect
    .poll(async () => (await read(page)).nodes.find((n: { id: string }) => n.id === 'a').width)
    .toBe(140);
  const resized = (await read(page)).nodes.find((n: { id: string }) => n.id === 'a');
  expect(resized.width / resized.height).toBe(1.25);
  expect(await writes(page)).toBe(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => read(page)).toEqual(JSON.parse(SOURCE));
  await page.keyboard.press('Escape');
  const top = await point(card(page, 'a'), 0, 0);
  await drag(page, { x: top.x - 10, y: top.y - 10 }, 320, 100);
  await expect(page.getByTestId('wb-selection-count')).toHaveText('2 items selected');
  expect(await writes(page)).toBe(2);
  await page.keyboard.press('Escape');
  const group = await point(card(page, 'g'), 0.1, 0.08);
  await drag(page, group, 40, 30);
  await expect
    .poll(async () => (await read(page)).nodes.find((n: { id: string }) => n.id === 'g').x)
    .toBe(10);
  expect((await read(page)).nodes.map((n: { x: number }) => n.x)).toEqual([10, 60, 260]);
  expect(await writes(page)).toBe(3);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => read(page)).toEqual(JSON.parse(SOURCE));
  expect(await writes(page)).toBe(4);
});
test('Delete removes a card and its connection together; cancelled drag and view gestures never save', async ({
  page,
}) => {
  await seed(page);
  let a = await point(card(page, 'a'));
  await page.mouse.click(a.x, a.y);
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await read(page)).nodes.length).toBe(2);
  expect((await read(page)).edges).toEqual([]);
  expect(await writes(page)).toBe(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => read(page)).toEqual(JSON.parse(SOURCE));
  expect(await writes(page)).toBe(2);
  a = await point(card(page, 'a'));
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 30, a.y + 30);
  await page.mouse.move(a.x + 70, a.y + 40);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.keyboard.press('Escape');
  const view = page.getByTestId('canvas-viewport');
  const box = (await view.boundingBox())!;
  await page.mouse.move(box.x + box.width - 150, box.y + box.height - 100);
  await page.mouse.wheel(10, 30);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -50);
  await page.keyboard.up('Control');
  await page.keyboard.down('Space');
  await drag(page, { x: box.x + box.width - 150, y: box.y + box.height - 100 }, 30, -20);
  await page.keyboard.up('Space');
  await page.waitForTimeout(700);
  expect(await read(page)).toEqual(JSON.parse(SOURCE));
  expect(await writes(page)).toBe(2);
});
