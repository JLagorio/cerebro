import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile } from './boot';
const PATH = 'boards/inspector.canvas';
const SOURCE = JSON.stringify({
  nodes: [
    { id: 'a', type: 'text', text: 'Alpha', x: 20, y: 40, width: 100, height: 80 },
    { id: 'b', type: 'text', text: 'Beta', x: 220, y: 150, width: 120, height: 80 },
    { id: 'c', type: 'text', text: 'Gamma', x: 480, y: 300, width: 80, height: 80 },
  ],
  edges: [
    { id: 'e', fromNode: 'a', toNode: 'b' },
    { id: 'f', fromNode: 'b', toNode: 'c' },
  ],
  vendor: { kept: true },
});
const read = async (page: Page) => JSON.parse((await readMockFile(page, PATH))!);
const writes = (page: Page) =>
  page.evaluate((path) => window.__cerebroMockWrites.filter((w) => w.path === path).length, PATH);
async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
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
  await page.getByTestId('quick-open-input').fill('Inspector');
  await page
    .getByTestId('quick-open-result')
    .filter({ hasText: PATH })
    .or(page.getByTestId('quick-open-content-result').filter({ hasText: PATH }))
    .first()
    .click();
  await expect(page.getByTestId('wb-inspector')).toBeVisible();
  await page.getByTestId('wb-input').focus();
  const box = (await page.getByTestId('wb-input').boundingBox())!;
  return (x: number, y: number) => ({ x: box.x + 100 + x, y: box.y + 100 + y });
}
async function undo(page: Page, count: number) {
  await page.getByTestId('wb-input').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => writes(page)).toBe(count);
}
test('preset and hex colours, align and distribute each save once and Undo restores the prior scene', async ({
  page,
}, info) => {
  await open(page);
  await page.keyboard.press('ControlOrMeta+a');
  const inspector = page.getByTestId('wb-inspector');
  await expect(inspector.getByRole('textbox', { name: 'X', exact: true })).toHaveAttribute(
    'placeholder',
    'Mixed',
  );
  await inspector.getByRole('button', { name: 'Green', exact: true }).click();
  await expect.poll(() => writes(page)).toBe(1);
  expect((await read(page)).nodes.map((n: { color: string }) => n.color)).toEqual(['4', '4', '4']);
  await inspector.getByRole('textbox', { name: 'Hex colour' }).fill('#AbC');
  await page.keyboard.press('Enter');
  await expect.poll(() => writes(page)).toBe(2);
  expect((await read(page)).nodes[0].color).toBe('#aabbcc');
  expect(await readMockFile(page, PATH)).not.toContain('var(');
  await undo(page, 3);
  expect((await read(page)).nodes[0].color).toBe('4');
  await undo(page, 4);
  expect(await read(page)).toEqual(JSON.parse(SOURCE));
  await inspector.getByRole('button', { name: 'Align left', exact: true }).click();
  await expect.poll(() => writes(page)).toBe(5);
  expect((await read(page)).nodes.map((n: { x: number }) => n.x)).toEqual([20, 20, 20]);
  await undo(page, 6);
  await inspector.getByRole('button', { name: 'Distribute horizontal', exact: true }).click();
  await expect.poll(() => writes(page)).toBe(7);
  expect((await read(page)).nodes.map((n: { x: number }) => n.x)).toEqual([20, 240, 480]);
  await page.screenshot({
    path: info.outputPath('whiteboard-inspector.png'),
    animations: 'disabled',
  });
  await undo(page, 8);
  expect(await read(page)).toEqual(JSON.parse(SOURCE));
});
async function copyEvent(page: Page) {
  return page.getByTestId('wb-input').evaluate((el) => {
    const data = new DataTransfer();
    el.dispatchEvent(
      new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }),
    );
    return Object.fromEntries(data.types.map((type) => [type, data.getData(type)]));
  });
}
async function clipboardEvent(
  page: Page,
  kind: 'paste' | 'cut',
  content: Record<string, string> = {},
) {
  await page.getByTestId('wb-input').evaluate(
    (el, { kind, content }) => {
      const data = new DataTransfer();
      for (const [key, value] of Object.entries(content)) data.setData(key, value);
      el.dispatchEvent(
        new ClipboardEvent(kind, { bubbles: true, cancelable: true, clipboardData: data }),
      );
    },
    { kind, content },
  );
}
test('clipboard keeps only copied connections, cut, Duplicate and Alt-drag are each one undo step', async ({
  page,
}) => {
  const point = await open(page),
    a = point(60, 70),
    b = point(260, 180);
  await page.mouse.click(a.x, a.y);
  await page.keyboard.down('Shift');
  await page.mouse.click(b.x, b.y);
  await page.keyboard.up('Shift');
  const data = await copyEvent(page);
  expect(data['text/plain']).toBe('Alpha\n\nBeta');
  await clipboardEvent(page, 'paste', data);
  await expect.poll(() => writes(page)).toBe(1);
  const pasted = await read(page),
    copies = pasted.nodes.slice(3);
  expect(copies.map((n: { x: number }) => n.x)).toEqual([44, 244]);
  expect(pasted.edges).toHaveLength(3);
  expect(pasted.edges[2]).toMatchObject({ fromNode: copies[0].id, toNode: copies[1].id });
  await clipboardEvent(page, 'cut');
  await expect.poll(() => writes(page)).toBe(2);
  expect(await read(page)).toEqual(JSON.parse(SOURCE));
  await undo(page, 3);
  expect(await read(page)).toEqual(pasted);
  await undo(page, 4);
  expect(await read(page)).toEqual(JSON.parse(SOURCE));
  await page.mouse.click(a.x, a.y);
  await page.keyboard.press('ControlOrMeta+d');
  await expect.poll(() => writes(page)).toBe(5);
  expect((await read(page)).nodes[3]).toMatchObject({ text: 'Alpha', x: 44, y: 64 });
  await undo(page, 6);
  await page.keyboard.down('Alt');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 20, a.y + 10);
  await page.mouse.move(a.x + 80, a.y + 40, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect.poll(() => writes(page)).toBe(7);
  expect((await read(page)).nodes[3]).toMatchObject({ text: 'Alpha', x: 100, y: 80 });
  await undo(page, 8);
  expect(await read(page)).toEqual(JSON.parse(SOURCE));
});
