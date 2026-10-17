import { expect, test, type Page } from '@playwright/test';
import {
  boot,
  openKnowledgeTab,
  seedBeforeBoot,
  type E2eSeedCommit,
  openDestination,
} from './boot';

/**
 * A page's History merges its versions, its edits and its Knowledge changes
 * (M64.2b), in the browser.
 *
 * The side panel's History tab (D18) reads `page_activity` beside M58.4's
 * versions: your typing reads "You edited it" above the commit rows, which
 * still open the version lens; a concept lists what the ledger recorded
 * (seeded, since the browser keeps no ledger: `demoConceptHistory`); a failed
 * read says so while the versions render; and an edit made straight to the
 * mock disk, which another editor's save looks like, puts the outside line
 * at the top.
 */

const PAGE = 'delivery/how-we-schedule.md';

// Near the day the demo vault is read on (VAULT_TODAY, 2026-07-28).
const DAY = 86_400;
const NOW = 1_785_240_000;

const HISTORY: E2eSeedCommit[] = [
  {
    hash: 'd'.repeat(40),
    message: 'Move the ship day',
    date: NOW - 2 * DAY,
    files: [{ path: PAGE, status: 'modified' }],
    snapshots: { [PAGE]: '# How we schedule\n\nWe ship on Fridays.\n' },
  },
  {
    hash: 'e'.repeat(40),
    message: 'Write how we schedule',
    date: NOW - 9 * DAY,
    files: [{ path: PAGE, status: 'added' }],
    snapshots: { [PAGE]: '# How we schedule\n\nWe ship when it is ready.\n' },
  },
];

// A known line to type after (no "inbox", "organize" or "risk": the mock
// agent picks its script by keyword).
const BODY = ['# How we schedule', '', 'We ship on Thursdays, after the freeze.', ''].join('\n');

/** Boot with the side panel open on History, and the page holding BODY. */
async function bootOnHistory(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('cerebro.docPanelOpen', 'true');
    window.localStorage.setItem('cerebro.docPanelTab', 'history');
  });
  await boot(page);
  await page.evaluate(([path, md]) => window.__cerebroMockFs.set(path, md), [PAGE, BODY]);
}

/** Open How we schedule; the History tab is already the chosen one. */
async function openSchedule(page: Page) {
  const node = page.getByTestId('collection-node-doc').filter({ hasText: 'How we schedule' });
  if (!(await node.isVisible()))
    await page.getByRole('button', { name: 'Expand Delivery' }).click();
  await node.getByRole('button', { name: 'How we schedule' }).click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible({ timeout: 10_000 });
  const history = page.getByTestId('doc-side-panel').getByTestId('page-history');
  await expect(history).toBeVisible({ timeout: 10_000 });
  return history;
}

test.describe("a page's History (M64.2b)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
  });

  test('typing puts You edited it above the versions, which still open the lens', async ({
    page,
  }) => {
    await seedBeforeBoot(page, '__cerebroSeedGitHistory', HISTORY);
    await bootOnHistory(page);
    const history = await openSchedule(page);
    await expect(history.getByTestId('git-commit')).toHaveCount(2);

    await page.getByTestId('markdown-editor').getByText('We ship on Thursdays').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Typed for the history.');
    const session = history.getByTestId('history-session').first();
    await expect(session).toHaveText('You edited it', { timeout: 10_000 });

    // Above every version: the first row of the timeline is the session.
    const rows = history.locator('[data-testid="history-session"], [data-testid="git-commit"]');
    await expect(rows.first()).toHaveAttribute('data-testid', 'history-session');
    await history.getByTestId('git-commit').first().getByRole('button').first().click();
    await expect(page.getByTestId('version-lens')).toBeVisible();
  });

  test("Warehouse cutover's History lists what the ledger recorded", async ({ page }) => {
    await bootOnHistory(page);
    await openKnowledgeTab(page, 'all');
    await page.getByTestId('concept-row').filter({ hasText: 'Warehouse cutover' }).first().click();
    await expect(page.getByTestId('doc-page')).toBeVisible();
    if ((await page.getByTestId('doc-side-panel').count()) === 0) {
      await page.getByRole('button', { name: 'Show panel' }).click();
    }
    await page.getByTestId('doc-side-panel').getByTestId('doc-panel-tab-history').click();
    const history = page.getByTestId('doc-side-panel').getByTestId('page-history');
    await expect(
      history.getByTestId('history-concept').filter({ hasText: 'Created by Knowledge agent' }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('a failed read says Edits could not be read while the versions render', async ({ page }) => {
    await seedBeforeBoot(page, '__cerebroSeedGitHistory', HISTORY);
    await bootOnHistory(page);
    await page.evaluate(() => window.__cerebroFailNext('page_activity'));
    const history = await openSchedule(page);
    await expect(
      history.locator('[data-testid="section-unavailable"][data-lane="writes"]'),
    ).toContainText('Edits could not be read');
    await expect(history.getByTestId('git-commit')).toHaveCount(2);
    await expect(history.getByTestId('history-session')).toHaveCount(0);
  });

  test('an edit made outside Cerebro puts the outside line at the top', async ({ page }) => {
    await bootOnHistory(page);
    await openSchedule(page);
    // Your save is the last write Cerebro recorded.
    await page.getByTestId('markdown-editor').getByText('We ship on Thursdays').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Mine.');
    await expect(
      page.getByTestId('doc-side-panel').getByTestId('history-session').first(),
    ).toHaveText('You edited it', { timeout: 10_000 });

    // Another editor changes the file while the page is closed.
    await openDestination(page, 'Home');
    await expect(page.getByTestId('markdown-editor')).toHaveCount(0);
    await page.evaluate(
      ([path]) =>
        window.__cerebroMockFs.set(path, `${window.__cerebroMockFs.get(path)}\nFrom elsewhere.\n`),
      [PAGE],
    );
    const history = await openSchedule(page);
    await expect(history.getByTestId('page-history-outside')).toContainText(
      'changed outside Cerebro',
      { timeout: 10_000 },
    );
  });
});
