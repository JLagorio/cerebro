import { expect, test, type Page } from '@playwright/test';
import {
  boot,
  readMockFile,
  seedFileBeforeBoot,
  openDestination,
  openAssistantPanel,
} from './boot';

const PATH = 'delivery/how-we-schedule.md';
const NOTE = '# How we schedule\n\nSee [[systems-map]] and [[strategy]].\n';
const frame = (page: Page, index: number) =>
  page.locator(`[data-testid="pane"][data-pane-index="${index}"]`);
async function openPage(page: Page, title: string, beside = false) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill(title);
  await expect(
    page.getByTestId('quick-open-result').filter({ hasText: title }).first(),
  ).toBeVisible();
  await page.keyboard.press(beside ? 'Shift+Enter' : 'Enter');
  await expect(page.getByTestId('quick-open-input')).toHaveCount(0);
  await expect(page).toHaveTitle(`${title} — Cerebro`);
}
async function start(page: Page, width = 1280) {
  await page.setViewportSize({ width, height: 720 });
  await seedFileBeforeBoot(page, PATH, NOTE);
  await boot(page);
  await openPage(page, 'How we schedule');
}
const systemLink = (page: Page) =>
  frame(page, 0).locator('[data-chip="wikilink"]').filter({ hasText: 'Systems map' });

test('modified link, file reuse, focused Back and closing the last pane', async ({
  page,
}, testInfo) => {
  await start(page);
  await systemLink(page).click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByTestId('pane')).toHaveCount(2);
  await expect(frame(page, 1)).toHaveAttribute('data-active', 'true');
  await expect(frame(page, 1).getByTestId('pane-bar')).toContainText('Systems map');
  await frame(page, 0).getByTestId('pane-bar').click();
  await openPage(page, 'Systems map');
  await expect(page.getByTestId('pane')).toHaveCount(2);
  await expect(frame(page, 1)).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('toast-host')).toContainText('Already open in another pane.');
  await expect(page.getByTestId('pane-bar').filter({ hasText: 'Systems map' })).toHaveCount(1);
  await openPage(page, 'Strategy');
  await page.keyboard.press('ControlOrMeta+[');
  await expect(frame(page, 1).getByTestId('pane-bar')).toContainText('Systems map');
  await expect(frame(page, 0).getByTestId('pane-bar')).toContainText('How we schedule');
  await page.screenshot({ path: testInfo.outputPath('two-panes.png') });
  await frame(page, 1).getByTestId('pane-close').click();
  await expect(page.getByTestId('pane')).toHaveCount(1);
  await page.keyboard.press('Alt+ControlOrMeta+w');
  await expect(page).toHaveTitle('Home — Cerebro');
  await expect(page.getByTestId('pane')).toHaveCount(1);
});

test('Shift+Enter opens beside from Quick open and a list cursor', async ({ page }) => {
  await start(page);
  await openPage(page, 'Systems map', true);
  await expect(page.getByTestId('pane')).toHaveCount(2);
  await frame(page, 1).getByTestId('pane-close').click();
  await openDestination(page, 'My work');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('j');
  await page.keyboard.press('Shift+Enter');
  await expect(page.getByTestId('pane')).toHaveCount(2);
  await expect(page.getByTestId('detail-panel')).toHaveCount(0);
  await expect(frame(page, 1)).toHaveAttribute('data-active', 'true');
});

test('a full narrow row beside the assistant opens in place and says why', async ({ page }) => {
  await start(page, 1000);
  // The contextual sidebar folds at this width, so two panes alone fit.
  // A docked companion leaves this row genuinely below its two-pane floor.
  await openAssistantPanel(page);
  await expect
    .poll(async () => (await page.getByTestId('pane-row').boundingBox())!.width)
    .toBeLessThan(832);
  await systemLink(page).click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByTestId('pane')).toHaveCount(1);
  await expect(page).toHaveTitle('Systems map — Cerebro');
  await expect(page.getByTestId('toast-host')).toContainText(
    'No room for another pane — opened here.',
  );
});

test('narrowing parks the older pane at zero width and its tab restores it', async ({
  page,
}, testInfo) => {
  await start(page, 1600);
  await openAssistantPanel(page);
  await systemLink(page).click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByTestId('pane')).toHaveCount(2);
  await expect
    .poll(async () => (await page.getByTestId('pane-row').boundingBox())!.width)
    .toBeGreaterThanOrEqual(832);
  await expect(frame(page, 0)).toHaveAttribute('data-parked', 'false');
  await page.setViewportSize({ width: 1000, height: 720 });
  await expect
    .poll(async () => (await page.getByTestId('pane-row').boundingBox())!.width)
    .toBeLessThan(832);
  await expect(frame(page, 0)).toHaveAttribute('data-parked', 'true');
  await expect
    .poll(() => frame(page, 0).evaluate((node) => node.getBoundingClientRect().width))
    .toBe(0);
  await expect(frame(page, 0)).toHaveAttribute('inert', '');
  await page.getByTestId('pane-parked-tab').filter({ hasText: 'How we schedule' }).click();
  await expect(frame(page, 0)).toHaveAttribute('data-active', 'true');
  await expect(frame(page, 1)).toHaveAttribute('data-parked', 'true');
  await expect
    .poll(() => frame(page, 1).evaluate((node) => node.getBoundingClientRect().width))
    .toBe(0);
  await expect(frame(page, 0).getByTestId('markdown-editor')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('parked-pane.png') });
});

test('closing immediately after typing preserves the new words and link bytes', async ({
  page,
}) => {
  await start(page);
  await systemLink(page).click({ modifiers: ['ControlOrMeta'] });
  const editable = frame(page, 0).locator('[contenteditable="true"]').first();
  await editable.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' Words kept on close.');
  await frame(page, 0).getByTestId('pane-close').click();
  await expect(page.getByTestId('pane')).toHaveCount(1);
  await expect.poll(() => readMockFile(page, PATH)).toContain('Words kept on close.');
  expect(await readMockFile(page, PATH)).toContain('[[systems-map]]');
  expect(await readMockFile(page, PATH)).toContain('[[strategy]]');
});
