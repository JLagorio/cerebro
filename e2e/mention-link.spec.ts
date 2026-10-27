import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile, seedFileBeforeBoot, showPagePanel } from './boot';

const TARGET = 'notes/m97-target.md';
const SOURCE = 'notes/m97-source.md';
const TARGET_RAW = '# Neon Orchard\n\nTarget body.\n';
const BEFORE =
  '---\nstatus_note: keep exactly\n---\n# Mention source\n\n😀 Neon Orchard first, then Neon Orchard second.\n\nUntouched line.\n';
const AFTER =
  '---\nstatus_note: keep exactly\n---\n# Mention source\n\n😀 Neon Orchard first, then [[m97-target|Neon Orchard]] second.\n\nUntouched line.\n';
const LINK_ACTION = 'Link mention in Mention source: Neon Orchard';

const sourceWrites = (page: Page) =>
  page.evaluate(
    (path) => window.__cerebroMockWrites.filter((write) => write.path === path).length,
    SOURCE,
  );

async function openTarget(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Neon Orchard');
  await page.getByTestId('quick-open-result').filter({ hasText: 'Neon Orchard' }).first().click();
  await expect(page.getByTestId('doc-page').locator('.bn-editor')).toBeVisible({
    timeout: 15_000,
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`mention insertion preserves exact source bytes through Cancel and one app Undo in ${theme}`, async ({
    page,
  }, info) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await seedFileBeforeBoot(page, TARGET, TARGET_RAW);
    await seedFileBeforeBoot(page, SOURCE, BEFORE);
    await boot(page);
    if (theme === 'dark')
      await page.getByTestId('app-rail').getByRole('button', { name: 'Theme: light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await openTarget(page);
    let details = await showPagePanel(page, 'Details');
    await details.getByRole('button', { name: 'Search mentions', exact: true }).click();
    await expect(
      details
        .getByTestId('source-occurrences-count')
        .filter({ hasText: '2 occurrences on 1 page' }),
    ).toBeVisible();
    await expect(details.getByRole('button', { name: LINK_ACTION, exact: true })).toHaveCount(2);
    const beforeWrites = await sourceWrites(page);

    // Enter through the actual on-demand occurrence row, then cancel in the
    // source owner. Merely opening/revealing the selected occurrence is read-only.
    await details.getByRole('button', { name: LINK_ACTION, exact: true }).nth(1).click();
    await expect(page.getByTestId('source-reveal-status')).toContainText(
      'Source passage revealed.',
    );
    await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('Neon Orchard');
    expect(await readMockFile(page, SOURCE)).toBe(BEFORE);
    expect(await sourceWrites(page)).toBe(beforeWrites);
    await page.getByRole('button', { name: 'Cancel link', exact: true }).click();
    await expect(page.getByTestId('source-reveal-status')).toContainText(
      'Link insertion cancelled.',
    );
    await expect(page.getByRole('button', { name: 'Insert link', exact: true })).toHaveCount(0);
    expect(await readMockFile(page, SOURCE)).toBe(BEFORE);
    expect(await sourceWrites(page)).toBe(beforeWrites);

    await page.getByRole('button', { name: 'Return to origin', exact: true }).click();
    details = await showPagePanel(page, 'Details');
    await expect(details.getByRole('button', { name: LINK_ACTION, exact: true })).toHaveCount(2);
    await expect(details.getByRole('button', { name: 'Search mentions', exact: true })).toHaveCount(
      0,
    );
    await details.getByRole('button', { name: LINK_ACTION, exact: true }).nth(1).click();
    await expect(page.getByTestId('source-reveal-status')).toContainText(
      'Source passage revealed.',
    );
    const editor = page.getByTestId('doc-page').locator('.bn-editor');
    await expect(editor).toBeVisible();
    const heldEditor = await editor.elementHandle();
    if (!heldEditor) throw new Error('Expected the actual retained source editor');
    const insert = page.getByRole('button', { name: 'Insert link', exact: true });
    await insert.focus();
    await expect(insert).toBeFocused();
    await page.screenshot({
      path: info.outputPath(`mention-link-ready-${theme}.png`),
      animations: 'disabled',
    });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('source-reveal-status')).toContainText('Mention linked.');
    await expect.poll(() => readMockFile(page, SOURCE)).toBe(AFTER);
    await expect(editor.locator('[data-chip="wikilink"]')).toHaveCount(1);
    await expect(editor.locator('[data-chip="wikilink"]')).toHaveText('Neon Orchard');
    expect(await heldEditor.evaluate((node) => node.isConnected)).toBe(true);
    expect(await sourceWrites(page)).toBe(beforeWrites + 1);
    expect(await readMockFile(page, TARGET)).toBe(TARGET_RAW);
    await expect(page.getByRole('button', { name: 'Insert link', exact: true })).toHaveCount(0);
    const undo = page.getByTestId('toast-host').getByRole('button', { name: 'Undo', exact: true });
    await undo.focus();
    await page.screenshot({
      path: info.outputPath(`mention-link-applied-${theme}.png`),
      animations: 'disabled',
    });
    await undo.click();
    await expect.poll(() => readMockFile(page, SOURCE)).toBe(BEFORE);
    await expect(editor.locator('[data-chip="wikilink"]')).toHaveCount(0);
    expect(await heldEditor.evaluate((node) => node.isConnected)).toBe(true);
    expect(await readMockFile(page, TARGET)).toBe(TARGET_RAW);
    await expect(page.getByRole('button', { name: 'Insert link', exact: true })).toHaveCount(0);
  });
}
