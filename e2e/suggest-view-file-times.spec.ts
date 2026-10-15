import { expect, test } from '@playwright/test';
import { boot, readMockFile } from './boot';

test('a suggested calendar places file times and cannot write them through arrow keys', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  const path = 'projects/guided-onboarding-ga/items/fld-4.md';
  const before = await readMockFile(page, path);
  await page.getByTestId('sidebar').getByRole('button', { name: 'Assistant' }).click();
  const panel = page.getByTestId('ai-panel');
  await panel.getByLabel('Message the assistant').fill(
    'suggest view ' +
      JSON.stringify({
        database: 'Work item',
        view: {
          name: 'Created calendar',
          filters: {
            all: [{ field: 'title', op: 'equals', value: 'Blank-state coaching copy' }],
          },
          presentation: { type: 'calendar', dateField: 'createdAt' },
        },
      }),
  );
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  const card = page.getByTestId('view-suggestion-card');
  await expect(card).toContainText('Live preview · 1 of 45 records');
  await expect(
    card.getByTestId('calendar-day').filter({ has: page.getByText('24', { exact: true }) }),
  ).toHaveAttribute('data-count', '1');
  await card.getByRole('button', { name: 'Add as a tab' }).click();
  await card.getByRole('button', { name: 'Open Work item' }).click();
  const calendar = page.getByTestId('type-page').getByTestId('calendar-view');
  const row = calendar.getByRole('button', { name: /Blank-state coaching copy/ });
  await expect(row).toBeVisible();
  await row.focus();
  await row.press('ArrowRight');
  expect(await readMockFile(page, path)).toBe(before);
  await expect(row).not.toHaveAttribute('aria-label', /Arrow keys/);
  await page.screenshot({ path: '/private/tmp/cerebro-file-time-calendar.png', fullPage: true });
});
