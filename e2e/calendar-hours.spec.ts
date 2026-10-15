import { expect, test, type Page } from '@playwright/test';
import { boot } from './boot';

/**
 * Calendar hours (M61.8): Week and Day draw an all-day row, then the hours,
 * where a timed record is a block at its minutes. jsdom lays nothing out, so
 * the geometry, the now line and the 07:00 opening scroll are proven here.
 *
 * Three Work items are seeded before the first scan. The browser is pinned to
 * UTC and the clock to VAULT_TODAY (2026-07-28 12:00), so "now" is minute 720
 * of the 28th.
 */

const SEEDS: Record<string, string> = {
  'records/work-items/standup-sync.md': [
    '---',
    'type: Work item',
    'window:',
    '  start: 2026-07-28 10:00',
    '  end: 2026-07-28 11:00',
    '---',
    '',
    '# Standup sync',
    '',
  ].join('\n'),
  'records/work-items/offsite.md': [
    '---',
    'type: Work item',
    'window:',
    '  start: 2026-07-29',
    '  end: 2026-07-30',
    '---',
    '',
    '# Offsite',
    '',
  ].join('\n'),
  'records/work-items/late-deploy.md': [
    '---',
    'type: Work item',
    'window:',
    '  start: 2026-07-28 22:00',
    '  end: 2026-07-29 00:00',
    '---',
    '',
    '# Late deploy',
    '',
  ].join('\n'),
};

/**
 * Seed the mock disk the moment the mock backend publishes it: a setter on
 * the window property runs inside the module's own evaluation, so the files
 * are there before any scan can read the map.
 */
async function seed(page: Page): Promise<void> {
  await page.addInitScript((files: Record<string, string>) => {
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
  }, SEEDS);
}

async function openThisMonth(page: Page): Promise<void> {
  await page.getByTestId('sidebar-type').filter({ hasText: 'Work item' }).first().click();
  const tab = page.getByTestId('view-tabs').getByRole('tab', { name: 'This month' });
  await expect(tab).toBeVisible();
  // Pressing the tab you are already on opens its menu, whose backdrop then
  // swallows every later click.
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await expect(page.getByTestId('calendar-view')).toBeVisible();
}

const path = (slug: string) => `records/work-items/${slug}.md`;

test('calendar hours: Week draws blocks, the all-day row, the now line and opens at 07:00', async ({
  page,
}) => {
  await seed(page);
  await boot(page);
  await openThisMonth(page);
  await page.getByTestId('calendar-span-week').click();

  const view = page.getByTestId('calendar-view');
  const column = (day: string) =>
    view.locator(`[data-testid="calendar-hours-day"][data-day="${day}"]`);

  // A 10:00–11:00 record is a block in its day's column.
  const standup = column('2026-07-28').locator(`[data-path="${path('standup-sync')}"]`);
  await expect(standup).toHaveAttribute('data-testid', 'calendar-block');
  await expect(standup).toHaveAttribute('data-start', '600');
  await expect(standup).toHaveAttribute('data-end', '660');

  // A date-only range sits in the all-day row, and nowhere in the hours. The
  // demo vault's week is busy, so the row may have folded it under "+N more"
  // (the row keeps its lane cap): open the 29th's overflow first.
  const allDay = page.getByTestId('calendar-all-day');
  const more = allDay
    .locator('[data-testid="calendar-day"][data-day="2026-07-29"]')
    .getByRole('button', { name: /more$/ });
  if ((await more.count()) > 0) await more.click();
  await expect(allDay.locator(`[data-path="${path('offsite')}"]`)).toHaveCount(1);
  await expect(
    page.getByTestId('calendar-hours').locator(`[data-path="${path('offsite')}"]`),
  ).toHaveCount(0);

  // 22:00 → 00:00 is a block on the 28th to the end of the day, and on no
  // cell of the 29th.
  const late = column('2026-07-28').locator(`[data-path="${path('late-deploy')}"]`);
  await expect(late).toHaveAttribute('data-start', '1320');
  await expect(late).toHaveAttribute('data-end', '1440');
  await expect(column('2026-07-29').locator(`[data-path="${path('late-deploy')}"]`)).toHaveCount(0);
  await expect(
    view.locator(
      `[data-testid="calendar-day"][data-day="2026-07-29"] [data-path="${path('late-deploy')}"]`,
    ),
  ).toHaveCount(0);

  // The now line, in today's column only.
  const now = page.getByTestId('calendar-now');
  await expect(now).toHaveCount(1);
  await expect(column('2026-07-28').getByTestId('calendar-now')).toHaveAttribute(
    'data-minute',
    '720',
  );

  // The grid opens at 07:00.
  await expect
    .poll(() => page.getByTestId('calendar-hours').evaluate((el) => el.scrollTop))
    .toBe(336);
});

test('calendar hours: Day draws one column, and Month keeps a midnight end on its day', async ({
  page,
}) => {
  await seed(page);
  await boot(page);
  await openThisMonth(page);

  await page.getByTestId('calendar-span-day').click();
  await expect(page.getByTestId('calendar-month')).toHaveText('Tuesday, July 28, 2026');
  await expect(page.getByTestId('calendar-hours-day')).toHaveCount(1);
  await expect(page.getByTestId('calendar-hours-day')).toHaveAttribute('data-day', '2026-07-28');

  await page.getByTestId('calendar-span-month').click();
  const cell = (day: string) => page.locator(`[data-testid="calendar-day"][data-day="${day}"]`);
  await expect(cell('2026-07-28').locator(`[data-path="${path('late-deploy')}"]`)).toHaveCount(1);
  await expect(cell('2026-07-29').locator(`[data-path="${path('late-deploy')}"]`)).toHaveCount(0);
  await expect(page.getByTestId('calendar-hours')).toHaveCount(0);
});
