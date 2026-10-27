import { expect, test } from '@playwright/test';
import { boot, openAgents, openStateLab } from './boot';

for (const theme of ['light', 'dark'] as const) {
  test(`run configuration remains historical and recovers a failed read (${theme})`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: theme === 'light' ? 1440 : 900, height: 900 });
    await page.addInitScript((value) => localStorage.setItem('cerebro.themeMode', value), theme);
    await boot(page, { preserveTheme: true });
    await openAgents(page);
    const scrim = page.getByTestId('sidebar-drawer-scrim');
    if (await scrim.isVisible()) {
      await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
      await expect(scrim).toBeHidden();
    }
    await page.getByTestId('agent-row').filter({ hasText: 'Release scout' }).click();
    await page.getByRole('tab', { name: 'Runs', exact: true }).click();
    await page.getByTestId('agent-run').first().click();
    const detail = page.getByTestId('run-detail');
    const toggle = detail.getByRole('button', { name: 'Run configuration', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const originalToggle = await toggle.elementHandle();
    expect(originalToggle).not.toBeNull();
    await toggle.focus();
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(detail).toContainText('Configuration was not recorded for this run.');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await page.evaluate(() =>
      (window as unknown as { __cerebroFailNext: (command: string) => void }).__cerebroFailNext(
        'fleet_run_configuration',
      ),
    );
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const section = detail.getByTestId('run-configuration');
    await expect(section.getByTestId('section-unavailable')).toContainText(
      'Configuration unavailable.',
    );
    await expect(section).not.toContainText('Configuration was not recorded');
    await section.getByRole('button', { name: 'Retry configuration' }).click();
    await expect(section).toContainText('Configuration was not recorded for this run.');
    await expect(page.getByTestId('markdown-editor').first()).toBeVisible({ timeout: 20_000 });
    expect(await originalToggle!.evaluate((element) => element.isConnected)).toBe(true);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`run-configuration-history-${theme}.png`),
      animations: 'disabled',
    });
  });
  test(`run configuration bounds its identities in the state lab (${theme})`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: theme === 'light' ? 1440 : 900, height: 900 });
    await page.addInitScript((value) => localStorage.setItem('cerebro.themeMode', value), theme);
    await openStateLab(page, 'run-configuration', 'ready');
    if (theme === 'dark') await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const section = page.getByTestId('run-configuration');
    await expect(section).toContainText('2.1.250');
    await expect(section).toContainText('label not recorded');
    await expect(section).toContainText('not observed before dispatch');
    expect(
      await section.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`run-configuration-recorded-${theme}.png`),
      animations: 'disabled',
    });
    const toggle = section.getByRole('button', { name: 'Run configuration', exact: true });
    const contentId = await toggle.getAttribute('aria-controls');
    const content = page.locator(`[id="${contentId}"]`);
    expect(
      await content.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    await toggle.focus();
    await page.keyboard.press('Tab');
    await expect(content).toBeFocused();
    await page.keyboard.press('End');
    await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  });
}
