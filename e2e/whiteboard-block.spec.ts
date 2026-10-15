import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile, seedFileBeforeBoot } from './boot';

const PAGE = 'delivery/how-we-schedule.md';
const BOARD = 'boards/embedded.canvas';
const board = JSON.stringify({
  nodes: [
    { id: 'note', type: 'text', text: 'Read-only board text', x: 0, y: 0, width: 280, height: 120 },
  ],
  edges: [],
});
const fence =
  '```cerebro-whiteboard\nboard: "boards/embedded.canvas"\nheight: 360\nextra: kept verbatim\n```';
const missing = '```cerebro-whiteboard\nboard: boards/gone.canvas\nextra: still here\n```';
async function openPage(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('How we schedule');
  await page
    .getByTestId('quick-open-result')
    .filter({ hasText: 'How we schedule' })
    .first()
    .click();
  await expect(page.getByTestId('doc-title')).toHaveText('How we schedule');
  await expect(page.getByTestId('markdown-editor')).toBeVisible();
}
async function slash(page: Page) {
  const last = page.getByTestId('markdown-editor').locator('[data-content-type=paragraph]').last();
  await last.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/whiteboard');
  await page
    .locator('#bn-suggestion-menu [role=option]')
    .filter({ hasText: 'Show a whiteboard with Open' })
    .click();
  await expect(page.getByLabel('Find a whiteboard', { exact: true })).toBeFocused();
}
test('a page board is read-only, passes the wheel to the page, opens and saves its exact fence', async ({
  page,
}, info) => {
  await seedFileBeforeBoot(page, BOARD, board);
  await seedFileBeforeBoot(
    page,
    PAGE,
    `# How we schedule\n\nIntro.\n\n${fence}\n\n${missing}\n\nClosing notes.\n\n${Array.from({ length: 20 }, (_, n) => `Paragraph ${n}.`).join('\n\n')}\n`,
  );
  await boot(page);
  await openPage(page);
  const block = page.getByTestId('whiteboard-block').first();
  await expect(block.getByTestId('whiteboard-embed')).toHaveAttribute('data-state', 'ready');
  await expect(block).toContainText('Read-only board text');
  await expect(page.getByTestId('wb-input')).toHaveCount(0);
  await expect(page.getByTestId('lossy-import-banner')).toHaveCount(0);
  const scroll = () =>
    page.getByTestId('doc-content').evaluate((node) => node.parentElement!.scrollTop);
  const before = await scroll();
  await block.getByTestId('wb-board').hover();
  await page.mouse.wheel(0, 230);
  await expect.poll(scroll).toBeGreaterThan(before + 100);
  await expect(page.getByTestId('whiteboard-block').nth(1)).toHaveAttribute(
    'data-state',
    'missing',
  );
  await page
    .getByTestId('markdown-editor')
    .locator('[data-content-type=paragraph]')
    .filter({ hasText: /^Closing notes\.$/ })
    .click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Checked.');
  await expect.poll(() => readMockFile(page, PAGE)).toContain('Closing notes. Checked.');
  expect(await readMockFile(page, PAGE)).toContain(fence);
  expect(await readMockFile(page, PAGE)).toContain(missing);
  await block.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('whiteboard-block.png'), animations: 'disabled' });
  await block.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByTestId('canvas-title')).toHaveText('Embedded');
  await expect(page.getByTestId('wb-input')).toBeVisible();
  expect(await readMockFile(page, BOARD)).toBe(board);
  expect(await readMockFile(page, PAGE)).toContain(fence);
  expect(await readMockFile(page, PAGE)).toContain(missing);
});
test('/Whiteboard takes a picked file and New whiteboard creates beside the page', async ({
  page,
}) => {
  await seedFileBeforeBoot(page, BOARD, board);
  await seedFileBeforeBoot(page, PAGE, '# How we schedule\n\nClosing notes.\n');
  await boot(page);
  await openPage(page);
  await slash(page);
  await page.keyboard.type('embedded');
  await page
    .getByTestId('whiteboard-block-option')
    .filter({ hasText: 'boards/embedded.canvas' })
    .click();
  await expect
    .poll(() => readMockFile(page, PAGE))
    .toContain('```cerebro-whiteboard\nboard: boards/embedded.canvas\n```');
  await expect(
    page.getByTestId('whiteboard-block').first().getByTestId('whiteboard-embed'),
  ).toHaveAttribute('data-state', 'ready');
  await slash(page);
  await page.getByRole('button', { name: 'New whiteboard', exact: true }).click();
  const created = 'delivery/whiteboards/how-we-schedule.canvas';
  await expect.poll(() => readMockFile(page, PAGE)).toContain(`board: ${created}`);
  expect(JSON.parse(await readMockFile(page, created))).toMatchObject({ nodes: [], edges: [] });
  await expect(page.getByTestId('whiteboard-block')).toHaveCount(2);
  await expect(page.getByTestId('wb-input')).toHaveCount(0);
});
