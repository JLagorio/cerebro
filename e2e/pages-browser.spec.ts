import { expect, test } from '@playwright/test';
import { boot, openStateLab, readMockFile, seedFileBeforeBoot } from './boot';

test('Pages browses real records, keeps personal shelves and restores its visit on Back', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await boot(page);
  await page.getByTestId('app-rail').getByRole('button', { name: 'Pages', exact: true }).click();
  const browser = page.getByTestId('pages-browser');
  await expect(browser).toBeVisible();
  await expect(page).toHaveTitle('Pages — Cerebro');
  const searchBox = (await browser.getByLabel('Search pages').boundingBox())!;
  const newBox = (await browser.getByRole('button', { name: 'New', exact: true }).boundingBox())!;
  expect(
    Math.abs(searchBox.y + searchBox.height / 2 - newBox.y - newBox.height / 2),
  ).toBeLessThanOrEqual(2);
  const first = browser.getByTestId('page-browser-item').first();
  const rowBox = (await first.boundingBox())!;
  expect(rowBox.height).toBe(48);
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

test('Pages keeps a long title and its controls usable in a narrow pane and at 200% zoom', async ({
  page,
}, info) => {
  const title =
    'Review the full release plan and the decisions that remain open across the workspace';
  const path = 'm94-pages-wrap.md';
  const bytes = `# ${title}\n\nThe original page is unchanged by browsing.\n`;
  await seedFileBeforeBoot(page, path, bytes);
  await page.setViewportSize({ width: 1024, height: 768 });
  await boot(page);
  await page.getByTestId('app-rail').getByRole('button', { name: 'Pages', exact: true }).click();
  const browser = page.getByTestId('pages-browser');
  await browser.getByLabel('Search pages').fill(title);
  await page.keyboard.press('Escape');
  await browser.evaluate((node) => {
    (node as HTMLElement).style.width = '360px';
  });
  expect((await browser.boundingBox())!.width).toBe(360);
  const row = browser.getByTestId('page-browser-item');
  await expect(row).toHaveCount(1);
  const titleNode = row.locator('.cb-pages-title');
  expect(
    await titleNode.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return node.contains(
        document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
      );
    }),
  ).toBe(true);
  expect((await titleNode.boundingBox())!.height).toBeGreaterThan(20);
  expect(await titleNode.evaluate((node) => node.scrollHeight <= node.clientHeight)).toBe(true);
  expect(await browser.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(
    await browser
      .locator('.cb-pages-browser-scroll')
      .evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  const primary = browser.getByRole('button', { name: 'New', exact: true });
  await primary.focus();
  await expect(primary).toBeFocused();
  await page.screenshot({
    path: info.outputPath('pages-narrow-title.png'),
    animations: 'disabled',
  });
  await browser.evaluate((node) => {
    (node as HTMLElement).style.removeProperty('width');
  });
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2';
  });
  await primary.focus();
  await expect(primary).toBeFocused();
  const box = (await primary.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1024);
  expect(box.y + box.height).toBeLessThanOrEqual(768);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await readMockFile(page, path)).toBe(bytes);
  await page.screenshot({ path: info.outputPath('pages-zoom-200.png'), animations: 'disabled' });
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
