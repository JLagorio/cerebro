import { expect, test } from '@playwright/test';
import { boot, readMockFile } from './boot';

test('bulk Set and Delete leave changed rows selected and preserve their newer bytes', async ({
  page,
}) => {
  await boot(page);
  await page.getByTestId('sidebar-type').filter({ hasText: 'Work item' }).first().click();
  await expect(page.getByTestId('table-row')).toHaveCount(45);
  const rows = page.getByTestId('table-row');
  const paths = await rows.evaluateAll((nodes) =>
    nodes.slice(0, 20).map((node) => node.getAttribute('data-path')!),
  );
  const changed = paths[4];
  const original = await readMockFile(page, changed);
  const title = /^# (.+)$/m.exec(original)?.[1];
  expect(title).toBeTruthy();
  await rows.nth(0).getByRole('checkbox').click();
  await rows
    .nth(19)
    .getByRole('checkbox')
    .click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('bulk-bar')).toContainText('20 selected');
  await page.evaluate(
    ([path, text]) => window.__cerebroMockFs.set(path, text),
    [changed, original + '\nNewer edit from another app.\n'],
  );
  await page.getByTestId('bulk-set').click();
  await page.getByTestId('bulk-set-field-priority').click();
  await page.getByRole('button', { name: 'Empty', exact: true }).click();
  await page.getByRole('option', { name: 'Low', exact: true }).click();
  await page.getByTestId('bulk-set-apply').click();
  await expect(page.getByTestId('bulk-bar')).toContainText('1 selected');
  await expect(page.getByTestId('bulk-report')).toContainText('changed since the table showed it');
  await expect(page.getByTestId('bulk-report')).toContainText(title!);
  expect(await readMockFile(page, changed)).toBe(original + '\nNewer edit from another app.\n');
  for (const path of paths.filter((path) => path !== changed)) {
    expect(await readMockFile(page, path)).toMatch(/^priority: low$/m);
  }
  await expect(page.locator(`[data-testid="table-row"][data-path="${changed}"]`)).toHaveAttribute(
    'data-bulk-failed',
    'true',
  );

  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(page.getByTestId('bulk-report')).toHaveCount(0);
  const deletePaths = paths.slice(0, 3);
  for (const path of deletePaths) {
    await page
      .locator(`[data-testid="table-row"][data-path="${path}"]`)
      .getByRole('checkbox')
      .click();
  }
  const saved = await readMockFile(page, deletePaths[1]);
  await page.evaluate(
    ([path, text]) => window.__cerebroMockFs.set(path, text),
    [deletePaths[1], saved + '\nKeep this newer edit.\n'],
  );
  await page.getByTestId('bulk-bar').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByTestId('bulk-bar')).toContainText('1 selected');
  await expect(page.getByTestId('bulk-report')).toContainText("Couldn't delete 1");
  const remaining = await page.evaluate(
    (paths) => paths.map((path) => window.__cerebroMockFs.has(path)),
    deletePaths,
  );
  expect(remaining).toEqual([false, true, false]);
  expect(await readMockFile(page, deletePaths[1])).toBe(saved + '\nKeep this newer edit.\n');
});
