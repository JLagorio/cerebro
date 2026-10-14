import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile } from './boot';

/**
 * Create and link from `[[` and `@` (M55.7).
 *
 * The `[` and `@` menus offered only pages that exist, and BlockNote closes a
 * menu four characters past its last match, so `[[Launch notes` ended as plain
 * text. Each menu now ends on a Create row: it makes the page at the vault
 * root and links the stem the backend wrote. Asserted against the mock disk,
 * and by opening the new page from its chip, which is a page like any other
 * (D18).
 */

const PAGE = 'delivery/how-we-schedule.md';
const BODY = ['# How we schedule', '', 'We ship on Thursdays, after the freeze.', ''].join('\n');

/** Seed the page, then open it from the sidebar, expanding its collection only if it is folded. */
async function openSchedule(page: Page): Promise<void> {
  await page.evaluate(([path, md]) => window.__cerebroMockFs.set(path, md), [PAGE, BODY]);
  const node = page.getByTestId('collection-node-doc').filter({ hasText: 'How we schedule' });
  if (!(await node.isVisible()))
    await page.getByRole('button', { name: 'Expand Delivery' }).click();
  await node.getByRole('button', { name: 'How we schedule' }).click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible({ timeout: 10_000 });
}

/** The vault root's files on the mock disk. */
const rootFiles = (page: Page) =>
  page.evaluate(() => [...window.__cerebroMockFs.keys()].filter((k) => !k.includes('/')).sort());

/** Rows of the open menu holding `text`. */
const rowsWith = (page: Page, text: string) =>
  page.locator('#bn-suggestion-menu [role=option]').filter({ hasText: text });

test('[[ then Create makes the page at the vault root, links it, and the link opens it', async ({
  page,
}) => {
  await boot(page);
  await openSchedule(page);
  const editor = page.getByTestId('markdown-editor');
  await editor.getByText('We ship on Thursdays').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('See [[Launch notes');
  await rowsWith(page, 'Create "Launch notes"').click();

  const chip = editor.locator('[data-chip="wikilink"]');
  await expect(chip).toHaveText('Launch notes', { timeout: 10_000 });
  expect(await readMockFile(page, 'launch-notes.md')).toBe('# Launch notes\n');
  await expect
    .poll(() => readMockFile(page, PAGE), { timeout: 6_000 })
    .toContain('See [[launch-notes]]');
  expect(await readMockFile(page, PAGE)).not.toContain('[[Launch notes');

  await chip.click();
  await expect(page.getByTestId('doc-title')).toHaveText('Launch notes', { timeout: 10_000 });
  await expect(editor.getByRole('heading', { name: 'Launch notes' })).toBeVisible();
});

test('@ creates only where a word starts, and a lone [ never does', async ({ page }) => {
  await boot(page);
  const before = await rootFiles(page);
  await openSchedule(page);
  const editor = page.getByTestId('markdown-editor');
  await editor.getByText('We ship on Thursdays').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' @Retro memo');
  await rowsWith(page, 'Create "Retro memo"').click();
  await expect(editor.locator('[data-chip="wikilink"]')).toHaveText('Retro memo', {
    timeout: 10_000,
  });
  expect(await readMockFile(page, 'retro-memo.md')).toBe('# Retro memo\n');

  // An address is not a mention: its `@` opens the menu, but no Create row,
  // so Enter has nothing to make.
  await page.keyboard.type('mail ana@example.com');
  await expect(rowsWith(page, 'Create "')).toHaveCount(0);
  await page.keyboard.press('Enter');
  // A lone bracket is a bracket.
  await page.keyboard.type('[Draft');
  await expect(rowsWith(page, 'Create "')).toHaveCount(0);

  // Once the page has saved what was typed after Enter, anything Enter or
  // the bracket had made would be on the disk too.
  await expect.poll(() => readMockFile(page, PAGE), { timeout: 6_000 }).toContain('Draft');
  const after = await rootFiles(page);
  expect(after.filter((path) => !before.includes(path))).toEqual(['retro-memo.md']);
});
