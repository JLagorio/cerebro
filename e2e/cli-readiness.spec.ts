import { expect, test } from '@playwright/test';
import { boot } from './boot';

for (const theme of ['light', 'dark'] as const) {
  test(`retrying CLI discovery keeps the mounted composer (${theme})`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await boot(page);
    const rail = page.getByTestId('app-rail');
    await rail.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByTestId(`theme-${theme}`).click();
    await rail.getByRole('button', { name: 'Assistant', exact: true }).click();
    const panel = page.getByTestId('ai-panel');
    const composer = panel.getByLabel('Message the assistant');
    const node = await composer.elementHandle();
    await composer.fill('Keep my draft while I check the CLI');
    await panel.getByRole('button', { name: 'Minimize conversation' }).click();
    await rail.getByRole('button', { name: 'Settings', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Assistant', exact: true })
      .click();
    const settings = page.getByTestId('settings-claude-code');
    await expect(settings).toContainText('mock (browser)');
    await page.evaluate(() => window.__cerebroFailNext('check_cli_readiness'));
    await settings.getByRole('button', { name: 'Check again', exact: true }).click();
    await expect(page.getByTestId('settings-claude-code-status')).toHaveText(
      "Couldn't check for Claude Code on this machine.",
    );
    await page.getByTestId('ai-panel-fab').click();
    await expect(panel.getByRole('button', { name: 'Retry checking Claude Code' })).toBeVisible();
    await expect(composer).toHaveValue('Keep my draft while I check the CLI');
    await page.screenshot({ path: info.outputPath('cli-unavailable.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 900, height: 600 });
    const header = await panel.locator('header.cb-chat-header').boundingBox();
    for (const name of ['Retry checking Claude Code', 'Conversation options']) {
      const control = panel.getByRole('button', { name, exact: true });
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(header!.x);
      expect(box!.x + box!.width).toBeLessThanOrEqual(header!.x + header!.width);
    }
    await page.screenshot({
      path: info.outputPath('cli-unavailable-minimum.png'),
      animations: 'disabled',
    });
    await panel.getByRole('button', { name: 'Retry checking Claude Code' }).click();
    await expect(settings).toContainText('mock (browser)');
    await expect(panel.getByRole('button', { name: 'Retry checking Claude Code' })).toHaveCount(0);
    await expect(composer).toHaveValue('Keep my draft while I check the CLI');
    expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
    await page.screenshot({ path: info.outputPath('cli-rechecked.png'), animations: 'disabled' });
  });
}
