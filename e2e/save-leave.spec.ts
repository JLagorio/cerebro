import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile, seedFileBeforeBoot } from './boot';

const path = 'save-barrier.md';
const initial = '# Save barrier specimen\n\nOriginal paragraph.\n';

async function openSpecimen(page: Page) {
  await seedFileBeforeBoot(page, path, initial);
  await boot(page);
  await page.getByTestId('app-rail').getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByTestId('quick-open-input').fill('Save barrier specimen');
  await page
    .getByTestId('quick-open-result')
    .filter({ hasText: 'Save barrier specimen' })
    .first()
    .click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible();
  await page.locator('.bn-editor').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
}

test('navigation saves a pending body while its editor is still mounted', async ({ page }) => {
  await openSpecimen(page);
  await page.keyboard.insertText('The newest visible words');
  await page.getByTestId('app-rail').getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page).toHaveTitle('Home — Cerebro');
  expect(await readMockFile(page, path)).toContain('The newest visible words');
});

test('an already failed save blocks navigation and Retry saves without another edit', async ({
  page,
}) => {
  await openSpecimen(page);
  // Remove only this browser fixture's file. The real save door refuses a
  // missing target; no production writer or injected success is involved.
  await page.evaluate((path) => window.__cerebroMockFs.delete(path), path);
  await page.keyboard.insertText('Keep these exact words after refusal');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible();
  await page.getByTestId('app-rail').getByRole('button', { name: 'Home', exact: true }).click();
  await expect(
    page.getByText('Changes could not be saved. Retry save or resolve them before leaving.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByTestId('markdown-editor')).toContainText(
    'Keep these exact words after refusal',
  );
  expect(await page.evaluate((path) => window.__cerebroMockFs.has(path), path)).toBe(false);
  // Explicitly restore the fixture, then retry the retained generation.
  await page.evaluate(({ path, initial }) => window.__cerebroMockFs.set(path, initial), {
    path,
    initial,
  });
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect
    .poll(() => readMockFile(page, path))
    .toContain('Keep these exact words after refusal');
  await page.getByTestId('app-rail').getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page).toHaveTitle('Home — Cerebro');
});
