import { expect, test } from '@playwright/test';
import { boot, openDestination, readMockFile } from './boot';
import { chooseOption } from './select';

test('Inbox lends its queue to the context, reads a capture as a page, and hides its panel without replacing the editor', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await boot(page);
  await openDestination(page, 'Inbox');
  const navigation = page.getByTestId('page-navigation');
  const rows = navigation.getByTestId('inbox-row');
  await expect(rows.first()).toBeVisible();
  // The queue is its rows alone: no period pills and no count heading above
  // them — the sidebar's own "Inbox" heading names the list.
  await expect(navigation.getByRole('tablist')).toHaveCount(0);
  await expect(navigation.getByRole('listbox', { name: 'Captures' })).toBeVisible();
  await expect(page.getByTestId('inbox-page').getByRole('listbox')).toHaveCount(0);
  await rows.filter({ hasText: 'Warehouse cutover' }).click();
  // The capture is worked from the bar every page has, and nothing above it.
  const header = page.getByTestId('inbox-pane-header');
  await expect(header).toHaveClass('cb-document-toolbar');
  await expect(header).toContainText('Warehouse cutover needs a rollback rehearsal');
  await expect(page.getByTestId('inbox-page').getByRole('heading', { name: 'Inbox' })).toHaveCount(
    0,
  );
  const editor = page.getByTestId('markdown-editor');
  await expect(editor).toBeVisible();
  // Its H1 is projected as the page title, at the page-title role.
  await expect(editor.locator('[data-page-title] h1')).toHaveCSS('font-size', '40px');
  await editor.evaluate((node) => node.setAttribute('data-same-editor', 'yes'));
  const reader = page.getByTestId('capture-reader');
  const panel = page.getByTestId('doc-side-panel');
  await expect(panel).toBeVisible();
  // Details, its button pressed in the header, and no tab strip of its own.
  await expect(panel).toHaveAttribute('data-panel', 'details');
  const details = header.getByRole('button', { name: 'Details', exact: true });
  await expect(details).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByRole('tab')).toHaveCount(0);
  const before = (await reader.boundingBox())!.width;
  await details.click();
  await expect(panel).toHaveCount(0);
  expect((await reader.boundingBox())!.width).toBeGreaterThan(before + 250);
  await expect(editor).toHaveAttribute('data-same-editor', 'yes');
  await page.screenshot({ path: testInfo.outputPath('inbox-reader.png') });
  await details.click();
  await panel.getByRole('button', { name: /Mark organized/ }).click();
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

// Organize in the panel's one voice (owner, 2026-10-18): no native select
// anywhere, the Type value a ghost select in a property row, no checklist
// (owner, 2026-10-19), and the acts drawn as rows — Mark organized wearing
// its keys, and in the toolbar too, beside the star.
test('Organize reads as the panel: a ghost Type select and acts as rows', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await boot(page);
  await openDestination(page, 'Inbox');
  await page
    .getByTestId('page-navigation')
    .getByTestId('inbox-row')
    .filter({ hasText: 'Warehouse cutover' })
    .click();
  const panel = page.getByTestId('doc-side-panel');
  const organize = panel.locator('[data-section="organize"]');
  await expect(organize).toBeVisible();
  await expect(page.locator('select')).toHaveCount(0);

  // The Type row is a property row of the panel's pitch, its value a listbox
  // button that reads "No type" until one is chosen.
  const type = organize.getByRole('button', { name: 'Type', exact: true });
  await expect(type).toHaveAttribute('aria-haspopup', 'listbox');
  await expect(type).toHaveText('No type');
  const typeRow = organize.locator('[data-testid="property-row"][data-property="Type"]');
  await expect(typeRow.getByRole('button', { name: 'Type', exact: true })).toHaveCount(1);
  expect((await typeRow.boundingBox())!.height).toBe(30);

  // No checklist grades the capture (owner, 2026-10-19), and no paragraph
  // explains the section.
  await expect(organize).not.toContainText('Checklist');
  await expect(organize).not.toContainText('Before you file');
  await expect(organize).not.toContainText('removes it from the Inbox');

  // The acts are rows; Mark organized carries its keys, in the panel and in
  // the toolbar's tooltip.
  const acts = organize.getByRole('group', { name: 'File this capture' });
  await expect(acts.getByRole('button', { name: 'Mark organized', exact: true })).toHaveAttribute(
    'data-tone',
    'primary',
  );
  await expect(acts.locator('[data-keys]')).toHaveAttribute('data-keys', 'mod+e');
  await page
    .getByTestId('inbox-pane-header')
    .getByRole('button', { name: 'Mark organized', exact: true })
    .hover();
  const tip = page.getByRole('tooltip');
  await expect(tip).toContainText('Mark organized');
  await expect(tip.locator('[data-keys]')).toHaveAttribute('data-keys', 'mod+e');
  await page.mouse.move(800, 500);
  await expect(tip).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('inbox-organize-untyped.png') });

  // Choosing a type through the select writes it.
  await chooseOption(type, 'Work item');
  await expect
    .poll(() => readMockFile(page, 'inbox/warehouse-cutover-thought.md'))
    .toContain('type: Work item');
  await expect(type).toHaveAttribute('data-value', 'Work item');
  await page.screenshot({ path: testInfo.outputPath('inbox-organize-typed.png') });
  await page.getByTestId('app-rail').getByRole('button', { name: /theme/i }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: testInfo.outputPath('inbox-organize-dark.png') });
});

test('narrow Inbox exposes its capture drawer, closes on selection, and keeps j/k on the owning pane', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await boot(page);
  await openDestination(page, 'Inbox');
  const captures = page.getByTestId('page-navigation').getByTestId('inbox-row');
  // The toolbar's "Inbox" crumb is the way to the captures the sidebar holds.
  const header = page.getByTestId('inbox-pane-header');
  const show = header.getByRole('button', { name: 'Inbox', exact: true });
  await show.click();
  await expect(captures.first()).toBeVisible();
  await captures.first().click();
  await expect(page.getByTestId('sidebar')).toBeHidden();
  await expect(show).toBeFocused();
  await show.click();
  await captures.first().focus();
  const nextTitle = await captures.nth(1).locator('[title]').first().getAttribute('title');
  await page.keyboard.press('j');
  await expect(header).toContainText(nextTitle!);
  await expect(captures.nth(1)).toBeFocused();
  // A nested palette still owns typing; the page drawer's nonmodal keys do
  // not leak into either the reader or a menu opened over it.
  const before = await readMockFile(page, (await captures.nth(1).getAttribute('data-path'))!);
  await page.keyboard.press('ControlOrMeta+b');
  expect(await readMockFile(page, (await captures.nth(1).getAttribute('data-path'))!)).toBe(before);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('j');
  await expect(header).toContainText(nextTitle!);
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
  // With no room beside the reader the inspector folds, and opens as a
  // drawer over it that Escape closes.
  await page.setViewportSize({ width: 640, height: 800 });
  const panel = page.getByTestId('doc-side-panel');
  await expect(panel).toHaveCount(0);
  await header.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(panel).toHaveAttribute('data-overlay', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(640);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
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

// The Inbox's panel folds by the row it shares with the reader, read the
// same way whichever pane is active: taking the keyboard to the other pane
// must not fold it, re-open it as a drawer, or pull focus back to it.
test('the Inbox panel stays docked when the pane beside takes the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  await boot(page);
  await openDestination(page, 'Inbox');
  await page
    .getByTestId('page-navigation')
    .getByTestId('inbox-row')
    .filter({ hasText: 'Warehouse cutover' })
    .click();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Systems map');
  await expect(
    page.getByTestId('quick-open-result').filter({ hasText: 'Systems map' }).first(),
  ).toBeVisible();
  await page.keyboard.press('Shift+Enter');
  const panes = page.getByTestId('pane');
  await expect(panes).toHaveCount(2);
  const inbox = panes.first();
  const beside = panes.nth(1);
  // The person's word on the Inbox panel: hidden, then shown again.
  const header = inbox.getByTestId('inbox-pane-header');
  const details = header.getByRole('button', { name: 'Details', exact: true });
  await details.click();
  await expect(details).toHaveAttribute('aria-pressed', 'false');
  await details.click();
  const panel = inbox.getByTestId('doc-side-panel');
  await expect(panel).toBeVisible();
  await expect(inbox).toHaveAttribute('data-active', 'true');

  const title = beside.getByTestId('markdown-editor').locator('[data-page-title] h1');
  await title.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' typed beside');
  await expect(beside).toHaveAttribute('data-active', 'true');
  await expect(title).toHaveText('Systems map typed beside');
  await expect(panel).toBeVisible();
  await expect(panel).not.toHaveAttribute('data-overlay', 'true');
  await expect(inbox.getByTestId('inbox-drawer-scrim')).toHaveCount(0);
});
