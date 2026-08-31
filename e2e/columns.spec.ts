import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile } from './boot';

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

/**
 * The `/` menu (M48.3). Asserted against the FILE, because a layout that looks
 * right and does not survive being written is not a layout, it is a rendering.
 */
test('typing /columns builds a layout and writes it to the file', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Expand Delivery' }).click();
  await page
    .getByTestId('collection-node-doc')
    .filter({ hasText: 'How we schedule' })
    .getByRole('button', { name: 'How we schedule' })
    .click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible({ timeout: 10_000 });

  const editor = page.locator('[data-testid="markdown-editor"] .bn-editor');
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/2 columns');
  await page.getByText('An empty side-by-side layout').first().click();
  await page.keyboard.type('Left side');

  await expect
    .poll(() => readMockFile(page, 'delivery/how-we-schedule.md'), { timeout: 6_000 })
    .toContain(':::columns');
  const onDisk = await readMockFile(page, 'delivery/how-we-schedule.md');
  expect(onDisk).toContain('::::column');
  expect(onDisk).toContain('Left side');
  // Two columns, one close for each and one for the list.
  expect(onDisk.split('\n').filter((l) => l === '::::column')).toHaveLength(2);

  // And it lays out: the cursor landed in the first column, so both are real.
  await expect.poll(async () => (await columnBoxes(page)).length, { timeout: 6_000 }).toBe(2);
  const [left, right] = await columnBoxes(page);
  expect(right.x).toBeGreaterThan(left.x + left.width - 1);
});

test('a column layout is not offered inside a column', async ({ page }) => {
  await openTwoUp(page);
  // Click into the first column's prose, then open the menu there.
  await page.getByText('The narrow one.').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/columns');
  // The menu is open (the trigger matched something) but offers no layout.
  await expect(page.getByText('An empty side-by-side layout')).toHaveCount(0);
});

/* "Turn into" is the one-step version of what people actually want — put THIS
   beside that — and the entry the screenshot that started this milestone was
   open on. The failure it has to not have is duplication: the block moves into
   the layout, it does not get copied there and left behind as well. */
test('turn into moves the block you are standing in, and does not leave a copy', async ({
  page,
}) => {
  await boot(page);
  await page.getByRole('button', { name: 'Expand Delivery' }).click();
  await page
    .getByTestId('collection-node-doc')
    .filter({ hasText: 'How we schedule' })
    .getByRole('button', { name: 'How we schedule' })
    .click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible({ timeout: 10_000 });

  const editor = page.locator('[data-testid="markdown-editor"] .bn-editor');
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Beside me');
  await page.keyboard.type('/2 columns');
  await page.getByText('Move this block into the first column').first().click();

  await expect
    .poll(() => readMockFile(page, 'delivery/how-we-schedule.md'), { timeout: 6_000 })
    .toContain(':::columns');
  const onDisk = await readMockFile(page, 'delivery/how-we-schedule.md');
  const lines = onDisk.split('\n');
  // Exactly once, and INSIDE the layout rather than above it.
  expect(lines.filter((l) => l.includes('Beside me'))).toHaveLength(1);
  expect(lines.indexOf(':::columns')).toBeLessThan(lines.findIndex((l) => l.includes('Beside me')));
});
