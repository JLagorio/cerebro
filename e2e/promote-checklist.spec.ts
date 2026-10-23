import { expect, test, type Page } from '@playwright/test';
import YAML from 'yaml';
import { boot, readMockFile } from './boot';
import { chooseOption } from './select';

const SCHEDULE = 'delivery/how-we-schedule.md';
const EPIC = 'records/epics/epic-first-week-activation.md';
const metadata = (content: string) => YAML.parse(/^---\n([\s\S]*?)\n---\n/.exec(content)![1]);

async function openSchedule(page: Page) {
  await page.getByRole('button', { name: 'Expand Delivery' }).click();
  await page
    .getByTestId('collection-node-doc')
    .filter({ hasText: 'How we schedule' })
    .getByRole('button', { name: 'How we schedule' })
    .click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible();
}
async function openEpic(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('First-week activation');
  await page
    .getByTestId('quick-open-result')
    .filter({ hasText: 'First-week activation' })
    .first()
    .click();
  await page.getByTestId('detail-panel').getByRole('button', { name: 'Open in full page' }).click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await boot(page);
});

test('the checklist grip promotes a record with deadline and owner, then saves a page link', async ({
  page,
}, testInfo) => {
  await page.evaluate(
    ([path, content]) => window.__cerebroMockFs.set(path, content),
    [SCHEDULE, '# How we schedule\n\n- [ ] Ship docs 📅 2026-10-20 @[[maya-chen]]\n'],
  );
  await openSchedule(page);
  const line = page
    .locator('.bn-block-content[data-content-type="checkListItem"]')
    .filter({ hasText: 'Ship docs' });
  await line.hover();
  await page.locator('[data-testid="block-grip"] button').click();
  await page.getByTestId('promote-line-item').click();
  const dialog = page.getByRole('dialog', { name: 'Promote to records' });
  await chooseOption(dialog.getByRole('button', { name: 'Database', exact: true }), 'Work item');
  await expect(dialog.getByTestId('promote-line')).toHaveCount(1);
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(1000);
  await page.screenshot({
    path: testInfo.outputPath('promote-checklist.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await dialog.getByRole('button', { name: 'Promote 1 line', exact: true }).click();
  await expect(dialog.getByTestId('promote-result')).toHaveAttribute('data-outcome', 'created');
  const content = await readMockFile(page, 'records/work-items/ship-docs.md');
  expect(metadata(content)).toMatchObject({
    type: 'Work item',
    status: 'backlog',
    due: '2026-10-20',
    assignee: ['[[maya-chen]]'],
  });
  expect(content).toContain('# Ship docs\n');
  await expect.poll(() => readMockFile(page, SCHEDULE)).toMatch(/[*-] \[\[ship-docs\]\]/);
  await dialog.getByRole('button', { name: 'Created — open record' }).click();
  await expect(page.getByTestId('doc-title')).toHaveText('Ship docs');
});

test('selection promotion reports created, empty and linked lines, with the task-like parent', async ({
  page,
}) => {
  const original = await readMockFile(page, EPIC);
  const prefix = /^(---\n[\s\S]*?\n---\n)/.exec(original)![1];
  await page.evaluate(
    ([path, content]) => window.__cerebroMockFs.set(path, content),
    [
      EPIC,
      `${prefix}\n# First-week activation\n\n- [ ] Build launch guide\n- [ ] Empty placeholder\n- [ ] [[systems-map]]\n`,
    ],
  );
  await openEpic(page);
  const empty = page.locator('.bn-inline-content').filter({ hasText: /^Empty placeholder$/ });
  await empty.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home');
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+ArrowRight' : 'Shift+End');
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
  await page.keyboard.press('Backspace');
  await expect(page.getByText('Empty placeholder', { exact: true })).toHaveCount(0);
  const first = page.locator('.bn-inline-content').filter({ hasText: /^Build launch guide$/ });
  await first.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.getByTestId('selection-promote').click();
  const dialog = page.getByRole('dialog', { name: 'Promote to records' });
  await chooseOption(dialog.getByRole('button', { name: 'Database', exact: true }), 'Work item');
  await expect(dialog.getByTestId('promote-line')).toHaveCount(3);
  await dialog.getByRole('button', { name: 'Promote 3 lines', exact: true }).click();
  const results = dialog.getByTestId('promote-result');
  await expect(results).toHaveCount(3);
  await expect(results.nth(0)).toHaveAttribute('data-outcome', 'created');
  await expect(results.nth(1)).toHaveText('Empty line');
  await expect(results.nth(2)).toHaveText('Already a link');
  const content = await readMockFile(page, 'records/work-items/build-launch-guide.md');
  expect(metadata(content)).toMatchObject({
    status: 'backlog',
    epic: '[[epic-first-week-activation]]',
  });
  await expect.poll(() => readMockFile(page, EPIC)).toMatch(/[*-] \[\[build-launch-guide\]\]/);
});
