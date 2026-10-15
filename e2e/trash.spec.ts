import { expect, test, type Locator, type Page } from '@playwright/test';
import { boot, readMockFile } from './boot';

/**
 * The vault's own Trash (M60.8), on the mock backend. A page deleted from the
 * Pages tree moves, byte for byte and with its comments, to
 * `.trash/<stamp>/`, where ⌘K's page text no longer finds it; Settings →
 * Recently deleted brings it back byte for byte; and a page made at that path
 * meanwhile makes Restore refuse, both files left as they are. The launch
 * purge into the macOS Trash is the packaged check's.
 */

const PAGE = 'delivery/how-we-schedule.md';
const TITLE = 'How we schedule';
const WORD = 'Quillmarrow';
const BYTES = ['# How we schedule', '', `We ship on Thursdays. ${WORD} stays on.`, ''].join('\n');
const SIDECAR_PATH = `.comments/${PAGE}.json`;
const SIDECAR = `${JSON.stringify(
  {
    format: 1,
    threads: [
      {
        comments: [
          {
            id: '0123456789abcdef',
            author: 'human:owner',
            created: '2026-10-12T08:00:00Z',
            body: 'Keep the freeze.',
          },
        ],
      },
    ],
  },
  null,
  2,
)}\n`;

const keys = (page: Page) => page.evaluate(() => [...window.__cerebroMockFs.keys()]);
const has = (page: Page, path: string) => page.evaluate((p) => window.__cerebroMockFs.has(p), path);

/** The one stamp dir in the mock Trash holding `path`. */
async function stampOf(page: Page, path: string): Promise<string> {
  const found = (await keys(page)).filter((k) => k.startsWith('.trash/') && k.endsWith(`/${path}`));
  expect(found).toHaveLength(1);
  return found[0].split('/')[1];
}

const treeRow = (page: Page, path: string): Locator =>
  page.getByTestId('file-tree').locator(`[data-testid="tree-row"][data-path="${path}"]`);

async function unfold(page: Page, name: string) {
  const folder = page.getByTestId('file-tree').getByTestId('tree-folder').filter({ hasText: name });
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.click();
}

async function deleteFromTree(page: Page) {
  await unfold(page, 'Delivery');
  await treeRow(page, PAGE).getByTestId('tree-file').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Trash' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('It moves to the Trash.');
  await expect(dialog).toContainText('Restore from Settings → Recently deleted for 30 days.');
  await dialog.getByRole('button', { name: 'Move to Trash' }).click();
  await expect.poll(() => has(page, PAGE)).toBe(false);
}

/** ⌘K's In pages rows for `word`, once the page-text search has answered. */
async function pageTextHits(page: Page, word: string): Promise<number> {
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByTestId('quick-open-input');
  await expect(input).toBeVisible();
  await input.fill(word);
  await page.waitForTimeout(600);
  const hits = await page.getByTestId('quick-open-content-result').count();
  await page.keyboard.press('Escape');
  await expect(input).toBeHidden();
  return hits;
}

test('a deleted page waits in the vault Trash and Settings restores it byte for byte', async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(
    ([p, b, s, sc]) => {
      window.__cerebroMockFs.set(p, b);
      window.__cerebroMockFs.set(s, sc);
    },
    [PAGE, BYTES, SIDECAR_PATH, SIDECAR],
  );
  expect(await pageTextHits(page, WORD)).toBeGreaterThan(0);

  // -- Delete from the tree ------------------------------------------------
  await deleteFromTree(page);
  await expect(page.getByTestId('toast-host')).toContainText(`Moved “${TITLE}” to Trash`);
  const stamp = await stampOf(page, PAGE);
  expect(await readMockFile(page, `.trash/${stamp}/${PAGE}`)).toBe(BYTES);
  expect(await readMockFile(page, `.trash/${stamp}/${SIDECAR_PATH}`)).toBe(SIDECAR);
  expect(await readMockFile(page, `.trash/${stamp}/.trashed.json`)).toContain(`"path": "${PAGE}"`);
  expect(await has(page, SIDECAR_PATH)).toBe(false);
  // Search never sees the Trash.
  expect(await pageTextHits(page, WORD)).toBe(0);

  // -- Settings → Recently deleted → Restore -------------------------------
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Settings' }).click();
  const section = page.getByTestId('settings-trash');
  await expect(section).toContainText('Recently deleted');
  const row = section.getByTestId('trash-item');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(TITLE);
  await row.getByTestId('trash-restore').click();
  await expect(section.getByTestId('trash-empty')).toHaveText('Nothing in the Trash.');
  await expect(page.getByTestId('toast-host')).toContainText(`Restored “${TITLE}”`);
  expect(await readMockFile(page, PAGE)).toBe(BYTES);
  expect(await readMockFile(page, SIDECAR_PATH)).toBe(SIDECAR);
  expect((await keys(page)).some((k) => k.startsWith(`.trash/${stamp}/`))).toBe(false);
  expect(await pageTextHits(page, WORD)).toBeGreaterThan(0);

  // -- A page made at that path meanwhile makes Restore refuse --------------
  await deleteFromTree(page);
  const again = await stampOf(page, PAGE);
  const other = '# Someone else\n';
  await page.evaluate(([p, b]) => window.__cerebroMockFs.set(p, b), [PAGE, other]);
  await expect(section.getByTestId('trash-item')).toHaveCount(1);
  await section.getByTestId('trash-restore').click();
  await expect(page.getByTestId('toast-host')).toContainText(
    `${PAGE} already exists, so nothing was restored. Move or rename that page first.`,
  );
  expect(await readMockFile(page, PAGE)).toBe(other);
  expect(await readMockFile(page, `.trash/${again}/${PAGE}`)).toBe(BYTES);
  await expect(section.getByTestId('trash-item')).toHaveCount(1);
});
