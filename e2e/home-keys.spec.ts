import { expect, test } from '@playwright/test';
import { boot, openDestination } from './boot';

test('j enters Home, e marks a run done, and Undo returns the exact row', async ({
  page,
}, testInfo) => {
  await boot(page);
  await openDestination(page, 'Home');
  await expect(page.getByTestId('home-row').first()).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.press('j');
  await expect(page.getByTestId('home-row').first()).toBeFocused();
  const run = page.locator('[data-lane="runs"] [data-subject="process:release-scout"]');
  await expect(run).toBeVisible();
  await run.focus();
  await page.keyboard.press('e');
  await expect(run).toHaveCount(0);
  const toast = page.getByRole('status').filter({ hasText: 'Marked done' });
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(run).toBeVisible();
  await run.focus();
  await page.keyboard.press('x');
  await expect(page.getByTestId('list-selection')).toContainText('1 selected · e marks done');
  await page.screenshot({ path: testInfo.outputPath('home-selected-run.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('list-selection')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('doc-title')).toHaveText('Release scout');
});
