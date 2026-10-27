import { expect, test, type Page } from '@playwright/test';
import { boot, seedFileBeforeBoot, readMockFile, openDestination, holdClock } from './boot';
const PATH = 'notes/source-page.md';
async function open(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Source page');
  await page.getByTestId('quick-open-result').filter({ hasText: 'Source page' }).first().click();
  await expect(page.getByRole('button', { name: 'Source', exact: true })).toBeEnabled();
}
test('source edits retain exact BOM, metadata fence, CRLF and unsupported spans', async ({
  page,
}, info) => {
  const raw =
    '\ufeff---\r\ntype: Doc\r\n--- \t\r\n\r\n# Source page\r\n\r\n<div>keep😀</div>\r\nlast\r\n';
  await seedFileBeforeBoot(page, PATH, raw);
  await boot(page);
  await open(page);
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Page source' });
  await expect(source).toBeVisible();
  expect(await readMockFile(page, PATH)).toBe(raw);
  await source.fill('\n# Source page\n\n<div>keep😀</div>\nchanged\n');
  await expect.poll(() => readMockFile(page, PATH)).toBe(raw.replace('last', 'changed'));
  await page.getByRole('button', { name: 'Rich text', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'cannot be represented' })).toBeVisible();
  await expect(source).toBeVisible();
  expect(await readMockFile(page, PATH)).toBe(raw.replace('last', 'changed'));
  await page.screenshot({ path: info.outputPath('source-preserved.png'), animations: 'disabled' });
});
test('mode switches preserve chrome, write nothing, and clean reopen reads current source', async ({
  page,
}) => {
  const raw = '# Source page\r\n\r\nBody stays.\r\n';
  await seedFileBeforeBoot(page, PATH, raw);
  await boot(page);
  await open(page);
  await holdClock(page);
  const writesBefore = await page.evaluate(
    (path) => window.__cerebroMockWrites.filter((write) => write.path === path).length,
    PATH,
  );
  const chrome = page.getByTestId('page-editor-chrome');
  await chrome.evaluate((node) => {
    (window as unknown as { sourceChrome: Element }).sourceChrome = node;
  });
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Page source' })).toBeVisible();
  expect(
    await chrome.evaluate(
      (node) => node === (window as unknown as { sourceChrome: Element }).sourceChrome,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Rich text', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Page source' })).toHaveCount(0);
  // Advance beyond the shared 500ms debounce; no-op mode events must not
  // mark the page unsaved or schedule a delayed normalization write.
  await page.clock.runFor(1_000);
  await expect(page.getByTestId('doc-save-state')).toHaveCount(0);
  expect(
    await page.evaluate(
      (path) => window.__cerebroMockWrites.filter((write) => write.path === path).length,
      PATH,
    ),
  ).toBe(writesBefore);
  expect(await readMockFile(page, PATH)).toBe(raw);
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Page source' })).toBeVisible();
  await openDestination(page, 'Home');
  await page.evaluate(
    ([path, text]) => window.__cerebroMockFs.set(path, text),
    [PATH, raw.replace('Body stays.', 'Outside current.')],
  );
  await open(page);
  await expect(page.getByRole('textbox', { name: 'Page source' })).toHaveValue(
    '# Source page\n\nOutside current.\n',
  );
  expect(await readMockFile(page, PATH)).toBe(raw.replace('Body stays.', 'Outside current.'));
});
