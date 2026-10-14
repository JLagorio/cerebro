import { expect, test, type Page } from '@playwright/test';
import { boot } from './boot';

/**
 * Open with (M55.9). In the browser the copies work and the desktop doors
 * say they need the app. The copy that matters most: a prompt built a moment
 * after typing holds what was typed, because the open pages flush first, and
 * "Prompt copied" shows only once the clipboard holds it.
 */

const PAGE = 'delivery/how-we-schedule.md';
const BODY = ['# How we schedule', '', 'We ship on Thursdays, after the freeze.', ''].join('\n');

/** Open the page from the sidebar, expanding its collection only if it is folded. */
async function openSchedule(page: Page): Promise<void> {
  const node = page.getByTestId('collection-node-doc').filter({ hasText: 'How we schedule' });
  if (!(await node.isVisible()))
    await page.getByRole('button', { name: 'Expand Delivery' }).click();
  await node.getByRole('button', { name: 'How we schedule' }).click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible({ timeout: 10_000 });
}

async function openWith(page: Page): Promise<void> {
  await page.getByTestId('doc-page').getByRole('button', { name: 'Open with' }).click();
  await expect(page.getByRole('menu', { name: 'Open with' })).toBeVisible();
}

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

test('Open with copies the page as typed a moment ago, and its path', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await boot(page);
  await page.evaluate(([path, md]) => window.__cerebroMockFs.set(path, md), [PAGE, BODY]);
  await openSchedule(page);

  // Typed, then copied at once: inside the save debounce.
  await page.getByTestId('markdown-editor').getByText('We ship on Thursdays').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Typed just before copying.');
  await openWith(page);
  await page.getByTestId('open-with-copy-prompt').click();

  await expect(page.getByText('Prompt copied')).toBeVisible();
  const prompt = await clipboard(page);
  expect(prompt).toContain('Typed just before copying.');
  expect(prompt).toContain(`Path: ${PAGE}`);
  expect(prompt).toContain('Use this page from my Cerebro notes as context.');

  await openWith(page);
  await page.getByTestId('open-with-copy-path').click();
  await expect(page.getByText('Path copied')).toBeVisible();
  expect(await clipboard(page)).toBe(PAGE);
});

test('Open with disables the desktop doors in the browser', async ({ page }) => {
  await boot(page);
  await page.evaluate(([path, md]) => window.__cerebroMockFs.set(path, md), [PAGE, BODY]);
  await openSchedule(page);
  await openWith(page);
  for (const id of [
    'open-with-reveal',
    'open-with-default-editor',
    'open-with-agent-claude-code-web',
    'open-with-agent-codex',
    'open-with-agent-cursor',
    'open-with-agent-zed',
  ]) {
    const item = page.getByTestId(id);
    await expect(item, id).toBeDisabled();
    await expect(item, id).toContainText('Desktop app only');
  }
  await expect(page.getByTestId('open-with-copy-prompt')).toBeEnabled();
});
