import { expect, test } from '@playwright/test';
import { boot, readMockFile } from './boot';

/**
 * Studio (M40): a prototype is a folder of pages under studio/, built with
 * the standing Assistant panel and previewed rendered. The demo vault ships
 * no prototypes — an empty bench is the intended first-run state, so the
 * spec builds one and watches the folder shape land on disk.
 */
test('studio: create a prototype, preview it live, hand the build to the assistant', async ({
  page,
}) => {
  await boot(page);

  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Studio' }).click();
  await expect(page.getByTestId('studio-page')).toBeVisible();
  await expect(page.getByText('Nothing on the bench')).toBeVisible();

  // -- New prototype = folder + index page on disk -----------------------
  await page.getByTestId('studio-new').click();
  await page.getByLabel('Prototype name').fill('Pricing page');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  expect(await readMockFile(page, 'studio/pricing-page/index.md')).toContain('# Pricing page');

  // Landed inside it, previewing the rendered index.
  await expect(page.getByTestId('studio-preview')).toBeVisible();
  await expect(
    page.getByTestId('studio-page-row').filter({ hasText: 'Pricing page' }),
  ).toBeVisible();

  // -- The preview is LIVE: an out-of-band write re-renders it ------------
  // The same seam an agent's write goes through — the mock fs plus a rescan.
  await page.evaluate(() => {
    window.__cerebroMockFs.set(
      'studio/pricing-page/index.md',
      '# Pricing page\n\nThree tiers, annual default.\n',
    );
  });
  // The distiller is off in specs, so nudge the scanner the way the watcher
  // would: open the page fresh via Back/forward through the nav.
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Home' }).click();
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Studio' }).click();
  await page.getByTestId('studio-project').filter({ hasText: 'Pricing page' }).click();
  await expect(page.getByTestId('studio-preview')).toContainText('Three tiers, annual default.');

  // -- Build with the assistant: the panel opens, aimed at the folder -----
  await page.getByTestId('studio-build').click();
  await expect(page.getByTestId('ai-panel')).toBeVisible();
});
