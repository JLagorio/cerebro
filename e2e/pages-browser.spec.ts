import { expect, test } from '@playwright/test';
import { boot, openStateLab, readMockFile } from './boot';

test('Pages browses real records, keeps personal shelves and restores its visit on Back', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await boot(page);
  await page.getByTestId('app-rail').getByRole('button', { name: 'Pages', exact: true }).click();
  const browser = page.getByTestId('pages-browser');
  await expect(browser).toBeVisible();
  await expect(page).toHaveTitle('Pages — Cerebro');
  const first = browser.getByTestId('page-browser-item').first();
  const rowBox = (await first.boundingBox())!;
  expect(rowBox.height).toBeGreaterThanOrEqual(56);
  expect(rowBox.height).toBeLessThanOrEqual(60);
  await page.screenshot({ path: testInfo.outputPath('pages-list.png') });
  const before = await readMockFile(page, 'delivery/how-we-schedule.md');
  await browser.getByLabel('Search pages').fill('How we schedule');
  await expect(browser.getByTestId('page-browser-item')).toHaveCount(1);
  await browser.getByRole('button', { name: 'Add How we schedule to favorites' }).click();
  await browser.getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect(
    browser.getByRole('button', { name: 'Open How we schedule', exact: true }),
  ).toBeVisible();
  await browser.getByRole('button', { name: 'Grid view' }).click();
  await browser.getByRole('button', { name: 'Open How we schedule', exact: true }).click();
  await expect(page.getByTestId('doc-page').locator('[data-page-title] h1')).toHaveText(
    'How we schedule',
  );
  await page.keyboard.press('ControlOrMeta+[');
  await expect(browser.getByLabel('Search pages')).toHaveValue('How we schedule');
  await expect(browser.getByRole('button', { name: 'Grid view' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(browser.getByRole('button', { name: 'Favorites', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await browser.getByRole('button', { name: 'Recently opened' }).click();
  await expect(
    browser.getByRole('button', { name: 'Open How we schedule', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('pages-grid.png') });
  expect(await readMockFile(page, 'delivery/how-we-schedule.md')).toBe(before);
  await browser.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Page', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('pages-new-menu.png') });
  await page.keyboard.press('Escape');
  await expect(browser.getByRole('button', { name: 'New', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(browser.getByRole('button', { name: 'All pages', exact: true })).toBeFocused();
  await browser.getByRole('button', { name: 'All pages', exact: true }).click();
  await browser.getByLabel('Search pages').fill('Phoenix warehouse rollout');
  await browser
    .getByRole('button', { name: 'Open Phoenix warehouse rollout', exact: true })
    .click();
  await expect(page.getByTestId('doc-page')).toBeVisible();
  await expect(page.getByTestId('detail-panel')).toHaveCount(0);
});

test('Pages opens beside through the existing modified-click intent', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await boot(page);
  await page.getByTestId('app-rail').getByRole('button', { name: 'Pages', exact: true }).click();
  const browser = page.getByTestId('pages-browser');
  await browser.getByLabel('Search pages').fill('How we schedule');
  await browser
    .getByRole('button', { name: 'Open How we schedule', exact: true })
    .click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByTestId('pane')).toHaveCount(2);
  await expect(browser).toBeVisible();
  await expect(page.getByTestId('doc-page')).toBeVisible();
  await page.getByTestId('pane-close').last().click();
  const row = browser.getByRole('button', { name: 'Open How we schedule', exact: true });
  await row.focus();
  await row.press('Shift+Enter');
  await expect(page.getByTestId('pane')).toHaveCount(2);
  await expect(browser).toBeVisible();
});

for (const [width, height, theme] of [
  [760, 600, 'light'],
  [1024, 720, 'dark'],
] as const) {
  test(`Pages stays within the canvas at ${width} in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript((theme) => localStorage.setItem('cerebro.themeMode', theme), theme);
    await boot(page, { preserveTheme: true });
    await page.getByTestId('app-rail').getByRole('button', { name: 'Pages', exact: true }).click();
    await page.keyboard.press('Escape');
    const browser = page.getByTestId('pages-browser');
    await expect(browser).toBeVisible();
    for (const locator of [
      browser,
      browser.getByLabel('Search pages'),
      browser.getByRole('button', { name: 'New', exact: true }),
      browser.getByTestId('page-browser-item').first(),
    ]) {
      const bounds = (await locator.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    }
    expect(await browser.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`pages-${theme}-${width}.png`) });
  });
}

test('Pages renders all five read states without confusing a failed read with an empty vault', async ({
  page,
}) => {
  for (const state of ['ready', 'empty', 'not-recorded', 'partial', 'unavailable'] as const) {
    await openStateLab(page, 'pages-browser', state);
    const stage = page.getByTestId('lab-stage');
    const preset = await page.evaluate(
      (state) =>
        window.__cerebroLabPresets.find(
          (preset) => preset.section === 'pages-browser' && preset.state === state,
        )!,
      state,
    );
    for (const selector of preset.expect.present)
      await expect(stage.locator(selector).first()).toBeVisible();
    if (preset.expect.text) await expect(stage).toContainText(preset.expect.text);
    for (const selector of preset.expect.absent ?? [])
      await expect(stage.locator(selector)).toHaveCount(0);
  }
});
