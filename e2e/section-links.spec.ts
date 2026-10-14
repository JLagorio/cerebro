import { expect, test, type Locator, type Page } from '@playwright/test';
import { boot, readMockFile } from './boot';

/**
 * Section links (M55.8): `[[page#Heading]]` opens the page on its heading.
 *
 * jsdom has no scroll and no layout, so where the heading lands and where the
 * highlight sits are held here: the heading in the viewport, and the
 * `section-flash` box over its centre (a geometry check, since the browser
 * wraps a block in an element jsdom does not; trap 1). The file is read back
 * from the mock disk, so the fragment is shown to survive a save.
 */

const MAP = 'strategy/systems-map.md';
const SCHEDULE = 'delivery/how-we-schedule.md';

/** A page long enough that its last heading starts out of view. */
const LONG_MAP = [
  '# Systems map',
  '',
  ...Array.from({ length: 60 }, (_, i) => [`Filler paragraph ${i + 1}.`, '']).flat(),
  ':::toggle Details',
  '## Deep dive',
  ':::',
  '',
  ...Array.from({ length: 20 }, (_, i) => [`More filler ${i + 1}.`, '']).flat(),
  '## Rollback',
  '',
  'Revert the release.',
  '',
].join('\n');

const scheduleWith = (line: string) => ['# How we schedule', '', line, ''].join('\n');

/** Seed both pages, then open How we schedule from the sidebar. */
async function openSchedule(page: Page, line: string): Promise<void> {
  await page.evaluate(
    ([map, mapMd, schedule, scheduleMd]) => {
      window.__cerebroMockFs.set(map, mapMd);
      window.__cerebroMockFs.set(schedule, scheduleMd);
    },
    [MAP, LONG_MAP, SCHEDULE, scheduleWith(line)],
  );
  const node = page.getByTestId('collection-node-doc').filter({ hasText: 'How we schedule' });
  if (!(await node.isVisible()))
    await page.getByRole('button', { name: 'Expand Delivery' }).click();
  await node.getByRole('button', { name: 'How we schedule' }).click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible({ timeout: 10_000 });
}

/** Is the centre of `target` inside the section flash's box? */
async function flashCovers(page: Page, target: Locator): Promise<boolean> {
  const flash = await page.getByTestId('section-flash').boundingBox();
  const box = await target.boundingBox();
  if (flash === null || box === null) return false;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  return x >= flash.x && x <= flash.x + flash.width && y >= flash.y && y <= flash.y + flash.height;
}

test('a section chip keeps its fragment on disk and lands on the heading', async ({ page }) => {
  await boot(page);
  await openSchedule(page, 'Before a release, read [[systems-map#Rollback]].');
  const editor = page.getByTestId('markdown-editor');
  const chip = editor.locator('[data-chip="wikilink"]');
  await expect(chip).toHaveText('Systems map › Rollback', { timeout: 10_000 });

  // An edit beside the chip saves the link exactly as it was written.
  // Typed at its first letter: the paragraph's middle can be the chip.
  await editor.getByText('Before a release, read').click({ position: { x: 4, y: 8 } });
  await page.keyboard.press('Home');
  await page.keyboard.type('Always. ');
  await expect
    .poll(() => readMockFile(page, SCHEDULE), { timeout: 6_000 })
    .toContain('Always. Before a release, read [[systems-map#Rollback]].');

  await chip.click();
  await expect(page.getByTestId('doc-title')).toHaveText('Systems map', { timeout: 10_000 });
  const heading = editor.getByRole('heading', { name: 'Rollback' });
  await expect(heading).toBeInViewport({ timeout: 5_000 });
  await expect(page.getByTestId('section-flash')).toBeVisible();
  await expect.poll(() => flashCovers(page, heading), { timeout: 1_500 }).toBe(true);
  await expect(page.getByTestId('section-flash')).toHaveCount(0, { timeout: 5_000 });
});

test('a heading inside a closed toggle is opened and reached', async ({ page }) => {
  await boot(page);
  await openSchedule(page, 'Read [[systems-map#Deep dive]] first.');
  const editor = page.getByTestId('markdown-editor');
  const chip = editor.locator('[data-chip="wikilink"]');
  await expect(chip).toHaveText('Systems map › Deep dive', { timeout: 10_000 });

  await chip.click();
  await expect(page.getByTestId('doc-title')).toHaveText('Systems map', { timeout: 10_000 });
  const heading = editor.getByRole('heading', { name: 'Deep dive' });
  await expect(heading).toBeInViewport({ timeout: 5_000 });
  await expect(editor.locator('.bn-toggle-wrapper[data-show-children="true"]')).toHaveCount(1);
  await expect.poll(() => flashCovers(page, heading), { timeout: 1_500 }).toBe(true);
});

test('[[#Heading]] jumps within the page without leaving it', async ({ page }) => {
  await boot(page);
  await page.evaluate(
    ([path, md]) => window.__cerebroMockFs.set(path, md),
    [MAP, LONG_MAP.replace('# Systems map\n', '# Systems map\n\nJump to [[#Rollback]].\n')],
  );
  await page.keyboard.press('ControlOrMeta+k');
  const quickOpenInput = page.getByTestId('quick-open-input');
  await quickOpenInput.fill('Systems map');
  await page.getByTestId('quick-open-result').filter({ hasText: 'Systems map' }).first().click();
  await expect(page.getByTestId('doc-title')).toHaveText('Systems map', { timeout: 10_000 });

  const editor = page.getByTestId('markdown-editor');
  const heading = editor.getByRole('heading', { name: 'Rollback' });
  await expect(heading).not.toBeInViewport();
  const chip = editor.locator('[data-chip="wikilink"]');
  await expect(chip).toHaveText('Systems map › Rollback', { timeout: 10_000 });
  await chip.click();
  await expect(heading).toBeInViewport({ timeout: 5_000 });
  await expect(page.getByTestId('section-flash')).toBeVisible();
  await expect(page.getByTestId('doc-title')).toHaveText('Systems map');
});
