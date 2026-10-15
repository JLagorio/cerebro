import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile } from './boot';

const BOARD = 'boards/plan.canvas';
const GOLDEN = readFileSync('shared/canvas/goldens/obsidian-layout.canvas', 'utf8');
async function seed(page: Page, path: string, content: string) {
  await page.evaluate(({ path, content }) => window.__cerebroMockFs.set(path, content), {
    path,
    content,
  });
}
async function openSearch(page: Page, query: string, title: string) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill(query);
  const row = page
    .getByTestId('quick-open-result')
    .filter({ hasText: title })
    .or(page.getByTestId('quick-open-content-result').filter({ hasText: title }))
    .first();
  await expect(row).toBeVisible();
  await row.click();
}

test('Quick Open opens a board as a page without changing any bytes or recording a write', async ({
  page,
}, info) => {
  await boot(page);
  await seed(page, BOARD, GOLDEN);
  await openSearch(page, 'Plan', 'Plan');
  await expect(page.getByTestId('canvas-title')).toHaveText('Plan');
  await expect(page.getByTestId('canvas-summary')).toHaveText('4 cards · 1 connection');
  await expect(page.getByTestId('canvas-board')).toBeVisible();
  await page.waitForTimeout(1500);
  expect(await readMockFile(page, BOARD)).toBe(GOLDEN);
  expect(
    await page.evaluate(
      (path) => window.__cerebroMockWrites.filter((row) => row.path === path),
      BOARD,
    ),
  ).toEqual([]);
  await page.screenshot({ path: info.outputPath('canvas-page.png'), animations: 'disabled' });
  await page.keyboard.press('ControlOrMeta+[');
  await expect(page.getByTestId('canvas-page')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Roadmap');
  await expect(
    page.getByTestId('quick-open-content-result').filter({ hasText: 'Plan' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await openSearch(page, 'Pipeline', 'Pipeline');
  await expect(page.getByTestId('diagram-page')).toBeVisible();
});

test('invalid JSON and a future version stay unavailable and unchanged', async ({ page }, info) => {
  await boot(page);
  await seed(page, 'boards/broken.canvas', '{broken');
  await seed(page, 'boards/future.canvas', '{"cerebro":{"version":2}}');
  await openSearch(page, 'Broken', 'Broken');
  const unavailable = page.getByTestId('canvas-unavailable');
  await expect(unavailable).toContainText("This whiteboard can't be opened");
  await expect(unavailable).toContainText("isn't valid JSON");
  await expect(page.getByTestId('canvas-empty')).toHaveCount(0);
  await unavailable.getByText('The file as it is').click();
  await expect(unavailable.locator('pre')).toHaveText('{broken');
  await page.screenshot({
    path: info.outputPath('canvas-unavailable.png'),
    animations: 'disabled',
  });
  await openSearch(page, 'Future', 'Future');
  await expect(unavailable).toContainText('version (2)');
  await page.waitForTimeout(1500);
  expect(await readMockFile(page, 'boards/broken.canvas')).toBe('{broken');
  expect(await readMockFile(page, 'boards/future.canvas')).toBe('{"cerebro":{"version":2}}');
});

test('an empty board is measured and empty rather than unavailable', async ({ page }) => {
  await boot(page);
  await seed(page, 'boards/empty.canvas', '{}');
  await openSearch(page, 'Empty', 'Empty');
  await expect(page.getByTestId('canvas-empty')).toHaveText('This whiteboard is empty.');
  await expect(page.getByTestId('canvas-summary')).toHaveText('0 cards · 0 connections');
  await expect(page.getByTestId('canvas-unavailable')).toHaveCount(0);
  expect(await readMockFile(page, 'boards/empty.canvas')).toBe('{}');
});
