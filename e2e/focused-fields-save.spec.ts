import { expect, test, type Page } from '@playwright/test';
import { boot, openDatabase, readMockFile, seedFileBeforeBoot } from './boot';
const record = 'records/focused-fields/specimen.md';
async function openFields(page: Page) {
  await seedFileBeforeBoot(
    page,
    'types/focused-field.md',
    '---\ntype: Type\nfolder: records/focused-fields\nfields:\n  estimate: { kind: number }\n---\n# Focused field\n',
  );
  await seedFileBeforeBoot(
    page,
    record,
    '---\ntype: Focused field\nestimate: 3\n---\n# Focused specimen\n',
  );
  await boot(page);
  await openDatabase(page, 'Focused field');
  return page.getByTestId('table-row').filter({ hasText: 'Focused specimen' });
}
test('Save commits a focused table title through its guarded writer before blur', async ({
  page,
}) => {
  const row = await openFields(page);
  await row.getByRole('button', { name: 'Focused specimen', exact: true }).click();
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('  Saved focused title  ');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readMockFile(page, record)).toContain('# Saved focused title');
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveCount(0);
  const acknowledged = await readMockFile(page, record);
  await page
    .getByTestId('table-row')
    .getByRole('button', { name: 'Saved focused title', exact: true })
    .click();
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Changed again');
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('  Saved focused title  ');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry saving Title', exact: true })).toHaveCount(
    0,
  );
  expect(await readMockFile(page, record)).toBe(acknowledged);
});
test('an invalid focused scalar blocks leave and exposes Retry while keeping exact input', async ({
  page,
}, info) => {
  const row = await openFields(page);
  await row
    .locator('[data-field-kind="number"]')
    .getByRole('button', { name: '3', exact: true })
    .click();
  const input = page.getByRole('textbox', { name: 'Estimate', exact: true });
  await input.fill('  Infinity  ');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(
    page.getByRole('button', { name: 'Retry saving Estimate', exact: true }),
  ).toBeVisible();
  await page.getByTestId('app-rail').getByRole('button', { name: 'Home', exact: true }).click();
  await expect(input).toHaveValue('  Infinity  ');
  await expect(page.getByTestId('table-view')).toBeVisible();
  await page.getByRole('button', { name: 'Retry saving Estimate', exact: true }).click();
  await expect(input).toHaveValue('  Infinity  ');
  expect(await readMockFile(page, record)).toContain('estimate: 3');
  const retryBox = await page
    .getByRole('button', { name: 'Retry saving Estimate', exact: true })
    .boundingBox();
  const inputBox = await input.boundingBox();
  expect(retryBox!.y + retryBox!.height).toBeLessThanOrEqual(inputBox!.y + inputBox!.height + 1);
  await page.screenshot({
    path: info.outputPath('focused-field-retry.png'),
    animations: 'disabled',
  });
  await input.fill('8');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readMockFile(page, record)).toContain('estimate: 8');
  await page.getByTestId('app-rail').getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page).toHaveTitle('Home — Cerebro');
});
