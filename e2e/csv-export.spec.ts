import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { CsvTable } from '../src/engine/csv';
import { boot, showDatabases } from './boot';

async function downloadTab(page: Page, id: string) {
  await page.getByTestId(`view-tab-${id}`).click({ button: 'right' });
  const downloading = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Export as CSV…' }).click();
  const download = await downloading;
  const path = await download.path();
  expect(path).not.toBeNull();
  const csv = await readFile(path!, 'utf8');
  expect(csv.startsWith('\uFEFF')).toBe(true);
  expect(csv.endsWith('\r\n')).toBe(true);
  const table: CsvTable = await page.evaluate(async (text) => {
    const modulePath = '/src/engine/csv.ts';
    const { parseCsv } = await import(/* @vite-ignore */ modulePath);
    return parseCsv(text);
  }, csv);
  return { filename: download.suggestedFilename(), table, csv };
}

test('exports each tab’s saved rows and columns, including a closed filtered tab', async ({
  page,
}) => {
  await boot(page);
  await showDatabases(page);
  await page.getByTestId('sidebar-type').filter({ hasText: 'Work item' }).first().click();
  await expect(page.getByTestId('table-row')).toHaveCount(45);
  const all = await downloadTab(page, 'all');
  expect(all.filename).toBe('work-item-all.csv');
  expect(all.table.headers).toEqual(['Name', 'Status', 'Priority', 'Assignee', 'Due', 'Estimate']);
  expect(all.table.rows).toHaveLength(45);
  expect(all.csv).toContain('\r\nLanding page refresh,');
  expect(all.table.rows.some((row) => row[3].includes('Ana Rios'))).toBe(true);

  const risk = await downloadTab(page, 'at-risk-work');
  expect(risk.filename).toBe('work-item-at-risk.csv');
  expect(risk.table.rows.length).toBeLessThan(45);
  // The menu action never switched the visible tab.
  await expect(page.getByTestId('view-tab-all')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('view-tab-at-risk-work').click();
  const paths = await page
    .getByTestId('table-row')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-path')!));
  const expected = await page.evaluate(
    (paths) => paths.map((path) => /^# (.+)$/m.exec(window.__cerebroMockFs.get(path)!)![1]),
    paths,
  );
  expect(risk.table.rows.map((row) => row[0])).toEqual(expected);
});
