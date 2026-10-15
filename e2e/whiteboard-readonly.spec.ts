import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile } from './boot';
const PATH = 'studio/maps/sketch.canvas';
const KNOWLEDGE = 'knowledge/maps/flow.canvas';
const SOURCE = JSON.stringify({
  vendor: { retained: true },
  nodes: [{ id: 'a', type: 'text', text: 'Read-only map', x: 20, y: 20, width: 240, height: 120 }],
});
const BODY = `# Maps\n\n\`\`\`cerebro-whiteboard\nboard: ${PATH}\nheight: 360\n\`\`\`\n`;
async function scan(page: Page) {
  // The browser mock has no filesystem watcher. Run its normal scan to deliver
  // the same entry/hash snapshot a desktop watcher would after an outside edit.
  await page.evaluate(async () => {
    const modulePath = '/src/stores/vaultStore.ts';
    const { useVaultStore } = await import(modulePath);
    await useVaultStore.getState().rescan();
  });
}
test('Studio previews a board fence and a canvas file; Open reaches its page without writing', async ({
  page,
}, info) => {
  await boot(page);
  await page.evaluate(
    ({ path, source, body }) => {
      window.__cerebroMockFs.set(path, source);
      window.__cerebroMockFs.set('studio/maps/index.md', body);
    },
    { path: PATH, source: SOURCE, body: BODY },
  );
  await scan(page);
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Studio' }).click();
  await page.getByTestId('studio-project').filter({ hasText: 'Maps' }).click();
  const embed = page.getByTestId('whiteboard-embed');
  await expect(embed).toHaveAttribute('data-state', 'ready');
  await expect(embed).toContainText('Read-only map');
  await expect(page.getByTestId('wb-input')).toHaveCount(0);
  await page.getByTestId('studio-page-row').filter({ hasText: 'Sketch' }).click();
  await expect(embed).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('wb-board')).toHaveCSS('height', '520px');
  await page.screenshot({ path: info.outputPath('studio-whiteboard.png'), animations: 'disabled' });
  await embed.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByTestId('canvas-title')).toHaveText('Sketch');
  await expect(page.getByTestId('wb-input')).toBeVisible();
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Home' }).click();
  expect(await readMockFile(page, PATH)).toBe(SOURCE);
  expect(await readMockFile(page, 'studio/maps/index.md')).toBe(BODY);
  expect(
    await page.evaluate((path) => window.__cerebroMockWrites.filter((w) => w.path === path), PATH),
  ).toEqual([]);
});
test('a knowledge board offers no editing input and a real drag leaves its bytes untouched', async ({
  page,
}, info) => {
  await boot(page);
  await page.evaluate(({ path, source }) => window.__cerebroMockFs.set(path, source), {
    path: KNOWLEDGE,
    source: SOURCE,
  });
  await scan(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Flow');
  await page
    .getByTestId('quick-open-result')
    .filter({ hasText: KNOWLEDGE })
    .or(page.getByTestId('quick-open-content-result').filter({ hasText: KNOWLEDGE }))
    .first()
    .click();
  await expect(page.getByTestId('canvas-read-only')).toHaveText(
    'Knowledge boards are read-only here.',
  );
  await expect(page.getByTestId('wb-input')).toHaveCount(0);
  const card = page.locator('[data-testid="wb-node"][data-node-id="a"]');
  await expect(card).toBeVisible();
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 50, box.y + 40);
  await page.mouse.move(box.x + 90, box.y + 80, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press('Delete');
  await page.waitForTimeout(650);
  expect(await readMockFile(page, KNOWLEDGE)).toBe(SOURCE);
  expect(
    await page.evaluate(
      (path) => window.__cerebroMockWrites.filter((w) => w.path === path),
      KNOWLEDGE,
    ),
  ).toEqual([]);
  await expect(page.getByTestId('wb-handle')).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath('knowledge-whiteboard.png'),
    animations: 'disabled',
  });
});
test('a missing embed retains its pointer and a changed file refreshes the read-only preview', async ({
  page,
}) => {
  await boot(page);
  await page.evaluate((body) => window.__cerebroMockFs.set('studio/maps/index.md', body), BODY);
  await scan(page);
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Studio' }).click();
  await page.getByTestId('studio-project').filter({ hasText: 'Maps' }).click();
  await expect(page.getByTestId('whiteboard-embed')).toHaveAttribute('data-state', 'missing');
  await expect(page.getByTestId('whiteboard-embed')).toContainText(`No whiteboard at ${PATH}`);
  await page.evaluate(({ path, source }) => window.__cerebroMockFs.set(path, source), {
    path: PATH,
    source: SOURCE,
  });
  await scan(page);
  await expect(page.getByTestId('whiteboard-embed')).toHaveAttribute('data-state', 'ready');
  await page.evaluate((path) => window.__cerebroMockFs.set(path, '{broken'), PATH);
  await scan(page);
  await expect(page.getByTestId('whiteboard-embed')).toHaveAttribute('data-state', 'unavailable');
  await expect(page.getByTestId('whiteboard-embed')).toContainText(
    "This whiteboard isn't valid JSON.",
  );
  await expect(page.getByTestId('whiteboard-embed')).toContainText(PATH);
  expect(await readMockFile(page, PATH)).toBe('{broken');
  expect(
    await page.evaluate((path) => window.__cerebroMockWrites.filter((w) => w.path === path), PATH),
  ).toEqual([]);
});
