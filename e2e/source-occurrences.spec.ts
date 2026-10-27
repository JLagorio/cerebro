import { expect, test, type Page } from '@playwright/test';
import { boot, seedFileBeforeBoot, readMockFile, showPagePanel } from './boot';

const TARGET = 'notes/occ-target.md';
const SOURCE = 'notes/occ-source.md';
const TARGET_RAW = '# Occurrence target\n\nA page with sources.\n';
const SOURCE_RAW =
  '# Occurrence source\n\nCafé 😀 before [[occ-target|first chip]] then [[occ-target|second chip]].\n\nOccurrence target is plain text.\n';
async function openTarget(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Occurrence target');
  await page
    .getByTestId('quick-open-result')
    .filter({ hasText: 'Occurrence target' })
    .first()
    .click();
  await expect(page.getByTestId('doc-page').locator('.bn-editor')).toBeVisible({ timeout: 15_000 });
}
for (const { width, theme } of [
  { width: 1440, theme: 'light' },
  { width: 720, theme: 'light' },
  { width: 1440, theme: 'dark' },
  { width: 720, theme: 'dark' },
] as const) {
  test(`contextual occurrences select the chosen source and restore discovery at ${width}px in ${theme}`, async ({
    page,
  }, info) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 1000 });
    await seedFileBeforeBoot(page, TARGET, TARGET_RAW);
    await seedFileBeforeBoot(page, SOURCE, SOURCE_RAW);
    await boot(page);
    if (theme === 'dark')
      await page.getByTestId('app-rail').getByRole('button', { name: 'Theme: light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await openTarget(page);
    let details = await showPagePanel(page, 'Details');
    await expect(
      details
        .getByTestId('source-occurrences-count')
        .filter({ hasText: '2 occurrences on 1 page' }),
    ).toBeVisible();
    await details.getByRole('button', { name: 'Search mentions', exact: true }).click();
    await expect(
      details.getByTestId('source-occurrences-count').filter({ hasText: '1 occurrence on 1 page' }),
    ).toBeVisible();
    const second = details
      .getByTestId('source-occurrence-row')
      .filter({ has: page.locator('mark', { hasText: '[[occ-target|second chip]]' }) });
    await second.click();
    await expect(page.getByTestId('doc-page').locator('.bn-editor')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('source-reveal-status')).toContainText(
      'Source passage revealed.',
    );
    const sourceEditor = page.getByTestId('doc-page').locator('.bn-editor');
    await expect(sourceEditor).toBeFocused();
    // Atomic chip labels use user-select:none. Native Range contents still
    // identify the exact chosen occurrence even when Selection.toString is empty.
    await expect
      .poll(() =>
        sourceEditor.evaluate((editor) => {
          const selection = editor.ownerDocument.getSelection();
          if (selection?.rangeCount !== 1) return null;
          const range = selection.getRangeAt(0);
          return {
            collapsed: range.collapsed,
            text: range.toString(),
            clonedText: range.cloneContents().textContent,
            chips: [...editor.querySelectorAll('[data-chip="wikilink"]')].map((chip) => ({
              text: chip.textContent,
              intersects: range.intersectsNode(chip),
            })),
          };
        }),
      )
      .toEqual({
        collapsed: false,
        text: 'second chip',
        clonedText: 'second chip',
        chips: [
          { text: 'first chip', intersects: false },
          { text: 'second chip', intersects: true },
        ],
      });
    const selectedNode = sourceEditor.locator('.ProseMirror-selectednode');
    await expect(selectedNode).toHaveCount(1);
    await expect(selectedNode).toBeVisible();
    await expect(selectedNode).toHaveText('second chip');
    const selectedChip = selectedNode.locator('[data-chip="wikilink"]');
    await expect(selectedChip).toHaveCSS('outline-style', 'solid');
    await expect(selectedChip).toHaveCSS('outline-width', '2px');
    expect(await readMockFile(page, SOURCE)).toBe(SOURCE_RAW);
    await page.screenshot({
      path: info.outputPath(`second-link-${width}.png`),
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Return to origin', exact: true }).click();
    details = await showPagePanel(page, 'Details');
    await expect(details.getByTestId('source-occurrence-row')).toHaveCount(3);
    await expect(details.getByRole('button', { name: 'Search mentions', exact: true })).toHaveCount(
      0,
    );
    const mention = details
      .getByTestId('source-occurrence-row')
      .filter({ has: page.locator('mark', { hasText: /^Occurrence target$/ }) });
    await mention.click();
    await expect(page.getByTestId('source-reveal-status')).toContainText(
      'Source passage revealed.',
    );
    await expect
      .poll(() => page.evaluate(() => getSelection()?.toString()))
      .toBe('Occurrence target');
    expect(await readMockFile(page, SOURCE)).toBe(SOURCE_RAW);
    expect(await readMockFile(page, TARGET)).toBe(TARGET_RAW);
    await page.getByRole('button', { name: 'Return to origin', exact: true }).click();
    details = await showPagePanel(page, 'Details');
    await expect(details.getByTestId('source-occurrence-row')).toHaveCount(3);
    await expect(details.getByRole('button', { name: 'Search mentions', exact: true })).toHaveCount(
      0,
    );
    await page.screenshot({
      path: info.outputPath(`returned-discovery-${width}.png`),
      animations: 'disabled',
    });
  });
}
