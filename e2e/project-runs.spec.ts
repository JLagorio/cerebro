import { expect, test, type Page } from '@playwright/test';
import type { FleetRun } from '../src/lib/ipc';
import { boot, seedBeforeBoot } from './boot';

const assigned: FleetRun = {
  run_id: 'ga-assigned',
  actor: 'process:release-scout',
  vault_id: 'demo',
  mode: 'ambient',
  lane: 'filed',
  started_at: '2026-07-28T12:00:00Z',
  ended_at: '2026-07-28T12:01:00Z',
  outcome: 'succeeded',
  usage_state: 'exact',
  input_tokens: 50,
  output_tokens: 10,
  proposals_submitted: 0,
  applied: 0,
  rejected: 0,
  parent_run_id: null,
  cause: {
    kind: 'assigned',
    why: 'work was assigned to it',
    subject: 'projects/guided-onboarding-ga/items/fld-4.md',
    detail: 'via agent',
    due_at: null,
  },
  cli_session_id: null,
};
async function openRuns(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Guided onboarding GA');
  await page
    .getByTestId('quick-open-result')
    .filter({ hasText: 'Guided onboarding GA' })
    .first()
    .click();
  await page.getByTestId('detail-panel').getByRole('button', { name: 'Open in full page' }).click();
  await page.getByTestId('record-tab-runs').click();
}
test('a project places recorded subjects and hops, leaving unrelated and legacy runs out', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await seedBeforeBoot(page, '__cerebroSeedFleet', [
    assigned,
    {
      ...assigned,
      run_id: 'ga-hop',
      actor: 'process:knowledge',
      parent_run_id: assigned.run_id,
      cause: null,
    },
    {
      ...assigned,
      run_id: 'phoenix',
      cause: { ...assigned.cause!, subject: 'projects/phoenix-warehouse-rollout/items/ops-1.md' },
    },
    { ...assigned, run_id: 'legacy', cause: null },
    { ...assigned, run_id: 'another-vault', vault_id: 'other' },
  ]);
  await boot(page);
  await openRuns(page);
  const rows = page.getByTestId('page-run-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute('data-run', 'ga-assigned');
  await expect(rows.first()).toContainText('Release scout');
  await expect(rows.first()).toContainText('Blank-state coaching copy');
  await expect(rows.first()).toContainText('work was assigned to it (via agent)');
  await expect(rows.last()).toHaveAttribute('data-depth', '1');
  await expect(rows.last()).toContainText('Knowledge agent');
  await expect(page.getByTestId('page-runs-footnote')).toHaveText(
    "Runs from before Cerebro recorded why a run started can't be placed on a page.",
  );
  await page.screenshot({
    path: testInfo.outputPath('project-runs.png'),
    fullPage: true,
    animations: 'disabled',
  });
});
test('an unreadable fleet says unavailable on the project', async ({ page }) => {
  await seedBeforeBoot(page, '__cerebroSeedFleet', null);
  await boot(page);
  await openRuns(page);
  await expect(page.getByTestId('page-runs').getByTestId('section-unavailable')).toHaveText(
    "Couldn't read this page's runs.",
  );
  await expect(page.getByTestId('page-runs-empty')).toHaveCount(0);
});
