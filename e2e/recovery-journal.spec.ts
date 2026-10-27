import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import {
  boot,
  chooseSettingsSection,
  openStateLab,
  readMockFile,
  seedFileBeforeBoot,
  showPagePanel,
} from './boot';

const PATH = 'notes/recovery-page.md';
const BEFORE = '\ufeff---\r\ntype: Doc\r\n---\r\n# Recovery page\r\n\r\nOriginal body.\r\n';
const AFTER = BEFORE.replace('Original body.', 'Changed body.');

async function settings(page: Page) {
  await page.getByTestId('app-rail').getByRole('button', { name: 'Settings', exact: true }).click();
  await chooseSettingsSection(page, 'Vault');
  return page.getByRole('region', { name: 'Recovery copies', exact: true });
}
async function openPage(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Recovery page');
  await page.getByTestId('quick-open-result').filter({ hasText: 'Recovery page' }).first().click();
  // Typed records open in the existing peek; History belongs to the full page.
  await page.getByRole('button', { name: 'Open in full page', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Source', exact: true })).toBeEnabled();
}

for (const theme of ['light', 'dark'] as const) {
  test(`opt-in recovery preview, export and restore preserve exact bytes (${theme})`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1100, height: 760 });
    await seedFileBeforeBoot(page, PATH, BEFORE);
    await boot(page);
    await page
      .getByTestId('app-rail')
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
    await page.getByTestId(`theme-${theme}`).click();
    const controls = await settings(page);
    const enabled = controls.getByRole('checkbox', { name: 'Keep recovery copies for this vault' });
    await expect(enabled).not.toBeChecked();
    await enabled.focus();
    await page.keyboard.press('Space');
    await expect(enabled).toBeChecked();
    await expect(controls).toContainText('Across all vaults: 0 copies');
    await page.screenshot({
      path: info.outputPath('recovery-settings.png'),
      animations: 'disabled',
    });

    await openPage(page);
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    const source = page.getByRole('textbox', { name: 'Page source' });
    const panel = await showPagePanel(page, 'History');
    const copies = panel.getByRole('region', { name: 'Recovery copies', exact: true });
    await expect(copies).toContainText('No retained recovery copies for this page.');
    await source.fill('# Recovery page\n\nChanged body.\n');
    await expect.poll(() => readMockFile(page, PATH)).toBe(AFTER);
    await expect(copies.getByRole('article')).toHaveCount(1);
    await copies.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(copies.getByLabel('Recovery copy text')).toContainText('Original body.');
    await expect(copies).toContainText('outside, unattributed');
    await page.screenshot({
      path: info.outputPath('recovery-preview.png'),
      animations: 'disabled',
    });
    const downloading = page.waitForEvent('download');
    await copies.getByRole('button', { name: 'Export copy', exact: true }).click();
    const download = await downloading;
    const downloadedPath = await download.path();
    expect(downloadedPath).not.toBeNull();
    expect(await readFile(downloadedPath!)).toEqual(Buffer.from(BEFORE));
    expect(await readMockFile(page, PATH)).toBe(AFTER);

    await copies.getByRole('button', { name: 'Restore copy', exact: true }).click();
    await copies.getByRole('button', { name: 'Confirm restore copy', exact: true }).click();
    await expect.poll(() => readMockFile(page, PATH)).toBe(BEFORE);
    await expect(source).toHaveValue('# Recovery page\n\nOriginal body.\n');
    await expect(copies.getByRole('status')).toContainText('Restored recovery copy.');
    await expect(copies.getByRole('article')).toHaveCount(2);
    await page.screenshot({
      path: info.outputPath('recovery-restored.png'),
      animations: 'disabled',
    });

    const finalControls = await settings(page);
    await finalControls
      .getByRole('checkbox', { name: 'Keep recovery copies for this vault' })
      .uncheck();
    await expect(finalControls).toContainText('Across all vaults: 2 copies');
    await finalControls.getByRole('button', { name: 'Clear recovery copies', exact: true }).click();
    await finalControls
      .getByRole('button', { name: 'Delete copies for this vault', exact: true })
      .click();
    await expect(finalControls).toContainText('Across all vaults: 0 copies');
    expect(await readMockFile(page, PATH)).toBe(BEFORE);
  });
}

for (const section of ['recovery-settings', 'recovery-versions'] as const) {
  test(`${section} renders all five read states in the state lab`, async ({ page }, info) => {
    for (const state of ['ready', 'empty', 'not-recorded', 'partial', 'unavailable']) {
      await test.step(state, async () => {
        await openStateLab(page, section, state);
        const stage = page.getByTestId('lab-stage');
        const preset = await page.evaluate(
          ({ section, state }) =>
            window.__cerebroLabPresets.find(
              (item) => item.section === section && item.state === state,
            ),
          { section, state },
        );
        expect(preset).toBeDefined();
        for (const selector of preset!.expect.present)
          await expect(stage.locator(selector).first()).toBeVisible();
        if (preset!.expect.text) await expect(stage).toContainText(preset!.expect.text!);
        for (const selector of preset!.expect.absent ?? [])
          await expect(stage.locator(selector)).toHaveCount(0);
        if (section === 'recovery-settings' && state !== 'unavailable') {
          const enabled = stage.getByRole('checkbox', {
            name: 'Keep recovery copies for this vault',
          });
          if (state === 'not-recorded') await expect(enabled).not.toBeChecked();
          else await expect(enabled).toBeChecked();
        }
        if (state === 'unavailable') {
          await expect(stage).not.toContainText('No retained recovery copies');
          await expect(stage).not.toContainText('Across all vaults: 0 copies');
          await page.screenshot({
            path: info.outputPath(`${section}-${state}.png`),
            animations: 'disabled',
          });
        }
      });
    }
  });
}
