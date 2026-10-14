import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile } from './boot';

/**
 * Page icon and cover (M55.11). A page's own icon shows wherever the page is
 * named (its header, the tree, its Pages panel row, the crumb and ⌘K), its
 * bytes round-trip, and nothing is written by showing it: opening and closing
 * a picker, and saving the body, leave the block as it was. Remove gives back
 * exactly the page it was.
 *
 * Built through the tree only (New folder, then "New page in Launch" twice),
 * never the page menu.
 */

const ROCKET = '\u{1F680}';
const PAGE = 'launch/checklist.md';
const WITH_ICON = `---\nicon: ${ROCKET}\n---\n# Checklist\n`;

async function createInTree(page: Page, opener: string, placeholder: string, name: string) {
  await page.getByRole('button', { name: opener, exact: true }).click();
  await page.getByPlaceholder(placeholder).fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
}

async function setRocket(page: Page) {
  await page.getByTestId('page-chrome-add').hover();
  await page.getByTestId('page-add-icon').click();
  await page.getByLabel('Emoji', { exact: true }).fill(ROCKET);
  await page.getByLabel('Emoji', { exact: true }).press('Enter');
  await expect.poll(() => readMockFile(page, PAGE), { timeout: 5_000 }).toBe(WITH_ICON);
}

const rocketIn = (scope: ReturnType<Page['getByTestId']>) =>
  scope.getByRole('img', { name: ROCKET });

test('a page icon shows everywhere the page is named, and its bytes round-trip', async ({
  page,
}) => {
  await boot(page);

  // -- A doc with a sub-page, through the tree -----------------------------
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByPlaceholder('Folder name').fill('Launch');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Launch', exact: true })).toBeVisible();
  await createInTree(page, 'New page in Launch', 'Page name', 'Launch');
  // The folder note: the doc's main page, which the doc crumb names.
  await expect(page.getByRole('heading', { name: 'Launch', level: 1 })).toBeVisible({
    timeout: 10_000,
  });
  await createInTree(page, 'New page in Launch', 'Page name', 'Checklist');
  await expect(page.getByTestId('doc-title')).toHaveText('Checklist');
  await expect(page.getByTestId('markdown-editor')).toBeVisible({ timeout: 10_000 });
  expect(await readMockFile(page, PAGE)).toBe('# Checklist\n');

  // -- Set it, and it shows on every surface that names the page ----------
  await setRocket(page);
  await expect(rocketIn(page.getByTestId('page-icon'))).toBeVisible();
  await expect(
    rocketIn(
      page.getByTestId('file-tree').getByTestId('tree-file').filter({ hasText: 'Checklist' }),
    ),
  ).toBeVisible();
  await expect(
    rocketIn(page.getByTestId('doc-pages-row').filter({ hasText: 'Checklist' })),
  ).toBeVisible();
  await expect(rocketIn(page.getByTestId('doc-title'))).toBeVisible();

  // ⌘K, with focus outside the editor.
  await page.getByTestId('doc-title').click();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Checklist');
  await expect(
    rocketIn(page.getByTestId('quick-open-result').filter({ hasText: 'Checklist' }).first()),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('quick-open-input')).toBeHidden();

  // -- Remove gives back exactly the page it was --------------------------
  await page.getByTestId('page-icon').click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect.poll(() => readMockFile(page, PAGE), { timeout: 5_000 }).toBe('# Checklist\n');
  await expect(page.getByTestId('page-icon')).toBeHidden();

  // -- Set again; a body edit keeps the block byte-identical --------------
  await setRocket(page);
  const editor = page.locator('[data-testid="markdown-editor"] .bn-editor');
  await editor.getByText('Checklist').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Pack the boxes.');
  await expect
    .poll(() => readMockFile(page, PAGE), { timeout: 5_000 })
    .toContain('Pack the boxes.');
  const afterEdit = await readMockFile(page, PAGE);
  expect(afterEdit.startsWith(`---\nicon: ${ROCKET}\n---\n`)).toBe(true);

  // -- Opening and closing a picker changes no byte -----------------------
  await page.getByTestId('page-icon').click();
  await expect(page.getByTestId('page-icon-picker')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('page-icon-picker')).toBeHidden();
  await page.getByTestId('page-chrome-add').hover();
  await page.getByTestId('page-add-cover').click();
  await expect(page.getByTestId('page-cover-picker')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('page-cover-picker')).toBeHidden();
  expect(await readMockFile(page, PAGE)).toBe(afterEdit);

  // -- Add cover Blue writes the colour name and leaves the icon alone ----
  await page.getByTestId('page-chrome-add').hover();
  await page.getByTestId('page-add-cover').click();
  await page.getByRole('button', { name: 'Blue', exact: true }).click();
  await expect
    .poll(() => readMockFile(page, PAGE), { timeout: 5_000 })
    .toBe(afterEdit.replace(`icon: ${ROCKET}\n`, `icon: ${ROCKET}\ncover: blue\n`));
  await expect(page.getByTestId('page-cover')).toBeVisible();
});
