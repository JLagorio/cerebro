import { expect, test, type Page } from '@playwright/test';
import { boot } from './boot';

/**
 * Columns, proven where they can be proven (M48.2).
 *
 * jsdom has no layout engine and does not build the same DOM: a custom React
 * block gets an extra `.react-renderer` wrapper in a browser and none under
 * test. A first version of the CSS matched perfectly in unit tests and matched
 * NOTHING in the app — every column stacked, no error anywhere. So the claim
 * "these sit side by side, in the ratio the file asked for" belongs here, in
 * geometry, and nowhere else.
 */

const TWO_UP = [
  '# Two up',
  '',
  'A sentence above.',
  '',
  ':::columns',
  '::::column',
  '## Left',
  '',
  'The narrow one.',
  '::::',
  '::::column width=2',
  '## Right',
  '',
  'The wide one, twice the ratio.',
  '::::',
  ':::',
  '',
  'A sentence below.',
  '',
].join('\n');

/** Where each column actually is on screen, in document order. */
const columnBoxes = (page: Page) =>
  page.evaluate(() => {
    const host = document.querySelector('[data-testid="markdown-editor"]');
    if (host === null) return [];
    return [...host.querySelectorAll('[data-content-type="column"]')].map((column) => {
      const outer = column.closest('[data-node-type="blockOuter"]');
      const box = outer?.getBoundingClientRect();
      return { x: Math.round(box?.x ?? -1), width: Math.round(box?.width ?? -1) };
    });
  });

async function openTwoUp(page: Page): Promise<void> {
  await boot(page);
  // Written onto a page that already exists: the mock disk reseeds on reload,
  // so a file put there has to be read without one.
  await page.evaluate((md) => {
    window.__cerebroMockFs.set('delivery/how-we-schedule.md', md);
  }, TWO_UP);
  await page.getByRole('button', { name: 'Expand Delivery' }).click();
  await page
    .getByTestId('collection-node-doc')
    .filter({ hasText: 'How we schedule' })
    .getByRole('button', { name: 'How we schedule' })
    .click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => (await columnBoxes(page)).length, { timeout: 10_000 }).toBe(2);
}

test('a :::columns page lays its columns out side by side', async ({ page }) => {
  await openTwoUp(page);
  const [left, right] = await columnBoxes(page);

  // Side by side, not stacked: the second starts where the first ends.
  expect(right.x).toBeGreaterThan(left.x + left.width - 1);
  // Both on one line.
  expect(left.width).toBeGreaterThan(0);
  expect(right.width).toBeGreaterThan(0);
});

test('a declared width is a RATIO, so width=2 is twice its neighbour', async ({ page }) => {
  await openTwoUp(page);
  const [left, right] = await columnBoxes(page);
  // Within a pixel of 2:1 — the gutter is taken out of the flex basis, not
  // out of one column, so the ratio is exact rather than approximate.
  expect(right.width / left.width).toBeGreaterThan(1.9);
  expect(right.width / left.width).toBeLessThan(2.1);
});

test('the page still reads as markdown, and saving it changes nothing', async ({ page }) => {
  await openTwoUp(page);
  // Give the debounced save a chance to fire, then confirm the round trip is
  // a no-op. A layout whose serializer is not byte-stable rewrites the file
  // every time somebody opens it.
  await page.waitForTimeout(1200);
  const onDisk = await page.evaluate(() =>
    window.__cerebroMockFs.get('delivery/how-we-schedule.md'),
  );
  expect(onDisk).toBe(TWO_UP);
});
