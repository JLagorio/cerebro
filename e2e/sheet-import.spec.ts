import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { XlsxImport } from '../src/engine/sheet/import';
const decoded = JSON.parse(
  readFileSync(
    new URL('../src-tauri/fixtures/sheets/ironcalc-example.decoded.json', import.meta.url),
    'utf8',
  ),
) as XlsxImport;
import { boot, readMockFile } from './boot';
import type { StagedSheetFile } from '../src/lib/mockIpc';
async function stage(page: Page, file: StagedSheetFile) {
  await page.evaluate((value) => {
    (
      window as unknown as { __cerebroStageSheetFile(value: StagedSheetFile): void }
    ).__cerebroStageSheetFile(value);
  }, file);
}
async function open(page: Page) {
  await page.setViewportSize({ width: 1450, height: 1100 });
  await boot(page);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('option', { name: /Sheet from file/ }).click();
  await expect(page.getByTestId('sheet-import-dialog')).toBeVisible();
}
test('a real workbook preview names what stays behind and imports ten sheet blocks with one Undo', async ({
  page,
}, info) => {
  await open(page);
  await stage(page, { kind: 'xlsx', name: 'example.xlsx', workbook: decoded });
  await page.getByTestId('sheet-import-choose').click();
  await expect(page.getByTestId('sheet-import-sheets').locator('li')).toHaveCount(10);
  await expect(page.getByTestId('sheet-import-report')).toContainText("2 charts aren't imported.");
  await expect(page.getByTestId('sheet-import-report')).toContainText(
    "1 chart sheet isn't imported.",
  );
  await expect(page.getByTestId('sheet-import-report')).toContainText(
    '1 pivot table comes in as the values',
  );
  await expect(page.getByTestId('sheet-import-report')).toContainText('1 hidden sheet is shown.');
  await page.getByTestId('sheet-import-title').fill('Example workbook');
  await page.screenshot({
    path: info.outputPath('sheet-import-preview.png'),
    animations: 'disabled',
  });
  await page.getByTestId('sheet-import-submit').click();
  await expect(page.getByTestId('sheet-import-dialog')).toHaveCount(0);
  const editor = page.getByTestId('markdown-editor');
  await expect(editor.getByTestId('sheet-grid')).toHaveCount(10);
  await expect(editor.getByTestId('sheet-unavailable')).toHaveCount(0);
  const bytes = await readMockFile(page, 'example-workbook.md');
  expect(bytes).toContain('# Example workbook');
  expect(bytes.match(/```cerebro-sheet/g)).toHaveLength(10);
  expect(bytes).toContain('=SUM(Sheet1!$A$16:$A$18)');
  await page.screenshot({ path: info.outputPath('sheet-import-page.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Undo', exact: true }).last().click();
  await expect
    .poll(() => page.evaluate(() => window.__cerebroMockFs.has('example-workbook.md')))
    .toBe(false);
});
test('CSV keeps its BOM-decoded text, quoted CRLF and blank row as one four-row sheet', async ({
  page,
}) => {
  await open(page);
  await stage(page, {
    kind: 'csv',
    name: 'Budget.csv',
    text: '\uFEFFItem,Value\r\n"a\r\nb",1\r\n\r\nTotal,=B2\r\n',
  });
  await page.getByTestId('sheet-import-choose').click();
  await expect(page.getByTestId('sheet-import-sheets')).toContainText('Sheet1 · 4 × 2');
  await page.getByTestId('sheet-import-submit').click();
  const grid = page.getByTestId('markdown-editor').getByTestId('sheet-grid');
  await expect(grid).toHaveCount(1);
  await expect(grid.locator('[data-cell=B4]')).toHaveText('1');
  const bytes = await readMockFile(page, 'budget.md');
  expect(bytes).toContain('"a\nb",1\n,\nTotal,=B2');
});
test('a refused workbook and malformed CSV leave the vault unchanged and explain why', async ({
  page,
}) => {
  await open(page);
  const before = await page.evaluate(() => [...window.__cerebroMockFs]);
  await stage(page, {
    refusal:
      "This isn't an Excel workbook Cerebro can read: it isn't a valid, unencrypted .xlsx file.",
  });
  await page.getByTestId('sheet-import-choose').click();
  await expect(page.getByTestId('sheet-import-problem')).toContainText(
    "isn't a valid, unencrypted",
  );
  await stage(page, { kind: 'csv', name: 'bad.csv', text: '"not closed' });
  await page.getByTestId('sheet-import-choose').click();
  await expect(page.getByTestId('sheet-import-problem')).toHaveText(
    'Row 1: a quote is never closed.',
  );
  await expect(page.getByTestId('sheet-import-submit')).toBeDisabled();
  expect(await page.evaluate(() => [...window.__cerebroMockFs])).toEqual(before);
});
