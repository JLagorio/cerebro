import { expect, test, type Page } from '@playwright/test';
import YAML from 'yaml';
import { boot, readMockFile } from './boot';

/**
 * The keymap (M65.1): one capture-phase listener, scopes and editor claims,
 * on the mock backend. ⌘K reaches the app from inside a mermaid source box,
 * a mermaid block's ⌘Z undoes the block and never the app's last batch, ⌘J
 * works while typing, ⌘[ leaves a page only from outside its text, and the
 * Inbox's ⌘E files the open capture but never from inside its body.
 */

const SYSTEMS_MAP = 'strategy/systems-map.md';
const TYPE_DOC = 'types/work-item.md';

const frontmatterOf = (text: string): Record<string, unknown> => {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text);
  return (block === null ? {} : YAML.parse(block[1])) as Record<string, unknown>;
};

/** Open a page through the palette, which ⌘K raises from anywhere. */
async function openByName(page: Page, name: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByTestId('quick-open-input');
  await expect(input).toBeVisible();
  await input.fill(name);
  await page.getByTestId('quick-open-result').filter({ hasText: name }).first().click();
  await expect(page.getByTestId('doc-title')).toHaveText(name);
}

async function openSystemsMap(page: Page): Promise<void> {
  await openByName(page, 'Systems map');
  await expect(
    page.getByTestId('mermaid-diagram').first().locator('svg[id^="cerebro-mermaid-"]'),
  ).toBeVisible({ timeout: 30_000 });
}

/** Focus on <body>, as WKWebView leaves it after a click on a button. */
async function blurToBody(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
}

test('⌘K from a focused mermaid source box opens the palette', async ({ page }) => {
  test.setTimeout(60_000);
  await boot(page);
  await openSystemsMap(page);
  const block = page.getByTestId('mermaid-block').first();
  await block.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByTestId('structural-host').locator('svg').first().waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Show code' }).click();
  const source = page.getByLabel('Mermaid source');
  await source.focus();
  await expect(source).toBeFocused();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByTestId('quick-open-input')).toBeVisible();
});

test("a mermaid block's ⌘Z, with focus left on body, undoes the block and not the last batch", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await boot(page);

  // -- An undoable batch first: rename a Work item column -----------------
  await page.getByTestId('sidebar-type').filter({ hasText: 'Work item' }).first().click();
  await expect(page.getByTestId('table-row').first()).toBeVisible();
  await page.getByRole('button', { name: 'Estimate column menu' }).click();
  const rename = page.getByLabel('Rename Estimate');
  await rename.fill('Size points');
  await rename.press('Enter');
  const fields = async () =>
    Object.keys(frontmatterOf(await readMockFile(page, TYPE_DOC)).fields ?? {});
  await expect.poll(fields).toContain('size_points');

  // -- Then a node added in a mermaid block -------------------------------
  await openSystemsMap(page);
  const block = page.getByTestId('mermaid-block').first();
  await block.getByRole('button', { name: 'Edit', exact: true }).click();
  const host = page.getByTestId('structural-host');
  await host.locator('svg').first().waitFor({ timeout: 15_000 });
  await block.getByRole('button', { name: '+ Node' }).click();
  await expect
    .poll(() => readMockFile(page, SYSTEMS_MAP), { timeout: 15_000 })
    .toContain('New step');

  // -- ⌘Z from body: the node goes, the rename stays ----------------------
  await blurToBody(page);
  await page.keyboard.press('ControlOrMeta+z');
  await expect
    .poll(() => readMockFile(page, SYSTEMS_MAP), { timeout: 15_000 })
    .not.toContain('New step');
  expect(await fields()).toContain('size_points');
});

test('⌘J toggles the assistant while typing in a page', async ({ page }) => {
  test.setTimeout(60_000);
  await boot(page);
  await openByName(page, 'Systems map');
  const paragraph = page.locator('.bn-editor [data-content-type="paragraph"]').first();
  await paragraph.click();
  await page.keyboard.type('still typing');
  await page.keyboard.press('ControlOrMeta+j');
  await expect(page.getByTestId('ai-panel-frame')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+j');
  await expect(page.getByTestId('ai-panel-frame')).toHaveCount(0);
});

test('⌘[ in a page body stays put, and from outside its text goes back', async ({ page }) => {
  test.setTimeout(60_000);
  await boot(page);
  const home = await page.title();
  await openByName(page, 'Systems map');
  await page.locator('.bn-editor [data-content-type="paragraph"]').first().click();
  await page.keyboard.press('ControlOrMeta+[');
  await expect(page.getByTestId('doc-title')).toHaveText('Systems map');
  await blurToBody(page);
  await page.keyboard.press('ControlOrMeta+[');
  await expect(page.getByTestId('doc-title')).toHaveCount(0);
  await expect.poll(() => page.title()).toBe(home);
});

test('Inbox ⌘E files the open capture, and never while typing in its body', async ({ page }) => {
  test.setTimeout(60_000);
  await boot(page);
  await page
    .getByTestId('nav-surfaces')
    .getByRole('button', { name: /^Inbox/ })
    .click();
  await expect(page.getByTestId('inbox-page')).toBeVisible();
  const PATH = 'inbox/warehouse-cutover-thought.md';
  const row = page.getByTestId('inbox-row').filter({ hasText: 'Warehouse cutover' });
  await row.click();
  await expect(page.getByLabel('Organize')).toBeVisible();

  // -- In the body, ⌘E is the editor's ----------------------------------
  await page
    .getByTestId('inbox-page')
    .locator('.bn-editor [data-content-type="paragraph"]')
    .first()
    .click();
  await page.keyboard.press('ControlOrMeta+e');
  // Give a wrongly filed capture time to land before saying it did not.
  await page.waitForTimeout(500);
  expect(await readMockFile(page, PATH)).not.toContain('_organized: true');

  // -- From the list, ⌘E files it ----------------------------------------
  await row.click();
  await page.keyboard.press('ControlOrMeta+e');
  await expect.poll(() => readMockFile(page, PATH)).toContain('_organized: true');
});

test('g chords navigate, wait before hinting, swallow a hinted miss, and pass Escape', async ({
  page,
}, testInfo) => {
  await boot(page);
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'My work' }).click();
  await blurToBody(page);
  await page.keyboard.press('g');
  await page.keyboard.press('h');
  await expect(page).toHaveTitle('Home — Cerebro');
  await page.evaluate(() => {
    document.body.dataset.lastChordMiss = '';
    document.body.addEventListener('keydown', (event) => {
      document.body.dataset.lastChordMiss = event.key;
    });
  });
  await page.keyboard.press('g');
  await page.waitForTimeout(300);
  await expect(page.getByTestId('chord-hint')).toBeVisible();
  await expect(page.getByTestId('chord-hint').getByText('Home', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('go-chord-hint.png'), animations: 'disabled' });
  await page.keyboard.press('x');
  await expect(page.getByTestId('chord-hint')).toHaveCount(0);
  expect(await page.locator('body').getAttribute('data-last-chord-miss')).toBe('');
  await page.keyboard.press('g');
  await expect(page.getByTestId('chord-hint')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('chord-hint')).toHaveCount(0);
  expect(await page.locator('body').getAttribute('data-last-chord-miss')).toBe('Escape');
});

test('g h typed into a page stays text, and Save and Find use the keymap', async ({ page }) => {
  await boot(page);
  await openByName(page, 'How we schedule');
  const paragraph = page.locator('.bn-editor [data-content-type="paragraph"]').first();
  await paragraph.click();
  await page.keyboard.type('gh');
  await expect(page.getByTestId('doc-title')).toHaveText('How we schedule');
  await expect(page.getByTestId('chord-hint')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readMockFile(page, 'delivery/how-we-schedule.md')).toContain('gh');
  await page.keyboard.press('ControlOrMeta+f');
  await expect(page.getByTestId('find-input')).toBeFocused();
  await page.getByTestId('find-input').fill('gh');
  await expect(page.getByTestId('find-count')).toHaveText('1 of 1');
  await page.keyboard.press('ControlOrMeta+g');
  await expect(page.getByTestId('find-count')).toHaveText('1 of 1');
});

test('c p creates an ordinary page, and g comma opens the complete shortcut catalog', async ({
  page,
}, testInfo) => {
  await boot(page);
  await blurToBody(page);
  await page.keyboard.press('c');
  await page.keyboard.press('p');
  await page
    .getByRole('dialog', { name: 'New page' })
    .getByPlaceholder('Page title')
    .fill('Launch notes');
  await page.getByRole('button', { name: 'Create page', exact: true }).click();
  await expect(page).toHaveTitle('Launch notes — Cerebro');
  await expect(page.getByTestId('doc-title')).toHaveText('Launch notes');
  expect(await readMockFile(page, 'launch-notes.md')).toContain('# Launch notes');
  await blurToBody(page);
  await page.keyboard.press('g');
  await page.keyboard.press(',');
  await expect(page.getByTestId('settings-page')).toBeVisible();
  const shortcuts = page.getByTestId('settings-shortcuts');
  await shortcuts.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await expect(shortcuts.locator('[data-command="go.home"]')).toHaveAttribute('data-keys', 'g h');
  await expect(shortcuts.locator('[data-command="palette.open"]')).toHaveAttribute(
    'data-keys',
    'mod+k',
  );
  await expect(shortcuts.getByText('Keyboard shortcuts', { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('keyboard-settings.png'),
    animations: 'disabled',
  });
});
