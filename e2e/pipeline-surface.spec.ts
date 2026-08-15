import { test, expect, type Page } from '@playwright/test';
import { boot, openStatusSection, seedBeforeBoot } from './boot';

/**
 * The M25.7 control surface: what the background ran, what it spent, and what
 * it is waiting on.
 *
 * The browser mock serves FIXED SHAPES and computes nothing — a second budget
 * engine in `mockIpc` would be the twin-implementation defect the shared
 * artifacts exist to prevent, arrived at from the operational side. The real
 * arithmetic is one SQLite transaction in `runtime/budget.rs`, proved there.
 * What these specs test is the SURFACE: that the meter reads across vaults,
 * that three faces of failure stay three banners, that an unaccounted day
 * says so rather than showing a confident zero, and that held work asks its
 * question instead of being guessed at.
 *
 * **M33.4 moved the home, not the behaviour.** These controls are the Status
 * hub's "Background" section now; there is no background tab. Every testid
 * below is unchanged on purpose — that is what makes this file able to prove
 * the extraction dropped nothing.
 *
 * The activity-log tests that used to live here are GONE, not moved: the old
 * 50-row table was not clickable and had no detail view, and M33.5's fleet
 * section replaces it with one that filters, attributes and opens. Its specs
 * are in `fleet.spec.ts`, including the "unknown, never zero" assertion this
 * file used to carry.
 */

const OVERVIEW = {
  global_pause: false,
  runtime_status: 'ready',
  meter: {
    window_start_utc: '2026-08-09T00:00:00.000Z',
    window_end_utc: '2026-08-10T00:00:00.000Z',
    timezone_id: 'UTC',
    ceiling_state: 'under_budget',
    ceiling_reasons: [] as string[],
    accounting_state: 'exact',
    runs_started: 3,
    max_daily_runs: 20,
    tokens_used: 41_200,
    max_daily_tokens: 200_000,
    output_tokens_used: 3_100,
    max_daily_output_tokens: 40_000,
    reserved_total_tokens: 0,
    reserved_output_tokens: 0,
  },
  lanes: ['filed', 'scheduled', 'agent', 'behind', 'refresh', 'stale', 'schema'].map(
    (lane, priority) => ({ lane, priority, enabled: true }),
  ),
  activity: [
    {
      run_id: 'run-2',
      vault_id: 'v1',
      mode: 'ambient',
      lane: 'behind',
      started_at: '2026-08-09T11:00:00.000Z',
      ended_at: '2026-08-09T11:02:00.000Z',
      outcome: 'succeeded',
      usage_state: 'exact',
      total_tokens: 12_400,
      output_tokens: 900,
      proposals_submitted: 2,
      applied: 1,
      rejected: 1,
    },
    {
      run_id: 'run-1',
      vault_id: 'v1',
      mode: 'ambient',
      lane: 'filed',
      started_at: '2026-08-09T10:00:00.000Z',
      ended_at: '2026-08-09T10:05:00.000Z',
      outcome: 'abandoned_usage_unknown',
      usage_state: 'unknown',
      total_tokens: 0,
      output_tokens: 0,
      proposals_submitted: 0,
      applied: 0,
      rejected: 0,
    },
  ],
  banners: [] as { kind: string; detail: string; count: number }[],
  held: { baseline_held: 0, recovery_held: 0, pending_review: 0, pending: 0 },
};

type Overview = typeof OVERVIEW;

/** Boot into the hub with this overview staged, and hand back the section
 * that holds the background controls. */
async function openSystem(page: Page, fixture: Partial<Overview>) {
  await seedBeforeBoot(page, '__cerebroSeedPipeline', fixture);
  await boot(page);
  return openStatusSection(page, 'system');
}

test('background: the meter says today across every vault', async ({ page }) => {
  const section = await openSystem(page, OVERVIEW);
  await expect(section.getByTestId('ceiling-state')).toHaveAttribute('data-state', 'under_budget');
  await expect(section.getByTestId('meter-runs')).toContainText('3');
  await expect(section.getByTestId('meter-runs')).toContainText('20');
  await expect(section.getByTestId('meter-tokens')).toContainText('41,200');
  // The activity half of this test moved to `fleet.spec.ts` with the table
  // it asserted on — including "a run whose usage was never reported says
  // UNKNOWN, not zero", which the fleet section carries verbatim.
  await expect(section.getByTestId('activity-row')).toHaveCount(0);
});

test('background: three faces of failure stay three banners', async ({ page }) => {
  // A person who sees "quota" knows to wait; one who sees "ingestion" knows
  // to fix a file. One merged banner would tell them neither.
  const section = await openSystem(page, {
    ...OVERVIEW,
    banners: [
      { kind: 'runtime_health', detail: 'the CLI reported a usage limit', count: 12 },
      { kind: 'source_health', detail: 'a source is not answering', count: 1 },
      { kind: 'ingestion', detail: 'items could not be read', count: 3 },
    ],
  });
  const banners = section.getByTestId('pipeline-banner');
  await expect(banners).toHaveCount(3);
  await expect(banners.nth(0)).toHaveAttribute('data-kind', 'runtime_health');
  await expect(banners.nth(0)).toContainText('Claude Code is not answering');
  await expect(banners.nth(0)).toContainText('12 items');
  await expect(banners.nth(1)).toHaveAttribute('data-kind', 'source_health');
  await expect(banners.nth(2)).toContainText('Some items could not be read');
});

test('background: an unaccounted day says so rather than showing a confident zero', async ({
  page,
}) => {
  const section = await openSystem(page, {
    ...OVERVIEW,
    meter: { ...OVERVIEW.meter, accounting_state: 'unknown', tokens_used: 0 },
    banners: [{ kind: 'accounting_unknown', detail: 'spend could not be counted', count: 0 }],
  });
  await expect(section.getByTestId('accounting-unknown')).toContainText('is not zero');
  await expect(section.getByTestId('pipeline-banner')).toHaveAttribute(
    'data-kind',
    'accounting_unknown',
  );
});

test('background: the pause is one control for one subscription', async ({ page }) => {
  const section = await openSystem(page, OVERVIEW);
  // Located by accessible name, which is also what a person reads. (M33.3
  // gave `Button` a real `testId` prop; this control never needed one.)
  const pause = section.getByRole('button', { name: 'Pause background work' });
  await expect(pause).toBeVisible();
  await pause.click();
  await expect(section.getByRole('button', { name: 'Resume background work' })).toBeVisible();
});

test('background: a lane can be turned off for this vault without touching the others', async ({
  page,
}) => {
  const section = await openSystem(page, OVERVIEW);
  await expect(section.getByTestId('lane')).toHaveCount(7);
  const stale = section.getByTestId('lane-stale');
  await expect(stale).toBeChecked();
  await stale.click();
  await expect(stale).not.toBeChecked();
  await expect(section.getByTestId('lane-filed')).toBeChecked();
});

test('background: held work asks its question instead of being guessed at', async ({ page }) => {
  const section = await openSystem(page, {
    ...OVERVIEW,
    held: { baseline_held: 42, recovery_held: 0, pending_review: 0, pending: 0 },
  });
  const held = section.getByTestId('baseline_held');
  await expect(held).toContainText('42 items');
  await expect(held).toContainText('nothing was assumed');
  await section.getByRole('button', { name: 'Process these items' }).click();
  await expect(section.getByTestId('held-items')).toBeHidden();
});

// DELETED in M33.4: 'a vault with nothing to report says so plainly'. It
// asserted the activity log's empty text, and the activity log left with the
// table. `fleet.spec.ts` carries the empty case for the surface that replaced
// it — where "nothing has run" and "we could not read the runs" are also
// finally two different sentences, which this one could not express.
