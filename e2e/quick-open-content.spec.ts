import { test, expect, type Page } from '@playwright/test';
import { boot } from './boot';

/**
 * M59.4 — ⌘K finds page text: names at once, then "In pages" once typing
 * pauses.
 *
 * The browser runs the mock's search_vault, which matches by containment in
 * path order, never by BM25 (search.rs ranks only in the packaged app), so
 * these counts follow containment.
 */

const input = (page: Page) => page.getByTestId('quick-open-input');
const contentRows = (page: Page) => page.getByTestId('quick-open-content-result');

async function openPalette(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(input(page)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openPalette(page);
});

test('a body-only word lists its pages under In pages, the word marked', async ({ page }) => {
  await input(page).fill('draining');
  const group = page.locator('[data-section="pages"]');
  await expect(group).toContainText('In pages');
  await expect(contentRows(page).first()).toBeVisible();
  expect(await contentRows(page).count()).toBeGreaterThan(0);
  await expect(contentRows(page).first().locator('mark')).toHaveText(/draining/i);
  // The names keep their own rows: nothing is named "draining".
  await expect(page.getByTestId('quick-open-result')).toHaveCount(0);
});

test('a two-character query asks for no page text', async ({ page }) => {
  await input(page).fill('dr');
  await expect(page.getByTestId('quick-open-ask')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(contentRows(page)).toHaveCount(0);
  await expect(page.locator('[data-section="pages"]')).toHaveCount(0);
});

test('a failed page-text search says so, never "No matches"', async ({ page }) => {
  await page.evaluate(() => window.__cerebroFailSearchVault('disk gone'));
  await input(page).fill('draining');
  await expect(page.getByTestId('section-unavailable')).toHaveText(
    "Page text couldn't be searched. Names above are complete.",
  );
  await expect(page.getByText(/No matches/)).toHaveCount(0);
  await expect(contentRows(page)).toHaveCount(0);
});

test('"All N matches" expands In pages in place', async ({ page }) => {
  await input(page).fill('rollback');
  const all = page.getByTestId('quick-open-all-matches');
  await expect(all).toBeVisible();
  await expect(contentRows(page)).toHaveCount(5);
  const n = Number((await all.textContent())?.match(/All (\d+) matches/)?.[1]);
  expect(n).toBeGreaterThan(5);
  await all.click();
  await expect(contentRows(page)).toHaveCount(Math.min(n, 50));
  await expect(all).toHaveCount(0);
  await expect(input(page)).toBeVisible();
});

test('rows that arrive late never move the highlight', async ({ page }) => {
  await input(page).fill('rollback');
  const palette = page.getByRole('dialog', { name: 'Quick open', exact: true });
  const options = palette.getByRole('option');
  await expect(page.getByTestId('quick-open-result').nth(1)).toBeVisible();
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  const second = page.getByTestId('quick-open-result').nth(1);
  await expect(second).toHaveAttribute('aria-selected', 'true');
  await expect(contentRows(page).first()).toBeVisible();
  await expect(second).toHaveAttribute('aria-selected', 'true');
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
});

test('Enter on a page row opens that page', async ({ page }) => {
  await input(page).fill('draining');
  const first = contentRows(page).first();
  await expect(first).toBeVisible();
  const title = (await first.locator('span.text-ui').textContent()) ?? '';
  expect(title).not.toBe('');
  // Ask stays unselected; the first arriving match takes the untouched highlight.
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(input(page)).toBeHidden();
  await expect(page.getByTestId('doc-title')).toHaveText(title, { timeout: 10_000 });
});
