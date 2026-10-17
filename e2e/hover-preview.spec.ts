import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile, showDatabases } from './boot';

/**
 * Hover previews (M59.7). A page link in a record's body, opened in the peek,
 * previews its page after a real pointer move: the title and the scan's
 * snippet, a concept's review state, a record's status, and the dangling copy
 * for a link that names nothing. Escape closes only the card.
 */

const LINKS = [
  'Map: [[systems-map]]',
  'Metric: [[sync-error-rate]]',
  'Decision: [[dec-offline-window-72h]]',
  'Gone: [[no-such-page]]',
].join('\n\n');

/** Move the pointer off every link and wait for any card to go. */
async function rest(page: Page) {
  await page.mouse.move(4, 4);
  await expect(page.getByTestId('hover-card')).toHaveCount(0);
}

test('a page link previews its page on hover, and Escape closes only the card', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);

  // -- Seed the first Work item's body with four links, then peek it --------
  await showDatabases(page);
  await page.getByTestId('sidebar-type').filter({ hasText: 'Work item' }).first().click();
  const row = page.getByTestId('table-row').first();
  const path = await row.getAttribute('data-path');
  if (path === null) throw new Error('the row has no data-path');
  const text = await readMockFile(page, path);
  await page.evaluate(([p, t]) => window.__cerebroMockFs.set(p, t), [path, `${text}\n${LINKS}\n`]);
  await row.hover();
  await row.getByRole('button', { name: /^Open / }).click();
  const panel = page.getByTestId('detail-panel');
  await expect(panel).toBeVisible();

  const chip = (label: RegExp | string) =>
    panel.locator('[data-chip="wikilink"]').filter({ hasText: label });
  const card = page.getByTestId('hover-card');
  await expect(chip('Systems map')).toBeVisible({ timeout: 10_000 });

  // -- A page: its title and the scan's snippet ------------------------------
  await chip('Systems map').hover();
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('page-preview-title')).toHaveText('Systems map');
  await expect(card.getByTestId('page-preview-snippet')).toContainText('How the demo product');
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(panel).toBeVisible();
  await rest(page);

  // -- A concept: its review state -------------------------------------------
  await chip(/Sync error rate/i).hover();
  await expect(card.getByTestId('review-chip')).toHaveAttribute('data-review', 'unreviewed');
  await rest(page);

  // -- A record: its status, in the only card open ---------------------------
  await chip(/Offline window/).hover();
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('page-preview-status')).toContainText(/accepted/i);
  await rest(page);

  // -- A link to nothing -----------------------------------------------------
  await chip('no-such-page').hover();
  await expect(card.getByTestId('page-preview-missing')).toHaveText('No page named "no-such-page"');
});
