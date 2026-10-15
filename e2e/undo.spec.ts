import { expect, test, type Page } from '@playwright/test';
import YAML from 'yaml';
import { boot, readMockFile } from './boot';

/**
 * Undo and redo of the person's own changes (M60.7), on the mock backend.
 * A rename undone puts the Type doc and every record back byte for byte; a
 * deleted record comes back byte for byte; a key changed outside Cerebro
 * since is kept and named; ⌘Z acts outside text editors and ⇧⌘Z redoes.
 * A rename from either the record panel's property menu or the table's
 * column menu writes one batch and nothing else: since M60.2 the batch also
 * renames the field in every saved view.
 */

const TYPE_DOC = 'types/work-item.md';

const disk = (page: Page): Promise<Record<string, string>> =>
  page.evaluate(() => Object.fromEntries(window.__cerebroMockFs.entries()));

const frontmatterOf = (text: string): Record<string, unknown> => {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text);
  return (block === null ? {} : YAML.parse(block[1])) as Record<string, unknown>;
};

const titleOf = (text: string): string => /^# (.+)$/m.exec(text)?.[1] ?? '';

/** Every Work item record and the Type doc, as bytes. */
async function workItems(page: Page): Promise<Record<string, string>> {
  const all = await disk(page);
  return Object.fromEntries(
    Object.entries(all).filter(
      ([path, text]) =>
        path === TYPE_DOC ||
        (path.endsWith('.md') &&
          !path.startsWith('.trash/') &&
          frontmatterOf(text).type === 'Work item'),
    ),
  );
}

async function openType(page: Page, name: string): Promise<void> {
  await page.getByTestId('sidebar-type').filter({ hasText: name }).first().click();
  await expect(page.getByTestId('table-row').first()).toBeVisible();
}

const toasts = (page: Page) => page.getByTestId('toast-host');

/** Rename `column` through the table's column menu. */
async function renameColumn(page: Page, column: string, to: string): Promise<void> {
  await page.getByRole('button', { name: `${column} column menu` }).click();
  const rename = page.getByLabel(`Rename ${column}`);
  await rename.fill(to);
  await rename.press('Enter');
}

test('renaming assignee, then Undo, puts the Type doc and every Work item back byte for byte', async ({
  page,
}) => {
  await boot(page);
  const before = await workItems(page);
  const holder = Object.entries(before).find(
    ([path, text]) => path !== TYPE_DOC && 'assignee' in frontmatterOf(text),
  );
  expect(holder).toBeDefined();
  const holderTitle = titleOf(holder![1]);
  await openType(page, 'Work item');

  // -- The record panel's property menu → rename Assignee to Owner ---------
  const row = page.getByTestId('table-row').filter({ hasText: holderTitle }).first();
  await row.hover();
  await row.getByRole('button', { name: /^Open / }).click();
  const panel = page.getByTestId('detail-panel');
  await expect(panel).toBeVisible();
  const toggle = panel.getByTestId('view-details-toggle');
  if ((await toggle.count()) > 0) await toggle.click();
  await panel.getByRole('button', { name: 'Assignee property menu' }).click();
  const rename = page.getByLabel('Rename Assignee');
  await rename.fill('Owner');
  await rename.press('Enter');
  await expect
    .poll(async () => Object.keys(frontmatterOf(await readMockFile(page, TYPE_DOC)).fields ?? {}))
    .toContain('owner');
  const label = toasts(page).getByText(/^Renamed “Assignee” to “Owner” on \d+ pages$/);
  await expect(label).toBeVisible();

  // -- Undo on the toast: every file is the snapshot again -----------------
  await toasts(page).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => workItems(page)).toEqual(before);
  await expect(toasts(page).getByText(/^Undid: Renamed “Assignee” to “Owner”/)).toBeVisible();
  await expect(toasts(page).getByRole('button', { name: 'Redo' })).toBeVisible();
});

test('a deleted record comes back byte for byte from the toast’s Undo', async ({ page }) => {
  await boot(page);
  await openType(page, 'Work item');
  const row = page.getByTestId('table-row').first();
  const box = row.getByRole('checkbox', { name: /^Select / });
  const title = ((await box.getAttribute('aria-label')) ?? '').replace(/^Select /, '');
  await box.click();
  const before = await disk(page);
  await page.getByTestId('bulk-bar').getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(toasts(page).getByText(`Moved “${title}” to Trash`)).toBeVisible();
  await expect(page.getByTestId('table-row').filter({ hasText: title })).toHaveCount(0);

  await toasts(page).getByRole('button', { name: 'Undo' }).click();
  await expect
    .poll(async () => {
      const now = await disk(page);
      return Object.entries(before).every(([path, text]) => now[path] === text);
    })
    .toBe(true);
  await expect(page.getByTestId('table-row').filter({ hasText: title })).toHaveCount(1);
});

test('Undo keeps a key changed outside Cerebro since, and says so', async ({ page }) => {
  await boot(page);
  await openType(page, 'Work item');
  await renameColumn(page, 'Estimate', 'Size points');
  await expect
    .poll(async () => Object.keys(frontmatterOf(await readMockFile(page, TYPE_DOC)).fields ?? {}))
    .toContain('size_points');

  // -- One record's renamed key, edited straight on disk -------------------
  const all = await disk(page);
  const [edited, text] = Object.entries(all).find(
    ([path, t]) => path !== TYPE_DOC && /^size_points: /m.test(t),
  )!;
  const value = String(frontmatterOf(text).size_points);
  const changed = value === 'XL' ? 'XS' : 'XL';
  await page.evaluate(
    ([path, next]) => {
      const raw = window.__cerebroMockFs.get(path) ?? '';
      window.__cerebroMockFs.set(path, raw.replace(/^size_points: .*$/m, `size_points: ${next}`));
    },
    [edited, changed] as const,
  );
  // -- A write of the store's own rescans, so the scan sees the edit -------
  await page.getByRole('button', { name: 'Priority column menu' }).click();
  await page.getByRole('menuitem', { name: 'Sort ascending' }).click();
  await expect.poll(async () => readMockFile(page, TYPE_DOC)).toMatch(/field: priority\n/);

  await page.getByTestId('table-view').focus();
  await page.keyboard.press('ControlOrMeta+z');
  // The rename's batch renamed Estimate in the saved views too (M60.2), and
  // the sort rewrote them after it, so Undo keeps that key as well and names
  // you as its writer.
  await expect(
    toasts(page).getByText(`Undid: Renamed “Estimate” to “Size points”`, { exact: false }),
  ).toContainText(
    `Kept 2 changes made since: Views on “Work item” (you), Size points on “${titleOf(text)}” (changed outside Cerebro)`,
  );
  const now = frontmatterOf(await readMockFile(page, edited));
  expect(now.size_points).toBe(changed);
  expect(String(now.estimate)).toBe(value);
  expect(Object.keys(frontmatterOf(await readMockFile(page, TYPE_DOC)).fields ?? {})).toContain(
    'estimate',
  );
});

test('⌘Z undoes from the table, leaves a page body alone, and ⇧⌘Z redoes', async ({ page }) => {
  await boot(page);
  await openType(page, 'Work item');
  await renameColumn(page, 'Estimate', 'Size points');
  const renamed = () =>
    readMockFile(page, TYPE_DOC).then((t) => Object.keys(frontmatterOf(t).fields ?? {}));
  await expect.poll(renamed).toContain('size_points');

  // -- ⌘Z inside a page body is the editor's, not the stack's --------------
  const row = page.getByTestId('table-row').first();
  await row.hover();
  await row.getByRole('button', { name: /^Open / }).click();
  const body = page
    .getByTestId('detail-panel')
    .locator('[data-testid="markdown-editor"] .bn-editor');
  await body.click();
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(300);
  expect(await renamed()).toContain('size_points');
  await page.keyboard.press('Escape');

  // -- ⌘Z with the table focused undoes; ⇧⌘Z redoes ------------------------
  await page.getByTestId('table-view').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(renamed).toContain('estimate');
  await page.getByTestId('table-view').focus();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(renamed).toContain('size_points');
});
