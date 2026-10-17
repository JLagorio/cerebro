import { expect, test, type Page } from '@playwright/test';
import { boot, openDestination } from './boot';
async function palette(page: Page) {
  await page.keyboard.press('Meta+k');
  const input = page.getByRole('combobox', { name: 'Quick open' });
  await expect(input).toBeFocused();
  return input;
}
test('Tab cycles categories and the theme chooser previews, cancels, then commits', async ({
  page,
}) => {
  await boot(page);
  const input = await palette(page);
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('palette-category-pages')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Shift+Tab');
  await input.fill('theme');
  await expect(
    page
      .getByTestId('quick-open-command')
      .filter({ hasText: 'Switch light and dark' })
      .locator('[data-keys]'),
  ).toHaveAttribute('data-keys', 'mod+shift+l');
  await page.getByRole('option', { name: /Change theme/ }).click();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('cerebro.themeMode'))).toBe('light');
  await page.screenshot({ path: '/private/tmp/cerebro-palette-theme-preview.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(input).toHaveValue('theme');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Quick open' })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('cerebro.themeMode'))).toBe('dark');
});
test('Open favorite opens its page, and an unmatched query waits for an explicit Ask', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'cerebro.favorites',
      JSON.stringify({ '/demo-vault': ['delivery/how-we-schedule.md'] }),
    ),
  );
  await boot(page);
  await (await palette(page)).fill('favorite');
  await page.getByRole('option', { name: /Open favorite/ }).click();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('doc-title')).toContainText('How we schedule');
  await (await palette(page)).fill('zzqxv');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Quick open' })).toBeVisible();
  await expect(page.getByTestId('ai-panel')).toHaveCount(0);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ai-panel')).toBeVisible();
  await expect(page.getByTestId('ai-panel')).toContainText('zzqxv');
});
test('the command snapshot offers filing on Inbox and not on Home', async ({ page }) => {
  await boot(page);
  await openDestination(page, 'Inbox');
  await page.getByTestId('inbox-row').first().click();
  await (await palette(page)).fill('file');
  await expect(
    page
      .getByTestId('quick-open-command')
      .filter({ hasText: 'File the open capture' })
      .locator('[data-keys]'),
  ).toHaveAttribute('data-keys', 'mod+e');
  await page.keyboard.press('Escape');
  await openDestination(page, 'Home');
  await (await palette(page)).fill('file');
  await expect(page.getByRole('option', { name: /File the open capture/ })).toHaveCount(0);
});
