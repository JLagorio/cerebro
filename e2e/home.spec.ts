import { expect, test } from '@playwright/test';
import { boot, seedBeforeBoot, readMockFile } from './boot';
import type { FleetRun } from '../src/lib/mockIpc';

const finishedRun = (id: string, actor: string, ended: string): FleetRun => ({
  run_id: id,
  actor,
  vault_id: 'demo',
  mode: 'ambient',
  lane: 'scheduled',
  started_at: ended,
  ended_at: ended,
  outcome: 'succeeded',
  usage_state: 'exact',
  input_tokens: 0,
  output_tokens: 0,
  proposals_submitted: 0,
  applied: 0,
  rejected: 0,
  parent_run_id: null,
  cli_session_id: null,
  cause: {
    kind: 'schedule',
    why: 'its schedule came due',
    subject: null,
    detail: 'daily 09:00',
    due_at: ended,
  },
});
const recentRuns = () => [
  finishedRun('scout-new', 'process:release-scout', '2026-07-28T11:30:00Z'),
  finishedRun('scout-earlier', 'process:release-scout', '2026-07-28T09:19:00Z'),
  finishedRun('review', 'process:weekly-review', '2026-07-27T20:00:00Z'),
];

test('Home groups proposals by when they arrived, leads with deadlines and opens their page', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const card = (id: string, path: string, at: string) => ({
    proposal_id: id,
    commit_set_id: id,
    run_id: 'run-scout-1',
    actor: 'process:release-scout',
    op: 'update_belief',
    effective_risk: 'HIGH',
    review: null,
    queued_for: [],
    intended_use_kind: 'ReversibleWork',
    intended_use_stakes: 'HIGH',
    transition_cause: 'new_evidence',
    evidence_refs: [],
    coverage_refs: [],
    authority_refs: [],
    reason: 'New evidence',
    set_members: [id],
    set_ready: true,
    submitted_at: at,
    targets: [
      {
        target_class: 'belief',
        target_id: id,
        expected_version: 1,
        current_version: 1,
        stale: false,
        path,
      },
    ],
  });
  await seedBeforeBoot(page, '__cerebroSeedReview', {
    cards: [
      card('first', 'knowledge/systems/offline-guarantee.md', '2026-07-28T11:58:00Z'),
      card('second', 'knowledge/metrics/sync-error-rate.md', '2026-07-27T15:00:00Z'),
    ],
  });
  await boot(page);
  const home = page.getByTestId('nav-surfaces').getByRole('button', { name: 'Home', exact: true });
  await home.click();
  const work = page.locator('[data-testid="home-lane"][data-lane="mywork"]');
  await expect(
    work
      .getByTestId('home-section')
      .filter({ has: page.getByRole('heading', { name: 'Overdue', exact: true }) }),
  ).toContainText('Blank-state coaching copy');
  const proposals = page.locator('[data-testid="home-lane"][data-lane="proposals"]');
  await expect(proposals.getByTestId('home-lane-line')).toHaveText('2 proposals waiting');
  await expect(
    proposals
      .getByTestId('home-section')
      .filter({ has: page.getByRole('heading', { name: 'Last few minutes', exact: true }) }),
  ).toHaveCount(1);
  await expect(proposals.getByRole('heading', { name: 'Yesterday', exact: true })).toBeVisible();
  await expect(proposals.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await expect(home).toHaveText('Home');
  const box = await proposals.boundingBox();
  expect(box!.width).toBeGreaterThan(600);
  await page.screenshot({ path: '/private/tmp/cerebro-home.png', animations: 'disabled' });
  await proposals.getByTestId('home-row').first().getByRole('button').click();
  await expect(page.getByTestId('doc-page')).toBeVisible();
});

test('a failed waiting lane leaves other lanes standing and offers no decision', async ({
  page,
}) => {
  await seedBeforeBoot(page, '__cerebroFailNext', 'review_queue');
  await seedBeforeBoot(page, '__cerebroFailNext', 'pending_writes');
  await boot(page);
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Home', exact: true }).click();
  await expect(
    page.locator('[data-lane="proposals"]').getByTestId('section-unavailable'),
  ).toBeVisible();
  await expect(page.locator('[data-lane="mywork"]')).toBeVisible();
  await expect(page.locator('[data-lane="captures"]')).toHaveCount(1);
});

test('empty proposal and disabled capture lanes leave no boxes behind', async ({ page }) => {
  await seedBeforeBoot(page, '__cerebroSeedReview', { cards: [] });
  await page.addInitScript(() => localStorage.setItem('cerebro.inboxEnabled', 'false'));
  await boot(page);
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.locator('[data-lane="mywork"]')).toBeVisible();
  await expect(page.locator('[data-lane="proposals"]')).toHaveCount(0);
  await expect(page.locator('[data-lane="captures"]')).toHaveCount(0);
});

test('a page saved five times shows once in recent edits and opens its current page', async ({
  page,
}) => {
  await seedBeforeBoot(page, '__cerebroSeedActivity', { writes: [] });
  await boot(page);
  const path = 'delivery/how-we-schedule.md';
  const node = page.getByTestId('collection-node-doc').filter({ hasText: 'How we schedule' });
  if (!(await node.isVisible()))
    await page.getByRole('button', { name: 'Expand Delivery' }).click();
  await node.getByRole('button', { name: 'How we schedule' }).click();
  await page.getByTestId('markdown-editor').getByText('Windows, not deadlines').click();
  await page.keyboard.press('End');
  for (let n = 1; n <= 5; n++) {
    await page.keyboard.type(` Home edit ${n}.`);
    await expect.poll(() => readMockFile(page, path)).toContain(`Home edit ${n}.`);
  }
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Home', exact: true }).click();
  const lane = page.locator('[data-lane="edits"]');
  const row = lane.getByTestId('home-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('How we schedule');
  await expect(row).toContainText('edited 5 times');
  await expect(lane.getByRole('heading', { name: 'Last few minutes', exact: true })).toBeVisible();
  await expect(lane).toContainText("Edits made outside Cerebro aren't listed.");
  await row.getByRole('button').click();
  await expect(page.getByTestId('markdown-editor')).toContainText('Home edit 5.');
});

test('finished runs name the first-look window, Done hides only the seen revision and Undo restores it', async ({
  page,
}) => {
  await seedBeforeBoot(page, '__cerebroSeedFleet', [
    ...recentRuns(),
    {
      ...finishedRun('running', 'process:release-scout', '2026-07-28T11:40:00Z'),
      ended_at: null,
      outcome: 'running',
    },
    {
      ...finishedRun('attended', 'process:release-scout', '2026-07-28T11:40:00Z'),
      mode: 'attended',
    },
    finishedRun('construct', 'agent:m26-synthesis', '2026-07-28T11:40:00Z'),
  ]);
  await boot(page);
  const home = page.getByTestId('nav-surfaces').getByRole('button', { name: 'Home', exact: true });
  await home.click();
  const lane = page.locator('[data-lane="runs"]');
  const scout = lane.locator('[data-subject="process:release-scout"]');
  await expect(lane.getByTestId('home-lane-line')).toHaveText('3 runs ended');
  await expect(lane).toContainText("Agents you haven't marked done show their last 7 days.");
  await expect(scout).toContainText('+1 earlier');
  await expect(lane.getByTestId('run-why')).toHaveCount(2);
  await expect(lane.getByRole('heading', { name: 'Last hour', exact: true })).toBeVisible();
  await expect(lane.getByRole('heading', { name: 'Yesterday', exact: true })).toBeVisible();
  await lane.screenshot({ path: '/private/tmp/cerebro-home-events.png' });
  await scout.getByTestId('home-row-done').click();
  await expect(scout).toHaveCount(0);
  await page.getByTestId('toast-host').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(scout).toHaveCount(1);
  await scout.getByTestId('home-row-done').click();
  await expect(scout).toHaveCount(0);
  await page
    .getByTestId('nav-surfaces')
    .getByRole('button', { name: /^Inbox/ })
    .click();
  await page.evaluate(
    (runs) =>
      (window as unknown as { __cerebroSeedFleet: (runs: unknown[]) => void }).__cerebroSeedFleet(
        runs,
      ),
    [...recentRuns(), finishedRun('later', 'process:release-scout', '2026-07-28T11:50:00Z')],
  );
  await home.click();
  await expect(scout).toHaveCount(1);
  await expect(scout).not.toContainText('earlier');
});

test('after each actor has a mark, newer runs say since you looked', async ({ page }) => {
  await seedBeforeBoot(page, '__cerebroSeedFleet', [
    finishedRun('scout-old', 'process:release-scout', '2026-07-26T12:00:00Z'),
    finishedRun('review-old', 'process:weekly-review', '2026-07-26T12:00:00Z'),
  ]);
  await boot(page);
  const home = page.getByTestId('nav-surfaces').getByRole('button', { name: 'Home', exact: true });
  await home.click();
  const lane = page.locator('[data-lane="runs"]');
  for (const actor of ['process:release-scout', 'process:weekly-review']) {
    await lane.locator(`[data-subject="${actor}"]`).getByTestId('home-row-done').click();
    await expect(lane.locator(`[data-subject="${actor}"]`)).toHaveCount(0);
  }
  await page
    .getByTestId('nav-surfaces')
    .getByRole('button', { name: /^Inbox/ })
    .click();
  await page.evaluate(
    (runs) =>
      (window as unknown as { __cerebroSeedFleet: (runs: unknown[]) => void }).__cerebroSeedFleet(
        runs,
      ),
    recentRuns(),
  );
  await home.click();
  await expect(lane.getByTestId('home-lane-line')).toHaveText('3 runs ended since you looked');
});

test('Knowledge Done has Undo, while a missed reminder names its closed window', async ({
  page,
}) => {
  await seedBeforeBoot(page, '__cerebroSeedReminderFires', '/demo-vault', [
    {
      path: 'delivery/how-we-schedule.md',
      chip: '0123456789abcdef',
      ordinal: 0,
      fireAt: '2026-07-27T18:00',
      outcome: 'missed',
      claimedAt: '2026-07-28T11:58:00Z',
    },
  ]);
  await boot(page);
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Home', exact: true }).click();
  const changes = page.locator('[data-lane="changes"]');
  await expect(changes).toContainText('since the last convergence run');
  await changes
    .getByTestId('home-row')
    .getByRole('button', { name: /^Knowledge changed/ })
    .click();
  await expect(changes.getByTestId('change-line').first()).toBeVisible();
  await changes.getByTestId('home-row-done').click();
  await expect(changes).toHaveCount(0);
  await page.getByTestId('toast-host').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(changes).toHaveCount(1);
  await expect(page.locator('[data-lane="reminders"]')).toContainText(
    'Passed while Cerebro was closed',
  );
});
