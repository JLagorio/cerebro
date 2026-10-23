import { expect, test, type Page } from '@playwright/test';
import { boot, showPageFolders } from './boot';

const rail = (page: Page) => page.getByTestId('app-rail');
const area = (page: Page, name: string) => rail(page).getByRole('button', { name, exact: true });

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
}

test('the rail opens contextual shelves while retaining every workspace destination', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await boot(page);
  expect((await rail(page).boundingBox())!.width).toBe(54);
  expect((await page.getByTestId('sidebar').boundingBox())!.width).toBe(240);
  const surfaces = page.getByTestId('nav-surfaces');
  for (const name of ['Inbox', 'Home', 'My work', 'Studio', 'History', 'Library']) {
    await expect(
      surfaces.getByRole('button', { name: new RegExp(`^${name}( \\(|$)`) }),
    ).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath('home.png') });
  await showPageFolders(page);
  await expect(page.getByTestId('file-tree')).toBeVisible();
  await expect(surfaces).toBeHidden();
  await area(page, 'Databases').click();
  await expect(page.getByTestId('sidebar-type').first()).toBeVisible();
  await page.getByTestId('sidebar-type').filter({ hasText: 'Work item' }).click();
  await expect(page.getByTestId('table-view')).toBeVisible();
  await area(page, 'Knowledge').click();
  await expect(page.getByTestId('knowledge-tab-all')).toBeVisible();
  await area(page, 'Agents').click();
  await expect(
    page.getByTestId('sidebar').getByRole('button', { name: 'Open all agents' }),
  ).toBeVisible();
  await area(page, 'Work').click();
  await expect(
    page.getByTestId('sidebar').getByRole('complementary', { name: 'File explorer' }),
  ).toBeVisible();
  await area(page, 'Home').click();
  await expect(surfaces.getByRole('button', { name: 'History', exact: true })).toBeVisible();
  await area(page, 'Settings').click();
  await expect(rail(page).locator('[aria-current="page"], [aria-pressed="true"]')).toHaveCount(1);
  await expect(area(page, 'Settings')).toHaveAttribute('aria-current', 'page');
  await expect(area(page, 'Home')).toHaveAttribute('aria-pressed', 'false');
  await noOverflow(page);
});

test('collapse and narrow drawers keep the rail, readable canvas, and stored sidebar width', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  await page.getByTestId('sidebar-collapse').click();
  await expect(page.getByTestId('sidebar')).toBeHidden();
  await expect(area(page, 'Assistant')).toBeVisible();
  expect((await rail(page).boundingBox())!.width).toBe(54);
  await page.getByTestId('sidebar-expand').click();
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await page.setViewportSize({ width: 1048, height: 760 });
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await expect(page.getByTestId('sidebar-expand')).toBeHidden();
  expect((await page.getByTestId('sidebar').boundingBox())!.width).toBe(240);
  await page.setViewportSize({ width: 1047, height: 760 });
  await expect(page.getByTestId('sidebar')).toBeHidden();
  await expect(page.getByTestId('sidebar-expand')).toBeVisible();
  await page.setViewportSize({ width: 900, height: 760 });
  await expect(page.getByTestId('sidebar')).toBeHidden();
  await area(page, 'Pages').click();
  await expect(page.getByTestId('sidebar')).toHaveAttribute('data-overlay', 'true');
  expect((await page.getByTestId('sidebar').boundingBox())!.x).toBe(54);
  await page.screenshot({ path: info.outputPath('narrow-drawer.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('sidebar')).toBeHidden();
  await noOverflow(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId('sidebar')).toBeVisible();
  expect((await page.getByTestId('sidebar').boundingBox())!.width).toBe(240);
  await area(page, 'Theme: light').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByTestId('sidebar')).toHaveCSS('background-color', 'rgb(30, 34, 43)');
  await page.screenshot({ path: info.outputPath('dark.png') });
  await noOverflow(page);
});

for (const theme of ['light', 'dark'] as const) {
  test(`the quiet shell keeps its controls and operational status usable in ${theme}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await boot(page);
    if (theme === 'dark') await area(page, 'Theme: light').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const sidebar = page.getByTestId('sidebar');
    const ground = theme === 'light' ? 'rgb(246, 247, 250)' : 'rgb(30, 34, 43)';
    await expect(rail(page)).toHaveCSS('background-color', ground);
    await expect(sidebar).toHaveCSS('background-color', ground);
    const home = page
      .getByTestId('nav-surfaces')
      .getByRole('button', { name: 'Home', exact: true });
    await expect(home).toHaveAttribute('aria-current', 'page');
    expect((await home.boundingBox())!.height).toBeGreaterThanOrEqual(34);
    expect(await home.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe(ground);
    for (const name of ['Search', 'New', 'Assistant', `Theme: ${theme}`, 'Settings']) {
      const button = area(page, name);
      await expect(button).toBeVisible();
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(32);
      expect(box.height).toBeGreaterThanOrEqual(32);
      expect(Math.abs(box.x + box.width / 2 - 27)).toBeLessThan(1);
      expect(box.y + box.height).toBeLessThanOrEqual(900);
    }
    // A pending status still has its complete operational menu in the quiet footer.
    await page.evaluate(() => {
      const git = window.__cerebroMockGit!;
      git.modified = [{ path: 'inbox/capture.md', status: 'modified', staged: false }];
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const sync = sidebar.getByTestId('sync-badge');
    await expect(sync).toHaveText('1 uncommitted');
    await sync.click();
    await expect(page.getByRole('button', { name: 'Review 1 change', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'History', exact: true }).last()).toBeVisible();
    await page
      .getByRole('button', { name: 'Close sync menu' })
      .click({ position: { x: 400, y: 30 } });
    await page.screenshot({
      path: info.outputPath(`shell-wide-${theme}.png`),
      animations: 'disabled',
    });

    await page.setViewportSize({ width: 1048, height: 760 });
    await expect(sidebar).toBeVisible();
    expect((await sidebar.boundingBox())!.width).toBe(240);
    await page.setViewportSize({ width: 1047, height: 760 });
    await expect(sidebar).toBeHidden();
    await page.setViewportSize({ width: 900, height: 760 });
    const pages = area(page, 'Pages');
    await pages.focus();
    await page.keyboard.press('Enter');
    await expect(sidebar).toHaveAttribute('data-overlay', 'true');
    expect((await sidebar.boundingBox())!.x).toBe(54);
    expect((await sidebar.boundingBox())!.width).toBe(240);
    await showPageFolders(page);
    await expect(sidebar.getByTestId('file-tree')).toBeVisible();
    await expect(sync).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`shell-drawer-${theme}.png`),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await expect(sidebar).toBeHidden();
    await expect(pages).toBeFocused();
    await noOverflow(page);
  });
}
