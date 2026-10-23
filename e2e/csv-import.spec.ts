import { expect, test } from '@playwright/test';
import { parse } from 'yaml';
import { boot, readMockFile, showDatabases } from './boot';

const csv =
  'Title,Notes,Pages,Read\r\nDune,"A desert\r\nplanet",412,true\r\n"One, two","Say ""hello""",255,false\r\nSolaris,Ocean,204,true\r\n';
const metadata = (text: string) =>
  parse(/^---\n([\s\S]*?)\n---\n/.exec(text)![1]) as Record<string, unknown>;

test('imports quoted CSV into a database in one batch and removes it with one Undo', async ({
  page,
}) => {
  await boot(page);
  await showDatabases(page);
  await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
  await page
    .getByTestId('csv-file-input')
    .setInputFiles({ name: 'books.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  const dialog = page.getByRole('dialog', { name: 'Import CSV' });
  await expect(dialog.getByRole('textbox', { name: 'Database name' })).toHaveValue('Books');
  await expect(dialog.getByRole('button', { name: 'Kind for Notes' })).toHaveAttribute(
    'data-value',
    'text',
  );
  const pages = dialog.getByRole('button', { name: 'Kind for Pages' });
  await expect(pages).toHaveAttribute('data-value', 'number');
  await expect(dialog.getByRole('button', { name: 'Kind for Read' })).toHaveAttribute(
    'data-value',
    'checkbox',
  );
  // The kinds list opens over the dialog, and Escape closes the list alone.
  await pages.click();
  const kinds = page.locator(`[id="${await pages.getAttribute('aria-controls')}"]`);
  await expect(kinds.getByRole('option')).toHaveText(['Number', 'Text']);
  await page.keyboard.press('Escape');
  await expect(kinds).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(pages).toBeFocused();
  await expect(dialog.getByRole('status')).toHaveText('3 records');
  await page.screenshot({
    path: '/private/tmp/cerebro-csv-preview.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByTestId('csv-import-submit').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('table-row')).toHaveCount(3);
  expect(metadata(await readMockFile(page, 'types/books.md'))).toMatchObject({
    type: 'Type',
    folder: 'records/books',
    fields: { notes: { kind: 'text' }, pages: { kind: 'number' }, read: { kind: 'checkbox' } },
  });
  expect(metadata(await readMockFile(page, 'records/books/dune.md'))).toEqual({
    type: 'Books',
    notes: 'A desert\nplanet',
    pages: 412,
    read: true,
  });
  const paths = [
    'types/books.md',
    'records/books/dune.md',
    'records/books/one-two.md',
    'records/books/solaris.md',
  ];
  const ids = await page.evaluate(
    (paths) =>
      (
        window.__cerebroMockWrites as ((typeof window.__cerebroMockWrites)[number] & {
          batchId?: string;
        })[]
      )
        .filter((write) => paths.includes(write.path))
        .map((write) => write.batchId),
    paths,
  );
  expect(ids).toHaveLength(4);
  expect(new Set(ids).size).toBe(1);
  expect(ids[0]).toBeTruthy();
  await page.locator('body').click({ position: { x: 500, y: 30 } });
  await page.keyboard.press('Meta+z');
  await expect
    .poll(() =>
      page.evaluate((paths) => paths.filter((path) => window.__cerebroMockFs.has(path)), paths),
    )
    .toEqual([]);
  await expect(page.getByTestId('sidebar-type').filter({ hasText: 'Books' })).toHaveCount(0);
});

test('a long row shows its record number and writes nothing', async ({ page }) => {
  await boot(page);
  const before = await page.evaluate(() => [...window.__cerebroMockFs]);
  await showDatabases(page);
  await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
  await page.getByTestId('csv-file-input').setInputFiles({
    name: 'books.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Title,Pages\nDune,412\nBad,1,extra'),
  });
  await expect(page.getByRole('alert')).toContainText('Row 3 has more values than the header.');
  await expect(page.getByTestId('csv-import-submit')).toBeDisabled();
  expect(await page.evaluate(() => [...window.__cerebroMockFs])).toEqual(before);
});
