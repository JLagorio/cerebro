import { expect, test, type Page } from '@playwright/test';
import { boot, openDatabase, openDestination, readMockFile, seedFileBeforeBoot } from './boot';

const TYPE_PATH = 'types/polish-record.md';
const RECORD_PATH = 'polish/launch.md';
const TITLE = 'Launch readiness and the customer handoff';
const TYPE = `---
type: Type
fields:
  website: { kind: url }
  capacity: { kind: number }
layout:
  heading: [website, capacity]
views:
  - id: all
    name: All
    presentation:
      type: table
      columns:
        - { field: website }
        - { field: capacity }
---
# Polish record
`;
const RECORD = `---
type: Polish record
website: https://example.org
capacity: 8
---
# ${TITLE}

Review the handoff before releasing the next version.

## Release checklist

- Confirm the migration plan.
- Share the support notes.
`;

async function seed(page: Page) {
  await seedFileBeforeBoot(page, TYPE_PATH, TYPE);
  await seedFileBeforeBoot(page, RECORD_PATH, RECORD);
  await boot(page);
}

async function openRecord(page: Page) {
  await openDatabase(page, 'Polish record');
  const row = page.getByTestId('table-row').filter({ hasText: TITLE });
  await expect(row).toBeVisible();
  await row.hover();
  await row.getByRole('button', { name: `Open ${TITLE}`, exact: true }).click();
  await expect(page.getByTestId('detail-panel')).toBeVisible();
}

test('a property picker stays usable at 200% zoom', async ({ page }) => {
  const type = TYPE.replace(
    'fields:\n',
    'fields:\n  status: { kind: select, options: [todo, doing, done] }\n',
  ).replace('heading: [website, capacity]', 'heading: [status]');
  const record = RECORD.replace('capacity: 8', 'capacity: 8\nstatus: todo');
  await seedFileBeforeBoot(page, TYPE_PATH, type);
  await seedFileBeforeBoot(page, RECORD_PATH, record);
  await boot(page);
  await openRecord(page);
  await page.getByTestId('detail-panel').getByRole('button', { name: 'Open in full page' }).click();
  await page.setViewportSize({ width: 900, height: 600 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2';
  });
  await page
    .getByTestId('markdown-editor')
    .getByRole('button', { name: 'Todo', exact: true })
    .click();
  const picker = page.getByRole('listbox');
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('textbox')).toBeFocused();
  const bounds = (await picker.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(900);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(600);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect.poll(() => readMockFile(page, RECORD_PATH)).toContain('status: doing');
  expect(await readMockFile(page, RECORD_PATH)).toBe(
    record.replace('status: todo', 'status: doing'),
  );
});

test('table → peek → page preserves an invalid field draft, then commits one corrected value', async ({
  page,
}, info) => {
  await seed(page);
  await openRecord(page);
  const peek = page.getByTestId('detail-panel');
  const title = peek.getByRole('heading', { name: TITLE, exact: true });
  await expect(title).toHaveCount(1);
  const editLink = peek.getByRole('button', { name: 'Edit Website', exact: true });
  expect((await title.boundingBox())!.y).toBeLessThan((await editLink.boundingBox())!.y);
  expect(await readMockFile(page, RECORD_PATH)).toBe(RECORD);

  await editLink.click();
  const input = peek.getByRole('textbox', { name: 'Website', exact: true });
  await input.fill('not a url');
  await input.press('Enter');
  await expect(input).toHaveValue('not a url');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(
    peek.locator('[data-field-status]').filter({ hasText: 'Your draft is kept' }),
  ).toBeVisible();
  expect(await readMockFile(page, RECORD_PATH)).toBe(RECORD);
  const dismiss = page
    .getByTestId('toast-host')
    .getByRole('button', { name: 'Dismiss', exact: true });
  await expect(dismiss).toHaveCount(1);
  await dismiss.click();
  await input.fill('https://example.org/release');
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await expect(editLink).toBeFocused();
  await expect
    .poll(() => readMockFile(page, RECORD_PATH))
    .toContain('website: https://example.org/release');

  await peek.getByRole('button', { name: 'Open in full page' }).click();
  const editor = page.getByTestId('markdown-editor');
  await expect(editor.getByRole('heading', { name: TITLE, exact: true })).toHaveCount(1);
  await expect(
    editor.getByRole('link', { name: 'https://example.org/release', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.screenshot({ path: info.outputPath('record-fullpage.png'), animations: 'disabled' });
  // The shipped desktop target is macOS. Keep its inspected raster reference
  // separate from the geometry/behavior assertions that run on every host.
  if (process.platform === 'darwin') {
    await expect(page).toHaveScreenshot('record-fullpage.png', { animations: 'disabled' });
  }
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(editor.getByRole('heading', { name: TITLE, exact: true })).toBeVisible();
  const saved = await readMockFile(page, RECORD_PATH);
  await page.screenshot({ path: info.outputPath('record-narrow.png'), animations: 'disabled' });
  expect(await readMockFile(page, RECORD_PATH)).toBe(saved);

  await openDestination(page, 'Home');
  // At the native minimum width, selecting a rail area opens its contextual
  // drawer. Dismiss that modal surface before choosing another rail area.
  await page.keyboard.press('Escape');
  await openRecord(page);
  await expect(
    page
      .getByTestId('detail-panel')
      .getByRole('link', { name: 'https://example.org/release', exact: true }),
  ).toBeVisible();
});

for (const theme of ['light', 'dark'] as const) {
  for (const zoom of [1.25, 1.5, 2]) {
    test(`the composed record remains readable in ${theme} at narrow width and ${zoom * 100}% text`, async ({
      page,
    }, info) => {
      await page.addInitScript((value) => localStorage.setItem('cerebro.themeMode', value), theme);
      await seedFileBeforeBoot(page, TYPE_PATH, TYPE);
      await seedFileBeforeBoot(page, RECORD_PATH, RECORD);
      await boot(page, { preserveTheme: true });
      await openRecord(page);
      await page
        .getByTestId('detail-panel')
        .getByRole('button', { name: 'Open in full page' })
        .click();
      await page.setViewportSize({ width: 900, height: 600 });
      await page.evaluate((scale) => {
        document.documentElement.style.zoom = String(scale);
      }, zoom);
      const heading = page
        .getByTestId('markdown-editor')
        .getByRole('heading', { name: TITLE, exact: true });
      await expect(heading).toBeVisible();
      const box = (await heading.boundingBox())!;
      expect(box.width).toBeGreaterThan(200);
      expect(box.x + box.width).toBeLessThanOrEqual(901);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
      expect(await readMockFile(page, RECORD_PATH)).toBe(RECORD);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      if (process.platform === 'darwin' && zoom === 1.25) {
        await expect(page).toHaveScreenshot(`record-${theme}-125.png`, {
          animations: 'disabled',
        });
      }
      await page.screenshot({
        path: info.outputPath(`record-${theme}-${zoom * 100}.png`),
        animations: 'disabled',
      });
      if (zoom === 2) {
        const rail = page.getByTestId('app-rail');
        await rail.getByRole('button', { name: 'Cerebro · Home' }).focus();
        const settings = rail.getByRole('button', { name: 'Settings', exact: true });
        const focusStops: unknown[] = [];
        for (let stop = 0; stop < 20; stop += 1) {
          if (await settings.evaluate((node) => node === document.activeElement)) break;
          await page.keyboard.press('Tab');
          focusStops.push(
            await page.evaluate(() => ({
              tag: document.activeElement?.tagName,
              label: document.activeElement?.getAttribute('aria-label'),
              text: document.activeElement?.textContent?.slice(0, 80),
            })),
          );
        }
        if (!(await settings.evaluate((node) => node === document.activeElement)))
          await info.attach('rail-focus-stops', {
            body: JSON.stringify(focusStops, null, 2),
            contentType: 'application/json',
          });
        await expect(settings, JSON.stringify(focusStops)).toBeFocused();
        const control = (await settings.boundingBox())!;
        expect(control.y).toBeGreaterThanOrEqual(0);
        expect(control.y + control.height).toBeLessThanOrEqual(600);
        await page.keyboard.press('Enter');
        await expect(settings).toHaveAttribute('aria-current', 'page');
        await expect(
          page.getByRole('main').getByRole('heading', { name: 'General', exact: true }),
        ).toBeVisible();
        expect(await readMockFile(page, RECORD_PATH)).toBe(RECORD);
      }
    });
  }
}
