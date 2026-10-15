import { expect, test, type Page } from '@playwright/test';
import { openStateLab, VAULT_TODAY, type E2eLabPreset } from './boot';

/**
 * The state lab in a browser (M64.1): every preset the lab registers, through
 * the same `?section=&state=` link a person would open, under StrictMode and
 * the pinned clock. `src/lab/presets.test.tsx` replays the same presets in
 * jsdom; this is the half that proves the page itself.
 */

async function expectPreset(page: Page, preset: E2eLabPreset): Promise<void> {
  const stage = page.getByTestId('lab-stage');
  await expect(stage).toHaveAttribute('data-section', preset.section);
  await expect(stage).toHaveAttribute('data-state', preset.state);
  // Present and text first: they wait for the reads to land, so the absent
  // checks after them judge a settled section rather than a loading one.
  for (const selector of preset.expect.present) {
    await expect(stage.locator(selector).first()).toBeVisible();
  }
  if (preset.expect.text !== undefined) await expect(stage).toContainText(preset.expect.text);
  for (const selector of preset.expect.absent ?? []) {
    await expect(stage.locator(selector)).toHaveCount(0);
  }
}

test('every preset renders the state it names', async ({ page, context }) => {
  await openStateLab(page, 'agent-spend', 'ready');
  const presets = await page.evaluate(() => window.__cerebroLabPresets);
  expect(presets.length).toBeGreaterThanOrEqual(10);
  // Every preset opens its own document. Keep each assertion's deadline,
  // while the whole-loop budget grows with the registered corpus.
  test.setTimeout(Math.max(30_000, presets.length * 1_000));
  await page.close();
  for (const preset of presets) {
    await test.step(`${preset.section} · ${preset.state}`, async () => {
      // Each preset is an isolated page, just like the lab's unit replay.
      // Close its document and dev-server connection before the next one.
      const isolated = await context.newPage();
      try {
        await openStateLab(isolated, preset.section, preset.state);
        await expectPreset(isolated, preset);
      } finally {
        await isolated.close();
      }
    });
  }
});

test('mounts the real roster at a link, with the clock pinned to the vault day', async ({
  page,
}) => {
  await openStateLab(page, 'agent-spend', 'partial');
  await expect(page.getByTestId('lab-stage')).toContainText('12,940 tokens · 1 run unmetered');
  await expect(page.getByTestId('lab-clock')).toHaveText('Clock pinned to 28 Jul 2026, 12:00 UTC');
  expect(await page.evaluate(() => Date.now())).toBe(new Date(VAULT_TODAY).getTime());
});

test('a failed read recovers on the next remount', async ({ page }) => {
  await openStateLab(page, 'fleet-runs', 'ready');
  const stage = page.getByTestId('lab-stage');
  await expect(stage.getByTestId('fleet-row').first()).toBeVisible();

  await page.getByTestId('lab-fail-command').fill('fleet_runs');
  await page.getByTestId('lab-fail-next').click();
  await expect(page.getByTestId('lab-armed')).toHaveText('Armed: fleet_runs');
  await page.getByTestId('lab-remount').click();
  await expect(stage.getByTestId('section-unavailable')).toBeVisible();
  await expect(stage.getByTestId('fleet-row')).toHaveCount(0);
  await expect(page.getByTestId('lab-armed')).toHaveText('Nothing armed');

  await page.getByTestId('lab-remount').click();
  await expect(stage.getByTestId('fleet-row').first()).toBeVisible();
  await expect(stage.getByTestId('section-unavailable')).toHaveCount(0);
});

test('the URL keeps the preset across a reload', async ({ page }) => {
  await openStateLab(page, 'agent-spend', 'ready');
  await page.getByTestId('lab-state-fleet-runs-not-recorded').click();
  await expect(page).toHaveURL(/\?section=fleet-runs&state=not-recorded$/);
  await expect(page.getByTestId('lab-stage').getByTestId('usage-unknown')).toBeVisible();

  await page.reload();
  const stage = page.locator('[data-testid="lab-stage"][data-ready]');
  await expect(stage).toHaveAttribute('data-section', 'fleet-runs');
  await expect(stage).toHaveAttribute('data-state', 'not-recorded');
  await expect(stage.getByTestId('usage-unknown')).toBeVisible();
  await expect(stage).toContainText('why not recorded');
});
