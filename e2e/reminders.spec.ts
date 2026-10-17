import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  chooseSettingsSection,
  boot,
  readMockFile,
  seedBeforeBoot,
  seedFileBeforeBoot,
  openDestination,
} from './boot';
const vault = '/demo-vault';
const token = (date: string) => `📅 ${date} ((remind:0d))`;
const chip = (date: string) =>
  createHash('sha256')
    .update('cerebro-reminder-chip-v1\0' + token(date))
    .digest('hex')
    .slice(0, 16);
interface Fire {
  path: string;
  chip: string;
  ordinal: number;
  fireAt: string;
  outcome: string;
  claimedAt: string;
}
const fires = async (page: import('@playwright/test').Page) =>
  page.evaluate(
    (vault) =>
      (
        window as unknown as { __cerebroMockReminderFires(vault: string): Fire[] }
      ).__cerebroMockReminderFires(vault),
    vault,
  );

test('reminders missed while closed are claimed once alongside a due reminder', async ({
  page,
}) => {
  await seedFileBeforeBoot(
    page,
    'inbox/reminder-proof.md',
    [
      '# Reminder proof',
      `Call the vendor ${token('2026-07-27 19:00')}`,
      `Send the deck ${token('2026-07-28 10:00')}`,
      `Book the room ${token('2026-07-28 12:00')}`,
      `Future call ${token('2026-07-29 12:00')}`,
    ].join('\n'),
  );
  await seedBeforeBoot(page, '__cerebroSeedSessionWindow', vault, {
    closedAt: '2026-07-27T18:00:00Z',
    reopenedAt: '2026-07-28T11:58:00Z',
    precision: 'clean_exact',
    cause: 'app',
  });
  await boot(page);
  await expect(
    page.getByText(
      '⏰ 2 reminders passed while Cerebro was closed: Call the vendor · Send the deck',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText('⏰ Reminder: Book the room', { exact: true })).toBeVisible();
  await expect
    .poll(async () =>
      (await fires(page))
        .filter((f) => f.path === 'inbox/reminder-proof.md')
        .map((f) => f.outcome)
        .sort(),
    )
    .toEqual(['fired', 'missed', 'missed']);
  await page.reload();
  await expect(page.getByTestId('app-rail')).toBeVisible();
  await expect(page.getByText(/^⏰/)).toHaveCount(0);
});
test('a wiped webview keeps a durable claim quiet while an unclaimed chip fires', async ({
  page,
}) => {
  const path = 'inbox/wipe-proof.md';
  await page.addInitScript(() => localStorage.clear());
  await seedFileBeforeBoot(
    page,
    path,
    `# Wipe proof\nPay the invoice ${token('2026-07-28 12:00')}\nWater the plants ${token('2026-07-28 12:00')}`,
  );
  await seedBeforeBoot(page, '__cerebroSeedReminderFires', vault, [
    {
      path,
      chip: chip('2026-07-28 12:00'),
      ordinal: 0,
      fireAt: '2026-07-28T12:00',
      outcome: 'fired',
      claimedAt: '2026-07-28T12:00:00Z',
    },
  ]);
  await boot(page);
  await expect(page.getByText('⏰ Reminder: Water the plants', { exact: true })).toBeVisible();
  await expect(page.getByText('⏰ Reminder: Pay the invoice', { exact: true })).toHaveCount(0);
  await expect.poll(async () => (await fires(page)).filter((f) => f.path === path).length).toBe(2);
  expect(await page.evaluate(() => localStorage.getItem('cerebro.firedReminders'))).toBeNull();
});

const notifications = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        __cerebroMockNotifications(): {
          state: string;
          requests: number;
          posts: Array<{ id: string; title: string; body: string }>;
        };
      }
    ).__cerebroMockNotifications(),
  );
test('browser permission is unknown, with no request on opening Settings', async ({
  page,
}, testInfo) => {
  await boot(page);
  await openDestination(page, 'Settings');
  await chooseSettingsSection(page, 'Reminders');
  const permission = page.getByTestId('notification-permission');
  await expect(permission).toHaveAttribute('data-state', 'unknown');
  await expect(permission).toHaveText(
    'Unknown. Only the installed app can read this. Reminders still show in Cerebro.',
  );
  await expect(page.getByTestId('reminders-allow')).toHaveCount(0);
  expect((await notifications(page)).requests).toBe(0);
  await permission.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('notification-permission.png') });
});
test('two due reminders saved through the editor give one native banner', async ({ page }) => {
  const path = 'native-reminders.md';
  await seedBeforeBoot(page, '__cerebroSeedNotifications', 'allowed');
  await seedFileBeforeBoot(
    page,
    path,
    `# Native reminders\n\nMy plan.\n\nCall vendor ${token('2026-07-28 12:01')}\n\nBook room ${token('2026-07-28 12:01')}\n`,
  );
  await boot(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Native reminders');
  await page
    .getByTestId('quick-open-result')
    .filter({ hasText: 'Native reminders' })
    .first()
    .click();
  const editor = page.getByTestId('markdown-editor');
  await expect(editor.getByText('My plan.', { exact: true })).toBeVisible();
  await page.clock.setFixedTime(new Date('2026-07-28T12:01:00'));
  await editor.getByText('My plan.', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Saved.');
  await expect.poll(() => readMockFile(page, path)).toContain('Saved.');
  await expect(
    page.getByText('⏰ 2 reminders: Call vendor · Book room', { exact: true }),
  ).toBeVisible();
  await expect.poll(async () => (await notifications(page)).posts.length).toBe(1);
  expect((await notifications(page)).posts[0].title).toBe('2 reminders');
  expect((await notifications(page)).requests).toBe(0);
});
test('two due chips with no recorded writer toast without posting', async ({ page }) => {
  await seedBeforeBoot(page, '__cerebroSeedNotifications', 'allowed');
  await seedFileBeforeBoot(
    page,
    'unrecorded-reminders.md',
    `# Unrecorded reminders\n\nCall vendor ${token('2026-07-28 12:00')}\n\nBook room ${token('2026-07-28 12:00')}\n`,
  );
  await boot(page);
  await expect(
    page.getByText('⏰ 2 reminders: Call vendor · Book room', { exact: true }),
  ).toBeVisible();
  expect((await notifications(page)).posts).toEqual([]);
});
