import { expect, test, type Page } from '@playwright/test';
import {
  boot,
  openHistory,
  readMockFile,
  seedBeforeBoot,
  type E2eSeedCommit,
  openDestination,
} from './boot';

/**
 * History reads who changed what (M64.2): editing sessions, agent runs and
 * checkpoints by day, under a year heatmap, against the mock backend's
 * activity read (`vaultActivity`) and its demo history (`demoActivity`).
 * The clock is VAULT_TODAY, 2026-07-28, and the browser runs in UTC.
 */

const PAGE = 'delivery/how-we-schedule.md';

async function openSchedule(page: Page): Promise<void> {
  const node = page.getByTestId('collection-node-doc').filter({ hasText: 'How we schedule' });
  if (!(await node.isVisible()))
    await page.getByRole('button', { name: 'Expand Delivery' }).click();
  await node.getByRole('button', { name: 'How we schedule' }).click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible({ timeout: 10_000 });
}

const day = (page: Page, key: string) =>
  page.locator(`[data-testid="heatmap-day"][data-day="${key}"]`);

test('five saves to one page fold into one session', async ({ page }) => {
  await boot(page);
  await openSchedule(page);
  await page.getByTestId('markdown-editor').getByText('Windows, not deadlines').click();
  await page.keyboard.press('End');
  for (let n = 1; n <= 5; n++) {
    await page.keyboard.type(` Save ${n}.`);
    await expect.poll(() => readMockFile(page, PAGE)).toContain(`Save ${n}.`);
  }
  const saves = await page.evaluate(
    (path) => window.__cerebroMockWrites.filter((w) => w.path === path).length,
    PAGE,
  );
  expect(saves).toBeGreaterThanOrEqual(5);

  await openHistory(page);
  const today = page.locator('[data-testid="history-day"][data-day="2026-07-28"]');
  const sessions = today.getByTestId('history-session');
  await expect(sessions).toHaveCount(1);
  await expect(sessions).toHaveText('You edited How we schedule');
  await expect(day(page, '2026-07-28')).toHaveAttribute('data-state', 'recorded');
});

test('a day Cerebro was closed, or before it recorded, reads not recorded, never 0', async ({
  page,
}) => {
  await boot(page);
  await openHistory(page);
  // Cerebro was open on 07-20, but recording began on 07-21.
  await expect(day(page, '2026-07-20')).toHaveAttribute('data-state', 'not-recorded');
  await expect(day(page, '2026-07-20')).toHaveAttribute('data-sessions', '');
  // Nobody had Cerebro open on 07-25.
  await expect(day(page, '2026-07-25')).toHaveAttribute('data-state', 'not-recorded');
  await expect(day(page, '2026-07-25')).toHaveAttribute(
    'title',
    "Sat, Jul 25, 2026 — not recorded: Cerebro wasn't open",
  );
  // Open on 07-22, and nobody edited.
  await expect(day(page, '2026-07-22')).toHaveAttribute('data-state', 'recorded');
  await expect(day(page, '2026-07-22')).toHaveAttribute('data-sessions', '0');
  await expect(day(page, '2026-07-22')).toHaveAttribute('title', 'Wed, Jul 22, 2026 — no edits');
  await expect(page.getByTestId('heatmap-seam')).toHaveText(
    'Cerebro began recording edits here on Tue, Jul 21, 2026.',
  );
  await expect(page.getByTestId('history-outside')).toBeVisible();
});

test('a failed activity read says so, and the checkpoints still render', async ({ page }) => {
  const commit: E2eSeedCommit = {
    hash: 'd4'.repeat(20),
    message: 'Checkpoint before the cutover',
    author: 'Ana Rios',
    date: Date.UTC(2026, 6, 28, 10) / 1000,
    files: [{ path: PAGE, status: 'modified' }],
    snapshots: {},
  };
  await seedBeforeBoot(page, '__cerebroSeedGitHistory', [commit]);
  await boot(page);
  await page.evaluate(() => window.__cerebroFailNext('vault_activity'));
  await openDestination(page, 'History');

  const heatmap = page.getByTestId('history-heatmap');
  const feed = page.getByTestId('history-feed');
  await expect(heatmap.getByTestId('section-unavailable')).toBeVisible();
  await expect(feed.getByTestId('section-unavailable')).toBeVisible();
  await expect(heatmap.getByTestId('heatmap-day')).toHaveCount(0);
  await expect(feed.getByTestId('history-session')).toHaveCount(0);
  const card = page.locator('[data-testid="history-day"][data-day="2026-07-28"]');
  await expect(card.getByTestId('pulse-commit')).toContainText('Checkpoint before the cutover');

  // The failure was one read: Retry reads again.
  await page.getByTestId('activity-retry').click();
  await expect(heatmap.getByTestId('heatmap-day').first()).toBeVisible();
  await expect(feed.getByTestId('history-session').first()).toBeVisible();
});

test('a run names why it ran and the page it wrote', async ({ page }) => {
  await boot(page);
  await openHistory(page);
  const scout = page.locator('[data-testid="history-run"][data-run="run-scout-1"]');
  await expect(scout).toContainText('Release scout ran');
  await expect(scout).toContainText('its schedule came due');
  await expect(scout).toContainText('wrote Scanner hardware delivery is slipping');
});
