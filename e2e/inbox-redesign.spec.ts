import { expect, test } from '@playwright/test';
import { boot, openDestination, readMockFile } from './boot';

test('Inbox lends its queue to the context, keeps a wide reader, and folds Organize without replacing the editor', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await boot(page);
  await openDestination(page, 'Inbox');
  const navigation = page.getByTestId('page-navigation');
  const rows = navigation.getByTestId('inbox-row');
  await expect(navigation.getByRole('tablist', { name: 'Capture period' })).toBeVisible();
  await expect(rows.first()).toBeVisible();
  await expect(page.getByTestId('inbox-page').getByRole('listbox')).toHaveCount(0);
  await rows.filter({ hasText: 'Warehouse cutover' }).click();
  const editor = page.getByTestId('markdown-editor');
  await expect(editor).toBeVisible();
  await expect(editor.locator('h1').first()).toHaveCSS('font-size', '32px');
  await editor.evaluate((node) => node.setAttribute('data-same-editor', 'yes'));
  const reader = page.getByTestId('capture-reader');
  const before = (await reader.boundingBox())!.width;
  await page.getByRole('button', { name: 'Organize', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Organize' })).toBeHidden();
  expect((await reader.boundingBox())!.width).toBeGreaterThan(before + 250);
  await expect(editor).toHaveAttribute('data-same-editor', 'yes');
  await page.screenshot({ path: testInfo.outputPath('inbox-reader.png') });
  await page.getByRole('button', { name: 'Organize', exact: true }).click();
  await page.getByRole('button', { name: /Mark organized/ }).click();
  await expect
    .poll(() => readMockFile(page, 'inbox/warehouse-cutover-thought.md'))
    .toContain('_organized: true');
  await page.getByTestId('inbox-undo').getByRole('button', { name: 'Undo' }).click();
  await expect(rows.filter({ hasText: 'Warehouse cutover' })).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('inbox-organize.png') });
  await page.getByTestId('app-rail').getByRole('button', { name: /theme/i }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: testInfo.outputPath('inbox-dark.png') });
});

test('narrow Inbox exposes its capture drawer, closes on selection, and keeps j/k on the owning pane', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await boot(page);
  await openDestination(page, 'Inbox');
  const captures = page.getByTestId('page-navigation').getByTestId('inbox-row');
  const show = page.getByRole('button', { name: 'Captures', exact: true });
  await show.click();
  await expect(captures.first()).toBeVisible();
  await captures.first().click();
  await expect(page.getByTestId('sidebar')).toBeHidden();
  await expect(show).toBeFocused();
  await show.click();
  await captures.first().focus();
  const nextTitle = await captures.nth(1).locator('[title]').first().getAttribute('title');
  await page.keyboard.press('j');
  await expect(page.getByTestId('inbox-pane-header')).toContainText(nextTitle!);
  await expect(captures.nth(1)).toBeFocused();
  // A nested palette still owns typing; the page drawer's nonmodal keys do
  // not leak into either the reader or a menu opened over it.
  const before = await readMockFile(page, (await captures.nth(1).getAttribute('data-path'))!);
  await page.keyboard.press('ControlOrMeta+b');
  expect(await readMockFile(page, (await captures.nth(1).getAttribute('data-path'))!)).toBe(before);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('j');
  await expect(page.getByTestId('inbox-pane-header')).toContainText(nextTitle!);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: testInfo.outputPath('inbox-narrow-queue.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('sidebar')).toBeHidden();
  await expect(show).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(900);
  await page.screenshot({ path: testInfo.outputPath('inbox-narrow-reader.png') });
  await page.getByTestId('app-rail').getByRole('button', { name: /theme/i }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: testInfo.outputPath('inbox-narrow-dark.png') });
  await page.setViewportSize({ width: 640, height: 800 });
  await expect(page.getByRole('complementary', { name: 'Organize' })).toBeHidden();
  await page.getByRole('button', { name: 'Organize', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Organize' })).toHaveAttribute(
    'data-overlay',
    'true',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(640);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary', { name: 'Organize' })).toBeHidden();
});

test('only the active Inbox pane supplies the queue and receives its navigation keys', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await boot(page);
  await openDestination(page, 'Inbox');
  const target = page.getByTestId('page-navigation');
  const rows = target.getByTestId('inbox-row');
  await rows.filter({ hasText: 'Warehouse cutover' }).click();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Systems map');
  await expect(
    page.getByTestId('quick-open-result').filter({ hasText: 'Systems map' }).first(),
  ).toBeVisible();
  await page.keyboard.press('Shift+Enter');
  const panes = page.getByTestId('pane');
  await expect(panes).toHaveCount(2);
  await expect(panes.nth(1)).toHaveAttribute('data-active', 'true');
  await expect(target).toBeHidden();
  const otherLabel = await panes.nth(1).getByTestId('pane-bar').innerText();
  // Activating an inactive pane from its local queue must preserve that
  // click while the queue moves back into the shared sidebar.
  await panes.first().getByTestId('inbox-row').first().click();
  await expect(rows.first()).toBeVisible();
  await expect(panes.first().getByTestId('inbox-pane-header')).toContainText('1 of');
  await rows.first().click();
  await rows.first().focus();
  const next = await rows.nth(1).locator('[title]').first().getAttribute('title');
  await page.keyboard.press('j');
  await expect(panes.first().getByTestId('inbox-pane-header')).toContainText(next!);
  await expect(panes.nth(1).getByTestId('pane-bar')).toHaveText(otherLabel);
  await expect(panes.first()).toHaveAttribute('data-active', 'true');
});
