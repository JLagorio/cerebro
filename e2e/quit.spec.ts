import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile } from './boot';

/**
 * Quitting saves first (M55.10).
 *
 * ⌘Q, the close button and ⌘W ask the webview before the app exits. The mock
 * asks through `window.__cerebroMockQuit`, as `cerebro://quit-requested` does
 * in the app, and logs the webview's answer in `__cerebroMockQuitLog`. Only a
 * packaged build proves the Rust half: the menu item, the close guard and the
 * deadline.
 */

const PAGE = 'delivery/how-we-schedule.md';
/** A demo page with no H1: the title heading stands in for one. */
const UNTITLED = 'inbox/crew-lead-quote-worth-keeping.md';

/** Ask to quit, reading `path` off the mock disk in the same turn. */
async function quitReading(page: Page, path: string): Promise<string | undefined> {
  return page.evaluate((p) => {
    const before = window.__cerebroMockFs.get(p);
    window.__cerebroMockQuit();
    return before;
  }, path);
}

async function expectFinished(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => [...window.__cerebroMockQuitLog]))
    .toEqual(['finished']);
  await expect(page.getByTestId('quit-screen')).toBeVisible();
}

test('quit saves a line typed inside the save debounce', async ({ page }) => {
  await boot(page);
  const node = page.getByTestId('collection-node-doc').filter({ hasText: 'How we schedule' });
  if (!(await node.isVisible()))
    await page.getByRole('button', { name: 'Expand Delivery' }).click();
  await node.getByRole('button', { name: 'How we schedule' }).click();
  const editor = page.getByTestId('markdown-editor');
  await expect(editor).toBeVisible({ timeout: 10_000 });

  await editor.locator('.bn-editor').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('quit-probe-1');
  const before = await quitReading(page, PAGE);

  // Still inside the 500 ms debounce: nothing had saved it yet.
  expect(before).toBeDefined();
  expect(before).not.toContain('quit-probe-1');
  await expectFinished(page);
  expect(await readMockFile(page, PAGE)).toContain('quit-probe-1');
});

test('quit commits an untitled heading typed without Enter or blur', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('crew lead quote');
  await page
    .getByTestId('quick-open-result')
    .filter({ hasText: /crew lead quote/i })
    .first()
    .click();
  const heading = page.getByTestId('doc-title-heading');
  await expect(heading).toBeVisible({ timeout: 10_000 });

  await heading.fill('Rosa on the offline problem');
  await expect(page.getByTestId('markdown-editor').locator('.bn-editor')).toBeFocused();
  const before = await quitReading(page, UNTITLED);

  expect(before).not.toContain('# Rosa on the offline problem');
  await expectFinished(page);
  expect(await readMockFile(page, UNTITLED)).toContain('# Rosa on the offline problem');
});
