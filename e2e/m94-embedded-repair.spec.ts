import { expect, test, type Locator, type Page } from '@playwright/test';
import { boot, readMockFile, seedFileBeforeBoot } from './boot';

const PATH = 'notes/m94-embedded-repair.md';
const TITLE = 'Embedded database repair journey';
const BODY =
  '# ' +
  TITLE +
  '\n\nKeep this exact neighboring text.\n\n' +
  '```cerebro-database\ndatabase: Missing repair source\nview: stale-view\n```\n\n' +
  'Keep this following paragraph too.\n';

async function pageWrites(page: Page) {
  return page.evaluate(
    (path) => window.__cerebroMockWrites.filter((write) => write.path === path),
    PATH,
  );
}

async function reachable(control: Locator, host: Locator) {
  const box = (await control.boundingBox())!;
  const frame = (await host.boundingBox())!;
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThanOrEqual(28);
  expect(box.x).toBeGreaterThanOrEqual(frame.x);
  expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width + 1);
  expect(
    await control.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return hit !== null && node.contains(hit);
    }),
  ).toBe(true);
}

for (const theme of ['light', 'dark'] as const) {
  test(
    'a missing embedded database repairs in place with explicit choice in ' + theme,
    async ({ page }, info) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await seedFileBeforeBoot(page, PATH, BODY);
      await boot(page);
      if (theme === 'dark')
        await page.getByTestId('app-rail').getByRole('button', { name: 'Theme: light' }).click();
      await page.keyboard.press('ControlOrMeta+k');
      await page.getByTestId('quick-open-input').fill(TITLE);
      await page.getByTestId('quick-open-result').filter({ hasText: TITLE }).first().click();
      const host = page.getByTestId('doc-page');
      const editor = host.getByTestId('markdown-editor');
      const owner = await editor.elementHandle();
      await expect(host.locator('[data-page-title] h1')).toHaveText(TITLE);
      await expect(editor).toHaveCount(1);
      const missing = editor.getByTestId('database-block-missing');
      const repair = missing.getByRole('button', { name: 'Choose another database' });
      await expect(missing).toContainText('Missing repair source');
      const writes = await pageWrites(page);
      const files = await page.evaluate(() => Object.fromEntries(window.__cerebroMockFs));

      await host.evaluate((node) => {
        const host = node as HTMLElement;
        host.style.flex = '0 0 auto';
        host.style.maxWidth = 'none';
        host.style.width = '360px';
      });
      await page.evaluate(() => document.fonts.ready);
      await reachable(repair, host);
      await repair.focus();
      await repair.press('Enter');
      const menu = page.getByRole('menu', { name: 'Databases' });
      await expect(menu).toBeVisible();
      await expect(missing).toContainText('Missing repair source');
      expect(await readMockFile(page, PATH)).toBe(BODY);
      expect(await pageWrites(page)).toEqual(writes);
      await page.screenshot({
        path: info.outputPath('missing-database-repair-' + theme + '.png'),
        animations: 'disabled',
      });
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(repair).toBeFocused();
      expect(await owner!.evaluate((node) => node.isConnected)).toBe(true);
      await expect(editor).toContainText('Keep this exact neighboring text.');
      await expect(editor).toContainText('Keep this following paragraph too.');

      // Switching presentation settles the real page owner before the no-write
      // assertion, so an accidental delayed edit cannot hide behind debounce.
      const presentation = host.getByRole('group', { name: 'Page presentation' });
      await presentation.getByRole('button', { name: 'Source', exact: true }).click();
      await expect(host.getByRole('textbox', { name: 'Page source' })).toHaveValue(BODY);
      expect(await readMockFile(page, PATH)).toBe(BODY);
      expect(await pageWrites(page)).toEqual(writes);
      await presentation.getByRole('button', { name: 'Rich text', exact: true }).click();
      await repair.click();
      await page
        .getByRole('menu', { name: 'Databases' })
        .getByRole('menuitem', { name: /^Epic/ })
        .click();
      const repaired = editor.getByTestId('database-block');
      await expect(repaired.getByTestId('table-row')).toHaveCount(4);
      await expect(editor.getByTestId('database-block-missing')).toHaveCount(0);
      await expect(repaired.getByTestId('database-block-view-missing')).toHaveCount(0);
      await expect(repaired).toContainText('Epic');
      await expect(repaired).toContainText('Table');
      await expect(repaired).toContainText('Shared view · edits apply everywhere');
      await expect.poll(() => readMockFile(page, PATH)).toContain('database: Epic');
      const saved = await readMockFile(page, PATH);
      expect(saved).not.toContain('stale-view');
      expect(saved).toContain('Keep this exact neighboring text.');
      expect(saved).toContain('Keep this following paragraph too.');
      expect((await pageWrites(page)).length - writes.length).toBe(1);
      const after = await page.evaluate(() => Object.fromEntries(window.__cerebroMockFs));
      expect(Object.keys(after).filter((path) => after[path] !== files[path])).toEqual([PATH]);
      await page.screenshot({
        path: info.outputPath('repaired-database-' + theme + '.png'),
        animations: 'disabled',
      });

      await repaired.getByRole('button', { name: 'Open Epic as a full page' }).click();
      await expect(page.getByTestId('type-page')).toBeVisible();
      await page.keyboard.press('ControlOrMeta+[');
      await expect(host.locator('[data-page-title] h1')).toHaveText(TITLE);
      await expect(host.getByTestId('markdown-editor')).toHaveCount(1);
      await expect(host.getByTestId('database-block').getByTestId('table-row')).toHaveCount(4);
      expect(await readMockFile(page, PATH)).toBe(saved);
      expect((await pageWrites(page)).length - writes.length).toBe(1);
    },
  );
}
