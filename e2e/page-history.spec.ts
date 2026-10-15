import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile, seedBeforeBoot, type E2eSeedCommit } from './boot';

/**
 * A page's history, as prose, with Restore (M58.4), in the browser.
 *
 * History is the side panel's History tab (D18). Each row names who made the
 * commit from runtime.db's commit record alone (CV-35): a run's commit names
 * its agent, and a commit whose message merely carries a `Cerebro-Run:`
 * trailer reads "unattributed". A row opens the version lens: Changes reads
 * as prose, This version is the page as it was, and Restore writes that
 * version's bytes back as the person's own, a new commit nobody's run made.
 *
 * Through the mock repository (src/lib/mockGit.ts), whose history
 * `window.__cerebroSeedGitHistory` stages before boot, and the mock agent's
 * append script (src/agent/mockAgent.ts) for a run's own commit.
 */

const PAGE = 'delivery/how-we-schedule.md';

const ORIGINAL = '# How we schedule\n\nWe ship when it is ready.\n';
const OLD = '# How we schedule\n\nWe ship on Thursdays, after the freeze.\n';
const NEW = '# How we schedule\n\nWe ship on Fridays, after the review.\n';

// Near the day the demo vault is read on (VAULT_TODAY, 2026-07-28).
const DAY = 86_400;
const NOW = 1_785_240_000;

const HISTORY: E2eSeedCommit[] = [
  {
    hash: 'a'.repeat(40),
    message: 'release-scout: move the ship day',
    date: NOW - DAY,
    files: [{ path: PAGE, status: 'modified' }],
    snapshots: { [PAGE]: NEW },
    run: { runId: 'run-scout-1', actor: 'process:release-scout' },
  },
  {
    hash: 'b'.repeat(40),
    message: 'release-scout: set the ship day\n\nCerebro-Run: run-scout-1',
    date: NOW - 3 * DAY,
    files: [{ path: PAGE, status: 'modified' }],
    snapshots: { [PAGE]: OLD },
  },
  {
    hash: 'c'.repeat(40),
    message: 'Write how we schedule',
    date: NOW - 9 * DAY,
    files: [{ path: PAGE, status: 'added' }],
    snapshots: { [PAGE]: ORIGINAL },
  },
];

/** Boot with the side panel open on History, and open `path`. */
async function openHistory(page: Page, label: string, folder: string) {
  await page.addInitScript(() => {
    window.localStorage.setItem('cerebro.docPanelOpen', 'true');
    window.localStorage.setItem('cerebro.docPanelTab', 'history');
  });
  await boot(page);
  const node = page.getByTestId('collection-node-doc').filter({ hasText: label });
  if (!(await node.isVisible()))
    await page.getByRole('button', { name: `Expand ${folder}` }).click();
  await node.getByRole('button', { name: label }).click();
  const history = page.getByTestId('doc-side-panel').getByTestId('git-history');
  await expect(history).toBeVisible({ timeout: 10_000 });
  return history;
}

test.describe('page history (M58.4)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test('names an agent only on the commit its run recorded', async ({ page }) => {
    await seedBeforeBoot(page, '__cerebroSeedGitHistory', HISTORY);
    const history = await openHistory(page, 'How we schedule', 'Delivery');
    const rows = history.getByTestId('git-commit');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0).getByTestId('commit-author')).toHaveText('Release scout');
    await expect(rows.nth(1).getByTestId('commit-author')).toHaveText('unattributed');
    await expect(rows.nth(2).getByTestId('git-commit-change')).toHaveText('created it');
  });

  test('reads a version as prose, shows the page it was, and restores it', async ({ page }) => {
    await seedBeforeBoot(page, '__cerebroSeedGitHistory', HISTORY);
    const history = await openHistory(page, 'How we schedule', 'Delivery');

    // The newest version, as prose: the words it put in and took out. (The
    // page on disk is the demo vault's own, so every version is restorable.)
    await history.getByTestId('git-commit').nth(0).getByRole('button').first().click();
    const lens = page.getByTestId('version-lens');
    await expect(lens).toBeVisible();
    await expect(lens.getByTestId('prose-ins').first()).toContainText('Fridays');
    await expect(lens.getByTestId('prose-del').first()).toContainText('Thursdays');
    await page.getByRole('button', { name: 'Return to the editor' }).click();

    // The version before it, as the page it was.
    await history.getByTestId('git-commit').nth(1).getByRole('button').first().click();
    await lens.getByTestId('version-tab-version').click();
    await expect(lens.getByTestId('version-preview')).toContainText('We ship on Thursdays', {
      timeout: 10_000,
    });

    // Restore it: the page holds that version's bytes, and History has a
    // new top row that no run made.
    await lens.getByTestId('version-restore').click();
    await expect(page.getByRole('dialog')).toContainText('Restore this version?');
    await page.getByTestId('restore-confirm').click();
    await expect(page.getByTestId('version-lens')).toHaveCount(0);
    await expect.poll(() => readMockFile(page, PAGE)).toBe(OLD);
    const top = history.getByTestId('git-commit').first();
    await expect(top).toContainText('Restore How we schedule to bbbbbbb');
    await expect(top.getByTestId('commit-author')).toHaveText('unattributed');
  });

  test("reads Assistant on the commit a panel turn's run made", async ({ page }) => {
    // A record opens in the peek, whose foot keeps the page's history list.
    const RISK = 'records/risks/risk-scanner-delivery.md';
    await boot(page);
    await page.getByTestId('sidebar').getByRole('button', { name: 'Assistant' }).click();
    const panel = page.getByTestId('ai-panel');
    await expect(panel).toBeVisible();
    await panel.getByLabel('Message the assistant').fill(`append "A dated mitigation." to ${RISK}`);
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect(panel.getByTestId('turn-changeset')).toContainText('Changed 1 file', {
      timeout: 10_000,
    });
    await panel.getByTestId('turn-changeset-view-diff').click();
    const history = page
      .getByRole('complementary', { name: 'Detail panel' })
      .getByTestId('git-history');
    await expect(history).toBeVisible({ timeout: 10_000 });
    const top = history.getByTestId('git-commit').first();
    await expect(top.getByTestId('commit-author')).toHaveText('Assistant');
    await expect(top).toContainText('assistant: append');
    await expect(top).not.toContainText('Cerebro-Run');
    // The lens opened on the run's commit reads it as prose. Opened from the
    // panel it starts on Lines, where review notes go (M58.5).
    await page.getByTestId('version-tab-changes').click();
    await expect(page.getByTestId('version-lens').getByTestId('prose-ins').first()).toContainText(
      'A dated mitigation.',
    );
  });
});
