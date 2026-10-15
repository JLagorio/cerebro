import { expect, test } from '@playwright/test';
import { boot, readMockFile, seedFileBeforeBoot } from './boot';

const path = 'studio/budget/index.md';
const source =
  '# Budget prototype\n\n```cerebro-sheet\n---\nformat: 1\nname: Budget\n---\nItem,Amount\nRent,1200\nFood,300\nTotal,=SUM(B2:B3)\n```\n\n```cerebro-sheet\nRent share,=Budget!B2/Budget!B4\n```\n\n```cerebro-sheet\n---\nformat: 2\n---\nfuture,source\n```\n';

test('Studio computes linked sheet fences and retains unavailable source without changing bytes', async ({
  page,
}, testInfo) => {
  await seedFileBeforeBoot(page, path, source);
  await boot(page);
  await page
    .getByTestId('nav-surfaces')
    .getByRole('button', { name: 'Studio', exact: true })
    .click();
  await page.getByTestId('studio-project').filter({ hasText: 'Budget prototype' }).click();
  const blocks = page.getByTestId('sheet-block');
  await expect(blocks).toHaveCount(3);
  await expect(blocks.nth(0).locator('[data-address=B4]')).toHaveText('1500');
  await expect(blocks.nth(1).locator('[data-address=B1]')).toHaveText('0.8');
  await expect(blocks.nth(1).getByTestId('sheet-name')).toHaveText('Sheet2');
  await expect(blocks.nth(2).getByTestId('sheet-unavailable')).toHaveText(
    'This sheet says format 2. Cerebro reads format 1.',
  );
  await expect(blocks.nth(2).getByTestId('sheet-source')).toHaveText(
    '---\nformat: 2\n---\nfuture,source',
  );
  expect(await readMockFile(page, path)).toBe(source);
  await page.screenshot({ path: testInfo.outputPath('studio-sheets.png'), animations: 'disabled' });
});

test('page sheets retain their exact fences through typing and an unmount flush, with a bounded wide grid', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const pagePath = 'strategy/systems-map.md';
  const wide = Array.from({ length: 26 }, (_, col) => `Column ${col + 1}`).join(',');
  const seeded = `${source}\n\`\`\`cerebro-sheet\n${wide}\n\`\`\`\n\nClosing notes.\n`;
  await seedFileBeforeBoot(page, pagePath, seeded);
  await boot(page);
  const tree = page.getByTestId('file-tree');
  const folder = tree.getByTestId('tree-folder').filter({ hasText: 'Strategy' });
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.click();
  await tree
    .locator(`[data-testid="tree-row"][data-path="${pagePath}"]`)
    .getByTestId('tree-file')
    .click();
  const editor = page.getByTestId('markdown-editor');
  const blocks = editor.getByTestId('sheet-block');
  await expect(blocks).toHaveCount(4);
  await expect(blocks.nth(0).locator('[data-address=B4]')).toHaveText('1500');
  await expect(blocks.nth(1).locator('[data-address=B1]')).toHaveText('0.8');
  await expect(blocks.nth(2).getByTestId('sheet-unavailable')).toContainText('format 2');
  await expect(page.getByTestId('lossy-import-banner')).toHaveCount(0);
  await expect(editor.locator('[contenteditable=true]').first()).toBeVisible();
  await expect(blocks.nth(3).getByTestId('sheet-grid')).toBeVisible();
  const geometry = await blocks.nth(3).evaluate((block) => {
    const host = block.closest('[data-testid="markdown-editor"]')!;
    const viewport = block.querySelector('[data-testid="sheet-viewport"]') ?? block;
    return {
      block: block.getBoundingClientRect().width,
      editor: host.getBoundingClientRect().width,
      scroll: viewport.scrollWidth,
      client: viewport.clientWidth,
    };
  });
  await blocks.nth(3).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('wide-sheet.png'), animations: 'disabled' });
  expect(geometry.block).toBeLessThanOrEqual(geometry.editor);
  expect(geometry.scroll, JSON.stringify(geometry)).toBeGreaterThan(geometry.client + 500);
  await editor
    .locator('[data-content-type=paragraph]')
    .filter({ hasText: 'Closing notes.' })
    .click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Checked.');
  await expect.poll(() => readMockFile(page, pagePath)).toContain('Closing notes. Checked.');
  const saved = await readMockFile(page, pagePath);
  expect(saved).toContain(source.slice(source.indexOf('```cerebro-sheet')));
  expect(saved).toContain(`\`\`\`cerebro-sheet\n${wide}\n\`\`\``);
  expect(saved).not.toContain('1500');
  expect(saved).not.toContain('0.8');
  await blocks.nth(0).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('page-sheets.png'), animations: 'disabled' });
  await editor
    .locator('[data-content-type=paragraph]')
    .filter({ hasText: 'Closing notes.' })
    .click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Leaving.');
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Home', exact: true }).click();
  await expect.poll(() => readMockFile(page, pagePath)).toContain('Checked. Leaving.');
  expect(await readMockFile(page, pagePath)).toContain(
    source.slice(source.indexOf('```cerebro-sheet')),
  );
});
