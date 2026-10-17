import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile, showDatabases } from './boot';

const SERIES = 'records/standups/daily-standup.md';
const ODD = 'records/standups/odd-sync.md';
const seeds: Record<string, string> = {
  'types/standup.md': `---
type: Type
folder: records/standups-detached
fields:
  when: {kind: daterange}
  repeat: {kind: repeat}
layout:
  heading: [when, repeat]
views:
  - id: all
    name: All
    presentation: {type: table, columns: [{field: when}, {field: repeat}]}
  - id: calendar
    name: Calendar
    presentation: {type: calendar, dateField: when}
---

# Standup
`,
  [SERIES]: `---
type: Standup
when: {start: '2026-07-28 09:00', end: '2026-07-28 09:15'}
repeat: FREQ=WEEKLY;BYDAY=TU,TH
---

# Daily standup
`,
  [ODD]: `---
type: Standup
when: {start: '2026-07-29 10:00', end: '2026-07-29 10:30'}
repeat: FREQ=MONTHLY;BYDAY=WE;BYSETPOS=2
---

# Odd sync
`,
};
async function seed(page: Page) {
  await page.addInitScript((files) => {
    Object.defineProperty(window, '__cerebroMockFs', {
      configurable: true,
      set(map: Map<string, string>) {
        for (const [path, raw] of Object.entries(files)) map.set(path, raw);
        Object.defineProperty(window, '__cerebroMockFs', {
          configurable: true,
          writable: true,
          value: map,
        });
      },
    });
  }, seeds);
}
async function openRecord(page: Page, title: string) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill(title);
  await page.getByTestId('quick-open-result').filter({ hasText: title }).first().click();
  await page.getByTestId('detail-panel').getByRole('button', { name: 'Open in full page' }).click();
  await expect(page.getByTestId('doc-title')).toHaveText(title);
}
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await seed(page);
  await boot(page);
});

test('Repeat reads in words, edits a preset, keeps unknown raw text and clears the key', async ({
  page,
}, testInfo) => {
  await openRecord(page, 'Daily standup');
  await expect(page.getByRole('button', { name: 'Repeat', exact: true })).toHaveText(
    'Weekly on Tuesday and Thursday',
  );
  await page.getByRole('button', { name: 'Repeat', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Repeat', exact: true });
  await dialog.getByTestId('repeat-pattern').selectOption('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(1000);
  await page.screenshot({
    path: testInfo.outputPath('repeat-editor.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect
    .poll(() => readMockFile(page, SERIES))
    .toContain('repeat: FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
  await expect(page.getByRole('button', { name: 'Repeat', exact: true })).toHaveText(
    'Every weekday',
  );
  await openRecord(page, 'Odd sync');
  await expect(page.getByRole('button', { name: 'Repeat', exact: true })).toHaveText(
    'Repeat rule not understood',
  );
  await page.getByRole('button', { name: 'Repeat', exact: true }).click();
  await expect(dialog.getByTestId('repeat-raw')).toHaveText('FREQ=MONTHLY;BYDAY=WE;BYSETPOS=2');
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
  await dialog.getByTestId('repeat-pattern').selectOption('none');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => readMockFile(page, ODD)).not.toMatch(/^repeat:/m);
});

async function calendar(page: Page) {
  await showDatabases(page);
  await page.getByTestId('sidebar-type').filter({ hasText: 'Standup' }).click();
  const tab = page.getByTestId('view-tabs').getByRole('tab', { name: 'Calendar', exact: true });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await expect(page.getByTestId('calendar-view')).toBeVisible();
}
test('calendar occurrences are read-only, This event is one undoable split and All events opens the series', async ({
  page,
}, testInfo) => {
  await calendar(page);
  await page.getByRole('button', { name: 'Next month', exact: true }).click();
  const cell = (day: string) => page.locator(`[data-testid="calendar-day"][data-day="${day}"]`);
  for (const day of ['2026-07-28', '2026-07-30', '2026-08-04', '2026-08-06'])
    await expect(cell(day).locator(`[data-path="${SERIES}"][data-occurrence]`)).toHaveCount(1);
  const before = await readMockFile(page, SERIES);
  const event = cell('2026-08-04').locator(`[data-path="${SERIES}"]`);
  const origin = await event.boundingBox();
  const destination = await cell('2026-08-05').boundingBox();
  await page.mouse.move(origin!.x + origin!.width / 2, origin!.y + origin!.height / 2);
  await page.mouse.down();
  await page.mouse.move(destination!.x + destination!.width / 2, destination!.y + 40, { steps: 8 });
  await page.mouse.up();
  await event.focus();
  await event.press('ArrowRight');
  expect(await readMockFile(page, SERIES)).toBe(before);
  await expect(page.locator(`[data-path="${ODD}"][data-repeat="not-understood"]`)).toHaveCount(1);
  await event.click();
  const menu = page.getByTestId('occurrence-menu');
  await expect(menu).toContainText('Tuesday, August 4 · 9:00 AM – 9:15 AM');
  const box = await menu.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(1440);
  expect(box!.y + box!.height).toBeLessThanOrEqual(1000);
  await page.screenshot({
    path: testInfo.outputPath('occurrence-menu.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await menu.getByTestId('occurrence-this').click();
  const created = 'records/standups-detached/daily-standup-2026-08-04.md';
  await expect(page.getByTestId('doc-title')).toHaveText('Daily standup');
  await expect.poll(() => readMockFile(page, SERIES)).toContain('EXDATE:20260804T090000');
  const raw = await readMockFile(page, created);
  expect(raw).toContain('2026-08-04 09:00');
  expect(raw).toContain('2026-08-04 09:15');
  expect(raw).toContain('Split from [[daily-standup]]: the Tuesday, August 4, 2026 occurrence.');
  expect(raw).not.toMatch(/^repeat:/m);
  await page.getByTestId('toast-host').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => readMockFile(page, SERIES)).toBe(before);
  await expect
    .poll(() => page.evaluate((path) => window.__cerebroMockFs.has(path), created))
    .toBe(false);
  await calendar(page);
  await page.getByTestId('calendar-span-week').click();
  const block = page.getByTestId('calendar-block').filter({ hasText: 'Daily standup' }).first();
  await expect(block).toHaveAttribute('data-start', '540');
  await expect(block.locator('[data-calendar-handle]')).toHaveCount(0);
  await block.focus();
  await block.press('ArrowDown');
  expect(await readMockFile(page, SERIES)).toBe(before);
  await block.click();
  await page.getByTestId('occurrence-all').click();
  await expect(page.getByTestId('doc-title')).toHaveText('Daily standup');
  await expect(page.getByRole('button', { name: 'Repeat', exact: true })).toHaveText(
    'Weekly on Tuesday and Thursday',
  );
});
