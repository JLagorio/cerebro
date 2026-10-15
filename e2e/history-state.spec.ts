import { expect, test, type Page } from '@playwright/test';
import { boot } from './boot';

async function offEditor(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}
async function openPage(page: Page, title: string) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill(title);
  await page.getByTestId('quick-open-result').filter({ hasText: title }).first().click();
  await expect(page).toHaveTitle(`${title} — Cerebro`);
}
async function createPage(page: Page, title: string) {
  await offEditor(page);
  await page.keyboard.press('c');
  await page.keyboard.press('p');
  await page.getByPlaceholder('Page title').fill(title);
  await page.getByRole('button', { name: 'Create page', exact: true }).click();
  await expect(page).toHaveTitle(`${title} — Cerebro`);
}

test('Back restores the database search and scroll for that visit', async ({ page }, testInfo) => {
  await boot(page);
  await page.getByTestId('sidebar-type').filter({ hasText: 'Work item' }).click();
  await page.getByTestId('view-control-search').click();
  await page.getByTestId('view-search-input').fill('e');
  const table = page.getByTestId('table-view');
  await table.evaluate((node) => {
    node.scrollTop = 300;
  });
  await expect.poll(() => table.evaluate((node) => node.scrollTop)).toBe(300);
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Settings' }).click();
  await offEditor(page);
  await page.keyboard.press('ControlOrMeta+[');
  await expect(page.getByTestId('view-search-input')).toHaveValue('e');
  await expect.poll(() => table.evaluate((node) => node.scrollTop)).toBe(300);
  await page.screenshot({ path: testInfo.outputPath('restored-table.png') });
});

test('reload restores the current page and its saved Back history', async ({ page }) => {
  await boot(page);
  await openPage(page, 'Systems map');
  await page.reload();
  await expect(page).toHaveTitle('Systems map — Cerebro');
  await offEditor(page);
  await page.keyboard.press('ControlOrMeta+[');
  await expect(page).toHaveTitle('Home — Cerebro');
});

test('reload restores the place but never the record peek', async ({ page }) => {
  await boot(page);
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'My work' }).click();
  await offEditor(page);
  await page.keyboard.press('j');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('detail-panel')).toBeVisible();
  await page.reload();
  await expect(page).toHaveTitle('My work — Cerebro');
  await expect(page.getByTestId('detail-panel')).toHaveCount(0);
});

test('Back drops a trashed visit and Forward returns to the live page', async ({ page }) => {
  await boot(page);
  await createPage(page, 'History temporary A');
  await openPage(page, 'Systems map');
  await openPage(page, 'History temporary A');
  await openPage(page, 'How we schedule');
  const row = page
    .getByTestId('file-tree')
    .locator('[data-testid="tree-row"][data-path="history-temporary-a.md"]');
  await row.getByTestId('tree-file').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Trash' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Move to Trash' }).click();
  await expect(row).toHaveCount(0);
  await offEditor(page);
  await page.keyboard.press('ControlOrMeta+[');
  await expect(page).toHaveTitle('Systems map — Cerebro');
  await page.keyboard.press('ControlOrMeta+]');
  await expect(page).toHaveTitle('How we schedule — Cerebro');
});

test('a last page missing after reload is silently forgotten', async ({ page }) => {
  await boot(page);
  await createPage(page, 'History temporary B');
  // The browser backend recreates the demo filesystem on reload, so B vanishes.
  await page.reload();
  await expect(page).toHaveTitle('Home — Cerebro');
  await expect(page.getByTestId('toast-host')).toBeEmpty();
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem('cerebro.lastPlace') ?? '{}')['/demo-vault'],
      ),
    )
    .toEqual({ kind: 'home' });
});
