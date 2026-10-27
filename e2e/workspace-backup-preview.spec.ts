import { expect, test } from '@playwright/test';
import { boot, chooseSettingsSection, openDestination } from './boot';

test('Settings backup preview stays truthful across navigation in both themes with keyboard focus', async ({
  page,
  browserName,
}, info) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await boot(page);
  await openDestination(page, 'Settings');
  await chooseSettingsSection(page, 'Vault');
  const backup = page.getByRole('region', { name: 'Backups', exact: true });
  await expect(backup).toBeVisible();
  await expect(backup).toContainText('no files were written');
  const originalFiles = await page.evaluate(() =>
    Array.from(window.__cerebroMockFs.entries()).sort(([a], [b]) => a.localeCompare(b)),
  );
  const originalWrites = await page.evaluate(() => window.__cerebroMockWrites.length);
  const allControlsTab = browserName === 'webkit' && process.platform === 'darwin';
  for (const theme of ['light', 'dark'] as const) {
    if (theme === 'dark')
      await page
        .getByTestId('app-rail')
        .getByRole('button', { name: 'Theme: light', exact: true })
        .click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const create = backup.getByRole('button', { name: 'Create backup…', exact: true });
    const check = backup.getByRole('button', { name: 'Check a backup…', exact: true });
    await expect(create).toBeEnabled();
    await create.scrollIntoViewIfNeeded();
    await create.focus();
    await create.press(allControlsTab ? 'Alt+Tab' : 'Tab');
    await expect(check).toBeFocused();
    await check.press(allControlsTab ? 'Alt+Shift+Tab' : 'Shift+Tab');
    await expect(create).toBeFocused();
    expect(await create.evaluate((node) => node.matches(':focus-visible'))).toBe(true);
    await expect(create).not.toHaveCSS('box-shadow', 'none');
    await page.evaluate(() => document.fonts.ready);
    await info.attach('backup-focus-' + theme, {
      contentType: 'application/json',
      body: JSON.stringify(
        await create.evaluate((node) => ({
          theme: document.documentElement.dataset.theme,
          color: getComputedStyle(node).color,
          background: getComputedStyle(node).backgroundColor,
          border: getComputedStyle(node).borderColor,
          focus: getComputedStyle(node).boxShadow,
        })),
      ),
    });
    await backup.screenshot({
      path: info.outputPath('backup-preview-focus-' + theme + '.png'),
      animations: 'disabled',
    });
    await create.press('Enter');
    await expect(backup).toContainText('no files were written');
    await expect(backup.getByLabel('Review backup operation')).toHaveCount(0);
    await expect(backup.getByLabel('Backup result')).toHaveCount(0);
    await expect(backup.getByRole('status', { name: 'Backup in progress' })).toHaveCount(0);
    await check.click();
    await expect(backup).toContainText('no files were written');
    await backup.getByRole('button', { name: 'Restore a separate copy…', exact: true }).click();
    await expect(backup).toContainText('no files were written');
    await expect(
      backup.getByRole('button', { name: 'Restore separate copy', exact: true }),
    ).toHaveCount(0);
    await openDestination(page, 'Home');
    await openDestination(page, 'Settings');
    await chooseSettingsSection(page, 'Vault');
    await expect(backup).toContainText('no files were written');
    await expect(backup.getByLabel('Backup result')).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        Array.from(window.__cerebroMockFs.entries()).sort(([a], [b]) => a.localeCompare(b)),
      ),
    ).toEqual(originalFiles);
    expect(await page.evaluate(() => window.__cerebroMockWrites.length)).toBe(originalWrites);
  }
});
