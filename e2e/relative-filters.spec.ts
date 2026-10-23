import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile, showDatabases } from './boot';

async function operator(page: Page, label: string) {
  await page.getByTestId('filter-rule').getByRole('button', { name: 'Filter operator' }).click();
  await page
    .getByRole('listbox', { name: 'Filter operator' })
    .getByRole('option', { name: label, exact: true })
    .click();
}

async function relative(page: Page, token: string) {
  await page.getByTestId('filter-rule').getByRole('button', { name: 'Filter value' }).click();
  const panel = page.getByRole('dialog', { name: 'Filter date' });
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.getByTestId(`filter-relative-${token}`).click();
}

test('relative due filters show the named days and save tokens as plain strings', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await boot(page);
  await showDatabases(page);
  await page.getByTestId('sidebar-type').filter({ hasText: 'Work item' }).first().click();
  await page.getByRole('button', { name: 'View options', exact: true }).click();
  const settings = page.getByTestId('view-settings-panel');
  await settings.getByRole('button', { name: 'Filter', exact: true }).click();
  await settings.getByRole('button', { name: 'Add filter', exact: true }).click();
  await settings.getByRole('button', { name: 'Filter property', exact: true }).click();
  await page
    .getByRole('listbox', { name: 'Filter property' })
    .getByRole('option', { name: 'Due', exact: true })
    .click();
  await settings.getByRole('button', { name: 'Close view settings', exact: true }).click();
  await page.getByTestId('view-control-filter').click();
  await page.getByTestId('filter-chip-0').click();
  await operator(page, 'is on or before');
  await relative(page, 'today');
  await expect(page.getByTestId('filter-chip-0')).toContainText('Due is on or before today');
  await expect(page.getByTestId('table-row')).toHaveCount(12);
  await expect.poll(() => readMockFile(page, 'types/work-item.md')).toContain('value: today');

  await operator(page, 'is');
  await relative(page, 'this_week');
  await expect(page.getByTestId('filter-chip-0')).toContainText('Due is this week');
  await expect(page.getByTestId('table-row')).toHaveCount(5);
  for (const title of [
    'Resume-after-interrupt QA pass',
    'Conflict resolution UX spec',
    'Forklift certification schedule',
    'Positioning + message house',
    'Rack delivery + install window',
  ]) {
    await expect(page.getByTestId('table-row').filter({ hasText: title })).toHaveCount(1);
  }
  await expect.poll(() => readMockFile(page, 'types/work-item.md')).toContain('value: this_week');
});
