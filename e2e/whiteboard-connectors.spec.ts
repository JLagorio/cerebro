import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile } from './boot';
const PATH = 'boards/connections.canvas';
const SOURCE = JSON.stringify({
  nodes: [
    { id: 'a', type: 'text', text: 'First', x: 20, y: 20, width: 120, height: 100 },
    { id: 'b', type: 'text', text: 'Second', x: 350, y: 20, width: 120, height: 100 },
  ],
  edges: [{ id: 'seed', fromNode: 'a', toNode: 'b', vendor: 'kept' }],
  vendor: { kept: true },
});
const read = async (page: Page) => JSON.parse((await readMockFile(page, PATH))!);
const writes = (page: Page) =>
  page.evaluate((path) => window.__cerebroMockWrites.filter((w) => w.path === path).length, PATH);
async function open(page: Page) {
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
            transform: { scale: 1, offset: { x: 100, y: 100 } },
          },
        ]),
      );
    },
    { path: PATH, source: SOURCE },
  );
  await page.evaluate(async () => {
    const path = '/src/stores/vaultStore.ts';
    const { useVaultStore } = await import(path);
    await useVaultStore.getState().rescan();
  });
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Connections');
  await page
    .getByTestId('quick-open-result')
    .filter({ hasText: PATH })
    .or(page.getByTestId('quick-open-content-result').filter({ hasText: PATH }))
    .first()
    .click();
  const input = page.getByTestId('wb-input');
  await expect(input).toBeVisible();
  await input.focus();
  const box = (await input.boundingBox())!;
  return (x: number, y: number) => ({ x: box.x + 100 + x, y: box.y + 100 + y });
}
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + (to.x - from.x) / 3, from.y + (to.y - from.y) / 3);
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}
async function undoSeed(page: Page, count: number) {
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => writes(page)).toBe(count);
  expect(await read(page)).toEqual(JSON.parse(SOURCE));
}
test('ports, lines and a new end card save one step each; deleting that card takes its connection', async ({
  page,
}, info) => {
  const point = await open(page);
  await page.keyboard.press('a');
  const from = point(154, 70),
    to = point(336, 70);
  await page.mouse.move(from.x, from.y);
  await expect(page.getByTestId('wb-port')).toHaveCount(4);
  await drag(page, from, to);
  await expect.poll(async () => (await read(page)).edges.length).toBe(2);
  let edge = (await read(page)).edges[1];
  expect(edge).toMatchObject({ fromNode: 'a', toNode: 'b', fromSide: 'right', toSide: 'left' });
  expect(edge).not.toHaveProperty('toEnd');
  expect(await writes(page)).toBe(1);
  await undoSeed(page, 2);
  await page.keyboard.press('l');
  await drag(page, point(80, 55), point(410, 55));
  await expect.poll(() => writes(page)).toBe(3);
  edge = (await read(page)).edges[1];
  expect(edge).toMatchObject({ fromNode: 'a', toNode: 'b', toEnd: 'none' });
  expect(edge).not.toHaveProperty('fromSide');
  expect(edge).not.toHaveProperty('toSide');
  await undoSeed(page, 4);
  await page.keyboard.press('a');
  await drag(page, point(154, 70), point(500, 300));
  await expect.poll(() => writes(page)).toBe(5);
  const connected = await read(page),
    card = connected.nodes[2];
  expect(card).toMatchObject({ type: 'text', text: '', x: 500, y: 300, width: 250, height: 60 });
  expect(connected.edges[1]).toMatchObject({ fromNode: 'a', toNode: card.id });
  await page.screenshot({
    path: info.outputPath('whiteboard-connections.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Delete');
  await expect.poll(() => writes(page)).toBe(6);
  expect(await read(page)).toEqual(JSON.parse(SOURCE));
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => read(page)).toEqual(connected);
  expect(await writes(page)).toBe(7);
  await undoSeed(page, 8);
});
test('a seeded side-less endpoint reconnects and its label edits without losing unknown keys', async ({
  page,
}) => {
  const point = await open(page),
    middle = point(245, 70);
  await page.mouse.click(middle.x, middle.y);
  await expect(page.getByTestId('wb-endpoint')).toHaveCount(2);
  await drag(page, point(350, 70), point(410, 6));
  await expect.poll(() => writes(page)).toBe(1);
  expect((await read(page)).edges[0]).toMatchObject({
    fromNode: 'a',
    toNode: 'b',
    toSide: 'top',
    vendor: 'kept',
  });
  await page.keyboard.press('Enter');
  await page.getByTestId('wb-text-editor').fill('Next step');
  await page.keyboard.press('Enter');
  await expect.poll(() => writes(page)).toBe(2);
  expect((await read(page)).edges[0].label).toBe('Next step');
  await page.keyboard.press('Enter');
  await page.getByTestId('wb-text-editor').fill('');
  await page.keyboard.press('Escape');
  await expect.poll(() => writes(page)).toBe(3);
  expect((await read(page)).edges[0]).not.toHaveProperty('label');
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => writes(page)).toBe(4 + i);
  }
  expect(await read(page)).toEqual(JSON.parse(SOURCE));
  await drag(page, point(350, 70), point(600, 300));
  await page.waitForTimeout(650);
  expect(await read(page)).toEqual(JSON.parse(SOURCE));
  expect(await writes(page)).toBe(6);
});
