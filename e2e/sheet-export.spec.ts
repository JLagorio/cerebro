import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { boot, seedFileBeforeBoot } from './boot';
const PATH = 'notes/export-budget.md';
const SOURCE =
  "# Export budget\n\n```cerebro-sheet\n---\nname: Budget\n---\nItem,Cost\nRent,1200\nFood,300\n,=SUM(B2:B3)\n'=not a formula,\n```\n\n```cerebro-sheet\n---\nname: Summary\n---\n=Budget!B4\n```\n";
async function open(page: Page) {
  await page.setViewportSize({ width: 1450, height: 1050 });
  await seedFileBeforeBoot(page, PATH, SOURCE);
  await boot(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Export budget');
  await page.getByTestId('quick-open-result').filter({ hasText: 'Export budget' }).first().click();
  const grids = page.getByTestId('markdown-editor').getByTestId('sheet-grid');
  await expect(grids).toHaveCount(2);
  await expect(grids.nth(1).locator('[data-cell=A1]')).toHaveText('1500');
  return grids;
}
test('Excel export includes both live fences and a pending cell draft', async ({ page }, info) => {
  const grids = await open(page);
  const budget = grids.first();
  await budget.locator('[data-cell=B2]').dblclick();
  await budget.getByTestId('sheet-cell-editor').fill('1250');
  await budget.getByTestId('sheet-export-menu').click();
  await expect(page.getByTestId('sheet-export-xlsx')).toBeVisible();
  await page.screenshot({ path: info.outputPath('sheet-export-menu.png'), animations: 'disabled' });
  await page.getByTestId('sheet-export-xlsx').click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __cerebroMockSheetExports?: unknown[] }).__cerebroMockSheetExports
            ?.length,
      ),
    )
    .toBe(1);
  const exported = await page.evaluate(
    () =>
      (window as unknown as { __cerebroMockSheetExports: { defaultName: string; page: string }[] })
        .__cerebroMockSheetExports[0],
  );
  expect(exported.defaultName).toBe('export-budget.xlsx');
  expect(exported.page.match(/```cerebro-sheet/g)).toHaveLength(2);
  expect(exported.page).toContain('Rent,1250');
  expect(exported.page).toContain('=Budget!B4');
  await expect(grids.nth(1).locator('[data-cell=A1]')).toHaveText('1550');
  await expect(page.getByText('Exported export-budget.xlsx', { exact: true })).toBeVisible();
});
test('CSV downloads calculated values, blanks and guarded text with BOM and CRLF', async ({
  page,
}) => {
  const grid = (await open(page)).first();
  await grid.getByTestId('sheet-export-menu').click();
  const downloading = page.waitForEvent('download');
  await page.getByTestId('sheet-export-csv').click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('export-budget-budget.csv');
  const path = await download.path();
  expect(path).not.toBeNull();
  expect(readFileSync(path!).toString('utf8')).toBe(
    "\uFEFFItem,Cost\r\nRent,1200\r\nFood,300\r\n,1500\r\n'=not a formula,\r\n",
  );
});
