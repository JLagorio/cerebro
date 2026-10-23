import { expect, test } from '@playwright/test';
import { boot, openDatabase, readMockFile } from './boot';

test('a grouped database leads with records and retains local creation and empty groups', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await boot(page);
  const before = await readMockFile(page, 'types/epic.md');
  await openDatabase(page, 'Epic');
  await page.evaluate(() => document.fonts.ready);
  const table = page.getByTestId('table-view');
  const rows = page.getByTestId('table-row');
  const groups = page.getByTestId('table-group-header');
  await expect(rows).toHaveCount(4);
  await expect(groups).toHaveCount(3);
  await expect(page.getByTestId('quick-add')).toHaveCount(0);
  await expect(page.getByTestId('view-control-sort')).toHaveCount(0);
  await expect(page.getByTestId('view-control-group')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'View options', exact: true })).toBeVisible();
  await expect(rows.locator('[data-icon="layers"]')).toHaveCount(0);
  const title = rows.first().locator('[data-cell-primary]').first();
  const titleBox = (await title.boundingBox())!;
  const rowBox = (await rows.first().boundingBox())!;
  expect(titleBox.x - rowBox.x).toBeLessThanOrEqual(51);
  expect(titleBox.width).toBeGreaterThan(260);
  const open = rows.first().getByTestId('row-open-affordance');
  expect((await open.boundingBox())!.width).toBe(28);
  await page.mouse.move(8, 8);
  await page.screenshot({
    path: info.outputPath('database-reading-light.png'),
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Theme: light', exact: true }).click();
  await page.screenshot({
    path: info.outputPath('database-reading-dark.png'),
    animations: 'disabled',
  });

  await page.getByRole('button', { name: 'Show empty groups (2)', exact: true }).click();
  await expect(groups).toHaveCount(5);
  await expect(groups).toHaveText([
    /Shaping\s*1/,
    /Committed\s*1/,
    /Building\s*2/,
    /Shipped\s*0/,
    /Dropped\s*0/,
  ]);
  await page.getByRole('button', { name: 'Hide empty groups (2)', exact: true }).click();
  await expect(groups).toHaveCount(3);
  expect(await readMockFile(page, 'types/epic.md')).toBe(before);

  // The group action opens the real draft, with no permanent blank creation row.
  const create = page.getByRole('button', { name: 'New record in Building', exact: true });
  await create.focus();
  await expect(create).toBeFocused();
  await expect.poll(() => create.evaluate((node) => getComputedStyle(node).opacity)).toBe('1');
  await create.press('Enter');
  const input = page.getByRole('textbox', { name: 'New record in Building', exact: true });
  await expect(input).toBeFocused();
  await input.fill('Keep this local draft');
  await page.getByRole('button', { name: 'New record in Shaping', exact: true }).click();
  const otherDraft = page.getByRole('textbox', { name: 'New record in Shaping', exact: true });
  await expect(otherDraft).toBeFocused();
  await expect(input).toHaveValue('Keep this local draft');
  await otherDraft.press('Escape');
  await input.press('Escape');
  await expect(table).toBeFocused();
  await expect(page.getByRole('textbox', { name: /New record in/ })).toHaveCount(0);
  expect(await readMockFile(page, 'types/epic.md')).toBe(before);

  await create.click();
  await input.fill('A grouped creation proof');
  await input.press('Enter');
  const created = rows.filter({ hasText: 'A grouped creation proof' });
  await expect(created).toHaveCount(1);
  await expect(rows).toHaveCount(5);
  const createdPath = (await created.getAttribute('data-path'))!;
  await expect.poll(() => readMockFile(page, createdPath)).toMatch(/^status: building$/m);
  expect(await readMockFile(page, 'types/epic.md')).toBe(before);

  // Insert remains in the row's real action menu; the explicit Open action
  // remains a keyboard target with its original record-specific name.
  await rows.first().getByTestId('row-menu').click();
  await page.getByRole('menuitem', { name: 'Insert a record here', exact: true }).click();
  const insert = page.getByRole('textbox', { name: 'New record title', exact: true });
  await expect(insert).toBeFocused();
  await insert.press('Escape');
  await open.focus();
  await expect(open).toBeFocused();
  await expect.poll(() => open.evaluate((node) => getComputedStyle(node).opacity)).toBe('1');
  await open.press('Enter');
  await expect(page.getByTestId('detail-panel')).toBeVisible();
});

test('View options exposes filtering and the active filter stays visible and clearable', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await boot(page);
  await openDatabase(page, 'Epic');
  await page.getByRole('button', { name: 'View options', exact: true }).click();
  const settings = page.getByTestId('view-settings-panel');
  await settings.getByTestId('view-settings-filter').click();
  await settings.getByRole('button', { name: 'Add filter', exact: true }).click();
  await expect(settings.getByTestId('filter-rule')).toHaveCount(1);
  await settings.getByRole('button', { name: 'Filter property', exact: true }).click();
  await page
    .getByRole('listbox', { name: 'Filter property' })
    .getByRole('option', { name: 'Owner', exact: true })
    .click();
  await settings.getByRole('button', { name: 'Filter operator', exact: true }).click();
  await page
    .getByRole('listbox', { name: 'Filter operator' })
    .getByRole('option', { name: 'contains', exact: true })
    .click();
  await settings.getByRole('textbox', { name: 'Filter value', exact: true }).fill('Dana');
  await page.screenshot({
    path: info.outputPath('database-filter-options.png'),
    animations: 'disabled',
  });
  const panelBox = (await settings.boundingBox())!;
  for (const control of await settings.getByTestId('filter-rule').locator('button,input').all()) {
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(panelBox.x);
    expect(box.x + box.width).toBeLessThanOrEqual(panelBox.x + panelBox.width);
  }
  await settings.getByRole('button', { name: 'Close view settings', exact: true }).click();
  await expect(page.getByTestId('view-control-filter')).toContainText('1');
  await page.getByTestId('view-control-filter').click();
  await expect(page.getByTestId('filter-chip-0')).toContainText('Owner contains Dana');
  await page.screenshot({
    path: info.outputPath('database-active-filter.png'),
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.getByTestId('view-control-filter')).toHaveCount(0);
  await expect(page.getByTestId('filter-chip-0')).toHaveCount(0);
  await expect(page.getByTestId('table-row')).toHaveCount(4);
  await expect.poll(() => readMockFile(page, 'types/epic.md')).toContain('filters: null');
});
