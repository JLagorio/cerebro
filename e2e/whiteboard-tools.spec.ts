import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile, openDestination } from './boot';
const PATH = 'boards/tools.canvas';
const SOURCE = JSON.stringify({ nodes: [], edges: [], vendor: { kept: true } });
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
            transform: { scale: 1, offset: { x: 0, y: 0 } },
          },
        ]),
      );
    },
    { path: PATH, source: SOURCE },
  );
  // Browser fixtures have no filesystem watcher; deliver its normal scan.
  await page.evaluate(async () => {
    const modulePath = '/src/stores/vaultStore.ts';
    const { useVaultStore } = await import(modulePath);
    await useVaultStore.getState().rescan();
  });
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Tools');
  await page
    .getByTestId('quick-open-result')
    .filter({ hasText: PATH })
    .or(page.getByTestId('quick-open-content-result').filter({ hasText: PATH }))
    .first()
    .click();
  await expect(page.getByTestId('wb-input')).toBeVisible();
  await page.getByTestId('wb-input').focus();
}
const read = async (page: Page) => JSON.parse((await readMockFile(page, PATH))!);
const writes = (page: Page) =>
  page.evaluate((path) => window.__cerebroMockWrites.filter((w) => w.path === path).length, PATH);
async function drag(page: Page, x: number, y: number, dx: number, dy: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 3, y + dy / 3);
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}
test('shape, verbatim markdown, pencil and eraser are four edits and four Undos restore the seed', async ({
  page,
}, info) => {
  await open(page);
  const box = (await page.getByTestId('wb-input').boundingBox())!;
  await page.keyboard.press('r');
  await expect(page.locator('[data-tool="rectangle"]')).toHaveAttribute('aria-pressed', 'true');
  await drag(page, box.x + 100.2, box.y + 120.4, 180.4, 100.3);
  await expect.poll(async () => (await read(page)).nodes.length).toBe(1);
  const shape = (await read(page)).nodes[0];
  expect([shape.x, shape.y, shape.width, shape.height].every(Number.isInteger)).toBe(true);
  expect(await writes(page)).toBe(1);
  await expect(page.locator('[data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('t');
  await drag(page, box.x + 400, box.y + 120, 250, 160);
  const text = '# Plan\n- first\n- second';
  await page.getByTestId('wb-text-editor').fill(text);
  expect(await writes(page)).toBe(1);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(async () => (await read(page)).nodes.length).toBe(2);
  expect((await read(page)).nodes[1].text).toBe(text);
  expect(await writes(page)).toBe(2);
  await page.keyboard.press('p');
  await drag(page, box.x + 110, box.y + 370, 130, 40);
  await expect.poll(async () => (await read(page)).cerebro?.ink?.length).toBe(1);
  expect(await writes(page)).toBe(3);
  await page.screenshot({
    path: info.outputPath('whiteboard-created.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('e');
  await drag(page, box.x + 150, box.y + 365, 0, 50);
  await expect.poll(async () => (await read(page)).cerebro?.ink?.length ?? 0).toBe(0);
  expect(await writes(page)).toBe(4);
  for (let undo = 0; undo < 4; undo++) {
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => writes(page)).toBe(5 + undo);
  }
  expect(await read(page)).toEqual(JSON.parse(SOURCE));
  await page.keyboard.press('g');
  await page.keyboard.press('h');
  await expect(page.locator('[data-testid="home-lane"][data-lane="mywork"]')).toBeVisible();
});
test('typing tool letters stays in the text editor, and leaving the board saves the current draft', async ({
  page,
}) => {
  await open(page);
  const box = (await page.getByTestId('wb-input').boundingBox())!;
  await page.keyboard.press('t');
  await page.mouse.click(box.x + 120, box.y + 140);
  await page.getByTestId('wb-text-editor').pressSequentially('v h t r o p e');
  await expect(page.getByTestId('wb-text-editor')).toHaveValue('v h t r o p e');
  expect(await writes(page)).toBe(0);
  await openDestination(page, 'Home');
  await expect.poll(async () => (await read(page)).nodes[0]?.text).toBe('v h t r o p e');
  expect(await writes(page)).toBe(1);
});
