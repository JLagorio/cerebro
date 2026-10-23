import { expect, test } from '@playwright/test';
import { openStateLab } from './boot';

for (const theme of ['light', 'dark'] as const) {
  test(`operational surfaces keep five honest states readable in ${theme}`, async ({
    page,
  }, info) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1200, height: 900 });
    await openStateLab(page, 'agent-spend', 'ready');
    const presets = await page.evaluate(() => window.__cerebroLabPresets);
    const selected = presets.filter((preset) =>
      ['agent-spend', 'fleet-runs', 'history-feed', 'home-mywork'].includes(preset.section),
    );
    expect(selected).toHaveLength(20);
    for (const preset of selected) {
      await test.step(`${preset.section}: ${preset.state}`, async () => {
        await openStateLab(page, preset.section, preset.state);
        await page
          .locator('html')
          .evaluate((node, mode) => node.setAttribute('data-theme', mode), theme);
        const stage = page.getByTestId('lab-stage');
        await expect(stage).toHaveAttribute('data-ready', '');
        for (const selector of preset.expect.present) {
          await expect(stage.locator(selector).first()).toBeVisible();
        }
        if (preset.expect.text) await expect(stage).toContainText(preset.expect.text);
        for (const selector of preset.expect.absent ?? []) {
          await expect(stage.locator(selector)).toHaveCount(0);
        }
        for (const message of await stage.getByTestId('section-unavailable').all()) {
          const size = await message.evaluate((node) =>
            parseFloat(getComputedStyle(node).fontSize),
          );
          expect(size).toBeGreaterThanOrEqual(12);
        }
        if (preset.section === 'fleet-runs' && ['ready', 'partial'].includes(preset.state)) {
          await expect(stage.getByTestId('fleet-actor').first()).toHaveCSS('font-size', '14px');
          await expect(stage.getByTestId('fleet-outcome').first()).toHaveCSS('font-size', '12px');
        }
        expect(
          await stage.evaluate((node) => node.scrollWidth - node.clientWidth),
        ).toBeLessThanOrEqual(1);
        if (
          process.platform === 'darwin' &&
          theme === 'light' &&
          preset.section === 'agent-spend' &&
          preset.state === 'partial'
        ) {
          await expect(stage).toHaveScreenshot('agent-partial-light.png', {
            animations: 'disabled',
            maxDiffPixels: 100,
          });
        }
        if (['ready', 'partial', 'unavailable'].includes(preset.state)) {
          await stage.screenshot({
            path: info.outputPath(`${preset.section}-${preset.state}-${theme}.png`),
          });
        }
      });
    }
  });
}
