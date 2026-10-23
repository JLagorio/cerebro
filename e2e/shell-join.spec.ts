import { expect, test, type Page } from '@playwright/test';
import { boot, openDatabase } from './boot';

async function expectFlush(page: Page) {
  const viewport = page.viewportSize()!;
  const main = page.getByTestId('main-column');
  const bounds = (await main.boundingBox())!;
  expect(bounds.x + bounds.width).toBe(viewport.width);
  expect(bounds.y + bounds.height).toBe(viewport.height);
  const shape = await main.evaluate((node) => {
    const style = getComputedStyle(node);
    return [
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius,
      style.borderRightWidth,
      style.borderBottomWidth,
      style.marginRight,
      style.marginBottom,
    ];
  });
  expect(shape).toEqual(['0px', '0px', '0px', '0px', '0px', '0px', '0px']);
  const sidebar = page.getByTestId('sidebar');
  if ((await sidebar.isVisible()) && (await sidebar.getAttribute('data-overlay')) !== 'true') {
    const side = (await sidebar.boundingBox())!;
    expect(side.x + side.width).toBe(bounds.x);
    expect(side.y).toBe(bounds.y);
    expect(side.y + side.height).toBe(viewport.height);
    expect(await sidebar.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
      await page.locator('.m71-shell').evaluate((node) => getComputedStyle(node).backgroundColor),
    );
  }
  const status = (await page.getByTestId('status-bar').boundingBox())!;
  expect(status.x + status.width).toBe(viewport.width);
  expect(status.y + status.height).toBe(viewport.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
}

for (const theme of ['light', 'dark'] as const) {
  test(`the sidebar joins a flush canvas with a peek and floating chat in ${theme}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1728, height: 1098 });
    await page.addInitScript((value) => localStorage.setItem('cerebro.themeMode', value), theme);
    await boot(page, { preserveTheme: true });
    await openDatabase(page, 'Work item');
    const row = page
      .getByTestId('table-row')
      .filter({ hasText: 'Rewrite messaging for the console split' });
    await row.hover();
    await row.getByRole('button', { name: /^Open / }).click();
    const peek = page.getByTestId('detail-panel');
    await expect(peek.locator('[data-page-title] h1')).toHaveText(
      'Rewrite messaging for the console split',
    );
    await expect(peek.getByText('Every asset currently describes', { exact: false })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(8, 8);
    await expectFlush(page);
    await page.screenshot({ path: info.outputPath(`joined-peek-${theme}.png`) });
    await page.getByTestId('sidebar-collapse').click();
    await expect(page.getByTestId('sidebar')).toBeHidden();
    await expectFlush(page);
    await page.getByTestId('sidebar-expand').click();
    await expect(page.getByTestId('sidebar')).toBeVisible();
    for (const width of [1440, 1048, 1047, 900, 760, 700]) {
      await page.setViewportSize({ width, height: 800 });
      await expectFlush(page);
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await page
      .getByTestId('detail-panel')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await page.keyboard.press('ControlOrMeta+j');
    const chat = page.getByTestId('ai-panel');
    await expect(chat).toHaveAttribute('data-presentation', 'floating');
    await expectFlush(page);
    const chatBounds = (await chat.boundingBox())!;
    const canvas = (await page.locator('.m91-canvas-row').boundingBox())!;
    expect(chatBounds.x + chatBounds.width).toBe(canvas.x + canvas.width - 20);
    expect(chatBounds.y + chatBounds.height).toBe(canvas.y + canvas.height - 20);
    await page.screenshot({ path: info.outputPath(`joined-floating-${theme}.png`) });
  });
}
