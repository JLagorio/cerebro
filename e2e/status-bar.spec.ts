import { expect, test } from '@playwright/test';
import { boot } from './boot';

for (const theme of ['light', 'dark'] as const) {
  test(`workspace footer stays quiet with accessible details in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 760, height: 600 });
    await page.addInitScript((value) => localStorage.setItem('cerebro.themeMode', value), theme);
    await boot(page, { preserveTheme: true });
    const footer = page.getByTestId('status-bar');
    const opener = footer.getByTestId('status-vault');
    await expect(opener).toBeVisible();
    const writesBefore = await page.evaluate(() => window.__cerebroMockWrites.length);
    await expect(footer).not.toContainText('No remote');
    await expect(footer).not.toContainText('main');
    await expect(page.getByTitle('Cerebro version')).toHaveCount(0);
    const box = (await footer.boundingBox())!;
    expect(box.height).toBe(28);
    expect(Math.abs(box.y + box.height - 600)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.x + box.width - 760)).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: testInfo.outputPath(`footer-${theme}.png`),
      animations: 'disabled',
    });

    await opener.focus();
    await page.keyboard.press('Enter');
    const details = page.getByRole('dialog', { name: 'Workspace status', exact: true });
    await expect(details).toBeVisible();
    await expect(details.getByTitle('Cerebro version')).toBeVisible();
    await expect(details.getByTestId('status-remote')).toHaveText('No remote');
    await expect(details.getByTestId('status-branch')).toHaveText('Not recorded');
    await expect(details.getByRole('button', { name: 'Workspace settings' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(details.getByRole('button', { name: 'View changes' })).toBeFocused();
    const detailsBox = (await details.boundingBox())!;
    expect(detailsBox.x).toBeGreaterThanOrEqual(0);
    expect(detailsBox.x + detailsBox.width).toBeLessThanOrEqual(760);
    expect(detailsBox.y).toBeGreaterThanOrEqual(0);
    expect(detailsBox.y + detailsBox.height).toBeLessThanOrEqual(600);
    await expect(details).toHaveCSS('opacity', '1');
    await page.screenshot({
      path: testInfo.outputPath(`workspace-details-${theme}.png`),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await expect(details).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(await page.evaluate(() => window.__cerebroMockWrites.length)).toBe(writesBefore);

    await page.keyboard.press('Enter');
    await details.getByRole('button', { name: 'Workspace settings' }).click();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await expect(details).toHaveCount(0);
    expect(await page.evaluate(() => window.__cerebroMockWrites.length)).toBe(writesBefore);
  });

  test(`workspace footer keeps conflicts and sync refusal visible in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 760, height: 600 });
    await page.addInitScript((value) => localStorage.setItem('cerebro.themeMode', value), theme);
    await boot(page, { preserveTheme: true });
    await expect(page.getByTestId('status-vault')).toBeVisible();
    await page.evaluate(() => {
      const state = window.__cerebroMockGit!;
      state.remoteUrl = 'https://example.test/workspace.git';
      state.ahead = 2;
      state.behind = 1;
      state.conflicts = ['delivery/how-we-schedule.md'];
      state.nextRemoteFailure = {
        status: 'network_error',
        message: 'The remote could not be reached. Try again.',
        updatedFiles: [],
        conflictFiles: [],
      };
      // Refresh the mounted shared reader through its real visibility event;
      // importing a second dev-server store URL would not update this footer.
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const footer = page.getByTestId('status-bar');
    await expect(footer.getByTestId('status-changes')).toHaveText('1 conflicted');
    await expect(footer.getByTestId('status-changes')).toHaveAttribute('data-tone', 'danger');
    await expect(footer.getByTestId('status-sync')).toHaveText('Sync ↑2 ↓1');
    await footer.getByTestId('status-sync').click();
    await expect(footer.getByTestId('status-sync')).toHaveText('Sync failed');
    await expect(footer.getByTestId('status-sync')).toHaveAttribute('data-tone', 'danger');
    await expect(footer).not.toContainText('Synced');
    // A refused pull must not subsequently push and clear the outgoing count.
    expect(await page.evaluate(() => window.__cerebroMockGit!.ahead)).toBe(2);
    await footer.getByTestId('status-vault').click();
    const details = page.getByRole('dialog', { name: 'Workspace status', exact: true });
    await expect(details.getByRole('alert')).toHaveText(
      'The remote could not be reached. Try again.',
    );
    expect((await footer.boundingBox())!.height).toBe(28);
    await expect(details).toHaveCSS('opacity', '1');
    await page.screenshot({
      path: testInfo.outputPath(`sync-failed-${theme}.png`),
      animations: 'disabled',
    });
  });
}
