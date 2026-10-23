import { expect, test } from '@playwright/test';
import { boot, readMockFile, seedFileBeforeBoot, showDatabases } from './boot';
import { chooseOption } from './select';

test('a date property reminds its unfinished records and stores the type setting', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 2000, height: 1080 });
  await boot(page);
  await showDatabases(page);
  await page.getByTestId('sidebar-type').filter({ hasText: 'Work item' }).first().click();
  await page.getByRole('button', { name: 'Due column menu' }).click();
  await page.getByRole('menuitem', { name: 'Edit property', exact: true }).click();
  const setting = page.getByTestId('property-remind');
  await expect(setting).toContainText(
    'Every Work item with a Due reminds. Dates without a time remind at 9:00 AM.',
  );
  await chooseOption(setting.getByRole('button', { name: 'Remind' }), '1 day before');
  await expect
    .poll(() => readMockFile(page, 'types/work-item.md'))
    .toMatch(/due:\s*\n\s+kind: date\s*\n\s+remind: 1d/);
  await expect(
    page.getByText('⏰ Reminder (3h late): Conflict resolution UX spec · Due', { exact: true }),
  ).toBeVisible();
  const box = await setting.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(2000);
  await page.screenshot({ path: testInfo.outputPath('property-reminder.png') });
  await chooseOption(setting.getByRole('button', { name: 'Remind' }), 'None');
  await expect.poll(() => readMockFile(page, 'types/work-item.md')).not.toMatch(/remind: 1d/);
});

test('a timed date chip labels its own reminder time and explains in-app delivery', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await seedFileBeforeBoot(
    page,
    'reminder-label.md',
    '# Reminder label\n\nCheck tomorrow 📅 2026-07-29 16:00 ((remind:1d))\n',
  );
  await boot(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Reminder label');
  await page.getByTestId('quick-open-result').filter({ hasText: 'Reminder label' }).first().click();
  await expect(page.getByTestId('doc-title')).toHaveText('Reminder label');
  await page.locator('[data-chip="due"] button').click();
  const picker = page.getByTestId('date-picker');
  await picker.getByRole('button', { name: 'Remind 1 day before, 4:00 PM' }).click();
  await expect(
    picker.getByRole('menuitemradio', { name: 'On day of event, 4:00 PM' }),
  ).toBeVisible();
  await expect(picker).not.toContainText('9:00 AM');
  await expect(picker).toContainText(
    'Reminders show in Cerebro. Allow notifications in Settings to also see them in Notification Center. A reminder that passes while Cerebro is closed is said once when it opens.',
  );
  await page.screenshot({ path: testInfo.outputPath('timed-reminder.png') });
});
