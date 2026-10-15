import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile } from './boot';

/**
 * Find and replace in a page (M59.6), proven where jsdom cannot: the marks
 * laid out in a column, a table and a closed toggle, the toggle opening as
 * its hit is reached, the bar riding the page, and Replace all saved and
 * undone in one step through the real keyboard.
 */

const FILE = 'delivery/how-we-schedule.md';

// Eight hits for `sync`: two in a paragraph, a heading, one across bold, a
// column, a closed toggle's child, a table cell and a link chip, whose label
// is the concept's title, "Sync error rate".
const SEEDED = [
  '# How we schedule',
  '',
  'We sync daily, and a sync runs at noon.',
  '',
  '## Sync windows',
  '',
  'A **sy**nc split by bold.',
  '',
  ':::columns',
  '::::column',
  'Left side sync.',
  '::::',
  '::::column',
  'Right side.',
  '::::',
  ':::',
  '',
  ':::toggle Open questions',
  'Does the sync stop at night?',
  ':::',
  '',
  '| Job | When |',
  '| --- | --- |',
  '| sync | Hourly |',
  '',
  'See [[sync-error-rate]].',
  '',
].join('\n');

const syncs = (text: string) => (text.match(/sync/gi) ?? []).length;

/** Distinct hit marks on the page: a hit across bold is two spans, one mark. */
const markCount = (page: Page) =>
  page.evaluate(
    () =>
      new Set(
        [...document.querySelectorAll('[data-testid="markdown-editor"] [data-find]')].map((el) =>
          el.getAttribute('data-find'),
        ),
      ).size,
  );

async function openSeeded(page: Page): Promise<void> {
  await boot(page);
  // Written onto a page that already exists: the mock disk reseeds on reload,
  // so a file put there has to be read without one.
  await page.evaluate(
    ([path, md]) => {
      window.__cerebroMockFs.set(path, md);
    },
    [FILE, SEEDED] as const,
  );
  await page.getByRole('button', { name: 'Expand Delivery' }).click();
  await page
    .getByTestId('collection-node-doc')
    .filter({ hasText: 'How we schedule' })
    .getByRole('button', { name: 'How we schedule' })
    .click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Left side sync.')).toBeVisible({ timeout: 10_000 });
}

test('⌘F finds every hit, reaches into a closed toggle, and Replace all is one undo', async ({
  page,
}) => {
  await openSeeded(page);
  // The cursor before the first hit, so the count starts at it.
  await page.getByText('We sync daily').click({ position: { x: 2, y: 4 } });

  await page.keyboard.press('ControlOrMeta+f');
  const input = page.getByTestId('find-input');
  await expect(input).toBeFocused();
  await input.fill('SYNC');
  await expect(page.getByTestId('find-count')).toHaveText('1 of 8');
  await expect.poll(() => markCount(page)).toBe(8);

  // Step to the toggle's child, the sixth hit: the toggle, closed until now,
  // opens to show it.
  const toggleHit = page.locator('[data-testid="markdown-editor"] [data-find="6"]');
  await expect(toggleHit).toBeHidden();
  for (let i = 0; i < 5; i++) await input.press('Enter');
  await expect(page.getByTestId('find-count')).toHaveText('6 of 8');
  await expect(toggleHit).toBeVisible();
  await expect(toggleHit).toHaveText('sync');
  await expect(page.getByTestId('find-bar')).toBeInViewport();

  await page.getByTestId('find-toggle-replace').click();
  await page.getByTestId('find-replace-input').fill('link');
  await page.getByTestId('find-replace-all').click();
  await expect(page.getByTestId('find-status')).toHaveText('Replaced 7 · 1 in a link left as is');
  await expect(page.getByTestId('find-count')).toHaveText('1 of 1 · in a link');
  await expect
    .poll(async () => syncs((await readMockFile(page, FILE)).replace('[[sync-error-rate]]', '')))
    .toBe(0);
  expect(await readMockFile(page, FILE)).toContain('[[sync-error-rate]]');

  // One undo, through the page's own keyboard, brings every hit back.
  await page.getByText('Right side.').click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => syncs(await readMockFile(page, FILE))).toBe(syncs(SEEDED));

  // Escape in the bar closes the bar alone: the marks go, the page stays.
  await input.click();
  await input.press('Escape');
  await expect(page.getByTestId('find-bar')).toHaveCount(0);
  await expect.poll(() => markCount(page)).toBe(0);
  await expect(page.getByTestId('doc-page')).toBeVisible();
});
