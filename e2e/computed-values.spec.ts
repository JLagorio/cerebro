import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile } from './boot';

/**
 * Computed values filter like stored ones (M60.1).
 *
 * A Last edited time property stores nothing: its value is the file's own
 * stamp. Before M60.1 the filter read the empty frontmatter key, so "Edited is
 * on or after …" hid every record although the menu offered it. The roadmap's
 * bullet is "last edited within 7 days returns rows on demo-vault": until
 * M61.3's relative operators, that is `on or after` VAULT_TODAY minus seven
 * days, 2026-07-21.
 *
 * The mock stamps every seeded file with one SEED_TIME (2026-07-24), so this
 * cannot tell rows apart; the vitest fixtures prove the discrimination. What
 * only a browser proves is the whole chain: the property is declared through
 * the panel, the filter is built through the chips, the rows answer, and the
 * view lands on disk naming the field.
 */

/** Pick `label` from the Dropdown named `name` inside the open rule. */
async function choose(page: Page, name: string, label: string) {
  await page.getByTestId('filter-rule').getByRole('button', { name }).click();
  await page.getByRole('listbox', { name }).getByRole('option', { name: label }).click();
}

/** Set the open rule's date bound to a day of the pinned month, July 2026. */
async function pickDay(page: Page, day: string) {
  await page.getByTestId('filter-rule').getByRole('button', { name: 'Filter value' }).click();
  await page.getByTestId('filter-exact-date').click();
  await page.getByTestId('calendar').getByRole('button', { name: day }).click();
  // Escape closes the top layer only: the date surface, not the rule editor.
  await page.keyboard.press('Escape');
}

test('a Last edited time filter returns the rows edited in the last week', async ({ page }) => {
  await boot(page);
  await page.getByTestId('sidebar-type').filter({ hasText: 'Work item' }).first().click();
  await expect(page.getByTestId('table-row').first()).toBeVisible();

  // -- Declare "Edited", a Last edited time property, from the table -----
  await page.getByTestId('add-column').click();
  const panel = page.getByTestId('add-property-panel');
  await expect(panel).toBeVisible();
  await panel.getByLabel('Property name').fill('Edited');
  await panel.getByTestId('property-kind-last_edited_time').click();
  await expect.poll(async () => readMockFile(page, 'types/work-item.md')).toMatch(/^\s+edited:/m);

  // -- A rule on Edited, seeded from the toolbar's Filter menu ------------
  // The filter bar is closed on a view with no filters, so `filter-add` is
  // not on screen yet; the Filter icon's menu seeds the first rule and opens
  // the bar. `is not empty` already keeps every row, which it could not
  // before M60.1: the property read empty frontmatter.
  await page.getByTestId('view-control-filter').click();
  await page.getByLabel('Filter by…').fill('Edited');
  await page
    .locator('div', { has: page.getByLabel('Filter by…') })
    .last()
    .getByRole('button', { name: 'Edited' })
    .click();
  await expect(page.getByTestId('filter-add')).toBeVisible();
  await page.getByTestId('filter-chip-0').click();
  await expect(page.getByTestId('filter-rule')).toBeVisible();
  await expect(page.getByTestId('table-row').first()).toBeVisible();

  // -- "Edited is on or after 2026-07-21": last edited within 7 days ------
  await choose(page, 'Filter operator', 'is on or after');
  await pickDay(page, 'July 21, 2026');
  await expect(page.getByTestId('table-row').first()).toBeVisible();
  expect(await page.getByTestId('table-row').count()).toBeGreaterThan(0);

  // -- The saved view names the field ------------------------------------
  await expect.poll(async () => readMockFile(page, 'types/work-item.md')).toMatch(/field: edited/);
  const typeDoc = await readMockFile(page, 'types/work-item.md');
  expect(typeDoc).toMatch(/op: on_or_after/);
  expect(typeDoc).toMatch(/value: ["']?2026-07-21/);

  // -- 2026-07-25, past every row's stamp: nothing matches ---------------
  await pickDay(page, 'July 25, 2026');
  await expect(page.getByText('Nothing matches these filters')).toBeVisible();
  await expect(page.getByTestId('table-row')).toHaveCount(0);
});
