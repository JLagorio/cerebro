import { expect, test, type Locator, type Page } from '@playwright/test';
import { boot, readMockFile, openDestination, showPages } from './boot';

/**
 * Sub-pages (M55.13). "Add sub-page" on a plain page moves it into a folder
 * of its own by rename — its bytes unchanged — and adds the child; the Pages
 * panel, the tree and a `/Sub-pages` block all list it; and a page dropped on
 * the middle of a page row nests under it.
 *
 * Two stand-ins, both because the harness cannot do the real thing:
 * `page.reload()` resets the mock disk, so leaving for Home and reopening
 * both pages from the tree stands in for a relaunch; and Playwright cannot
 * drive HTML5 drag (DOM trap 6), so the drop is dispatched as drag events
 * carrying a DataTransfer at mid-row. The packaged check proves both.
 */

const OLD = 'delivery/how-we-schedule.md';
const PARENT = 'delivery/how-we-schedule/how-we-schedule.md';
const CHILD = 'delivery/how-we-schedule/rollout-checklist.md';
const SYSTEMS = 'strategy/systems-map.md';

const hasFile = (page: Page, path: string) =>
  page.evaluate((p) => window.__cerebroMockFs.has(p), path);

/** Opens a page by title through Quick Open. */
async function openPage(page: Page, title: string) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill(title.toLowerCase());
  await page.getByTestId('quick-open-result').filter({ hasText: title }).first().click();
  await expect(page.getByTestId('doc-title')).toHaveText(title, { timeout: 10_000 });
}

/** The Pages tree's row for `path`. */
const treeRow = (page: Page, path: string): Locator =>
  page.getByTestId('file-tree').locator(`[data-testid="tree-row"][data-path="${path}"]`);

/** Open a folder in the Pages tree when it is folded. */
async function unfold(page: Page, name: string) {
  await showPages(page);
  const folder = page.getByTestId('file-tree').getByTestId('tree-folder').filter({ hasText: name });
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.click();
}

/** Expand a page row (a page with sub-pages) in the Pages tree when it is folded. */
async function expandPage(page: Page, title: string) {
  const expand = page.getByTestId('file-tree').getByRole('button', { name: `Expand ${title}` });
  if (await expand.isVisible()) await expand.click();
}

/** Drag `from` onto the middle of `to`, as dispatched events (DOM trap 6). */
async function dropOnMiddle(page: Page, from: Locator, to: Locator) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  const box = await to.boundingBox();
  if (box === null) throw new Error('no target row');
  const clientY = box.y + box.height / 2;
  // Held as a handle: the drop moves the row, so a locator would wait for it.
  const source = await from.elementHandle();
  if (source === null) throw new Error('no source row');
  await source.dispatchEvent('dragstart', { dataTransfer });
  await to.dispatchEvent('dragover', { dataTransfer, clientY });
  await to.dispatchEvent('drop', { dataTransfer, clientY });
  await source.dispatchEvent('dragend', { dataTransfer });
}

test('Add sub-page grows a page by rename, lists the child everywhere, and a drop nests', async ({
  page,
}) => {
  await boot(page);
  const original = await readMockFile(page, OLD);

  // -- Add sub-page --------------------------------------------------------
  await openPage(page, 'How we schedule');
  await page.getByTestId('doc-page').getByRole('button', { name: 'Page options' }).click();
  await page.getByRole('menuitem', { name: 'Add sub-page' }).click();
  await expect(
    page.getByText('"How we schedule" moves into a folder of its own. Its text does not change.'),
  ).toBeVisible();
  await page.getByPlaceholder('Page name').fill('Rollout checklist');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('doc-title')).toHaveText('Rollout checklist', { timeout: 10_000 });

  // Moved, not rewritten; the old path is gone.
  expect(await readMockFile(page, PARENT)).toBe(original);
  expect(await readMockFile(page, CHILD)).toBe('# Rollout checklist\n');
  expect(await hasFile(page, OLD)).toBe(false);

  // -- The Pages panel and the tree list it --------------------------------
  await expect(
    page.getByTestId('doc-pages-row').filter({ hasText: 'Rollout checklist' }),
  ).toBeVisible();
  await unfold(page, 'Delivery');
  await expandPage(page, 'How we schedule');
  await expect(treeRow(page, CHILD)).toBeVisible();

  // -- A /Sub-pages block in the parent lists it and opens it --------------
  await page.getByTestId('doc-pages-row').filter({ hasText: 'How we schedule' }).click();
  await expect(page.getByTestId('doc-title')).toHaveText('How we schedule');
  const editor = page.getByTestId('markdown-editor');
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await editor.locator('[data-content-type="paragraph"]').last().click();
  await page.keyboard.type('/sub-pages');
  await page
    .locator('#bn-suggestion-menu [role=option]')
    .filter({ hasText: 'Sub-pages' })
    .first()
    .click();
  const list = editor.getByTestId('sub-page-list');
  await expect(list.getByTestId('sub-page-row')).toHaveText(['Rollout checklist']);
  await expect
    .poll(() => readMockFile(page, PARENT), { timeout: 6_000 })
    .toContain('```cerebro-subpages\n```\n');
  const saved = await readMockFile(page, PARENT);
  await list.getByTestId('sub-page-row').click();
  await expect(page.getByTestId('doc-title')).toHaveText('Rollout checklist', { timeout: 10_000 });

  // -- Home and back: both pages read the same from the tree ---------------
  await openDestination(page, 'Home');
  await expect(page.getByTestId('doc-page')).toHaveCount(0);
  await showPages(page);
  await page
    .getByTestId('file-tree')
    .getByTestId('tree-doc')
    .filter({ hasText: 'How we schedule' })
    .click();
  await expect(page.getByTestId('doc-title')).toHaveText('How we schedule');
  await expect(page.getByTestId('markdown-editor').getByTestId('sub-page-row')).toHaveText(
    ['Rollout checklist'],
    { timeout: 10_000 },
  );
  expect(await readMockFile(page, PARENT)).toBe(saved);
  await treeRow(page, CHILD).getByTestId('tree-file').click();
  await expect(page.getByTestId('doc-title')).toHaveText('Rollout checklist');
  await expect(
    page.getByTestId('markdown-editor').getByRole('heading', { name: 'Rollout checklist' }),
  ).toBeVisible({ timeout: 10_000 });
  expect(await readMockFile(page, CHILD)).toBe('# Rollout checklist\n');

  // -- Dropping Systems map on the middle of Rollout checklist nests it -----
  const systemsBytes = await readMockFile(page, SYSTEMS);
  await unfold(page, 'Strategy');
  await dropOnMiddle(page, treeRow(page, SYSTEMS), treeRow(page, CHILD));
  const grown = 'delivery/how-we-schedule/rollout-checklist';
  await expect.poll(() => hasFile(page, `${grown}/systems-map.md`), { timeout: 6_000 }).toBe(true);
  expect(await readMockFile(page, `${grown}/systems-map.md`)).toBe(systemsBytes);
  expect(await readMockFile(page, `${grown}/rollout-checklist.md`)).toBe('# Rollout checklist\n');
  expect(await hasFile(page, SYSTEMS)).toBe(false);
  expect(await hasFile(page, CHILD)).toBe(false);
  // The open page followed its file.
  await expect(page.getByTestId('doc-title')).toHaveText('Rollout checklist');
  await expect(page.getByTestId('doc-pages-row').filter({ hasText: 'Systems map' })).toBeVisible();
});
