import { test, expect, type Page } from '@playwright/test';

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

async function boot(page: Page, fixture: Partial<Overview>) {
  await page.addInitScript(
    ({ seed }) => {
      window.localStorage.setItem('cerebro.autoLearn', 'false');
      window.localStorage.setItem('cerebro.themeMode', 'light');
      const pending = seed;
      const install = () => {
        const w = window as unknown as { __cerebroSeedPipeline?: (f: unknown) => void };
        if (w.__cerebroSeedPipeline === undefined) {
          setTimeout(install, 10);
          return;
        }
        w.__cerebroSeedPipeline(pending);
      };
      install();
    },
    { seed: fixture },
  );
  await page.goto('/');
  const demoButton = page.getByRole('button', { name: 'Open demo vault' });
  const sidebarTypes = page.getByTestId('sidebar-type');
  await expect(demoButton.or(sidebarTypes.first())).toBeVisible({ timeout: 10_000 });
  if (await demoButton.isVisible()) await demoButton.click();
  await expect(sidebarTypes.first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Background' }).click();
  await expect(page.getByTestId('pipeline-page')).toBeVisible();
}

test('background: the meter says today across every vault, and the activity log says who spent it', async ({
  page,
}) => {
  await boot(page, OVERVIEW);
  await expect(page.getByTestId('ceiling-state')).toHaveAttribute('data-state', 'under_budget');
  await expect(page.getByTestId('meter-runs')).toContainText('3');
  await expect(page.getByTestId('meter-runs')).toContainText('20');
  await expect(page.getByTestId('meter-tokens')).toContainText('41,200');

  const rows = page.getByTestId('activity-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('behind');
  await expect(rows.first()).toContainText('1 applied');
  // A run whose usage was never reported says UNKNOWN, not zero.
  await expect(page.getByTestId('usage-unknown')).toBeVisible();
});

test('background: three faces of failure stay three banners', async ({ page }) => {
  // A person who sees "quota" knows to wait; one who sees "ingestion" knows
  // to fix a file. One merged banner would tell them neither.
  await boot(page, {
    ...OVERVIEW,
    banners: [
      { kind: 'runtime_health', detail: 'the CLI reported a usage limit', count: 12 },
      { kind: 'source_health', detail: 'a source is not answering', count: 1 },
      { kind: 'ingestion', detail: 'items could not be read', count: 3 },
    ],
  });
  const banners = page.getByTestId('pipeline-banner');
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
  await boot(page, {
    ...OVERVIEW,
    meter: { ...OVERVIEW.meter, accounting_state: 'unknown', tokens_used: 0 },
    banners: [{ kind: 'accounting_unknown', detail: 'spend could not be counted', count: 0 }],
  });
  await expect(page.getByTestId('accounting-unknown')).toContainText('is not zero');
  await expect(page.getByTestId('pipeline-banner')).toHaveAttribute(
    'data-kind',
    'accounting_unknown',
  );
});

test('background: the pause is one control for one subscription', async ({ page }) => {
  await boot(page, OVERVIEW);
  // `Button` does not forward data-testid, so the house convention for a
  // button is its accessible name — which is also what a person reads.
  const pause = page.getByRole('button', { name: 'Pause background work' });
  await expect(pause).toBeVisible();
  await pause.click();
  await expect(page.getByRole('button', { name: 'Resume background work' })).toBeVisible();
});

test('background: a lane can be turned off for this vault without touching the others', async ({
  page,
}) => {
  await boot(page, OVERVIEW);
  await expect(page.getByTestId('lane')).toHaveCount(7);
  const stale = page.getByTestId('lane-stale');
  await expect(stale).toBeChecked();
  await stale.click();
  await expect(stale).not.toBeChecked();
  await expect(page.getByTestId('lane-filed')).toBeChecked();
});

test('background: held work asks its question instead of being guessed at', async ({ page }) => {
  await boot(page, {
    ...OVERVIEW,
    held: { baseline_held: 42, recovery_held: 0, pending_review: 0, pending: 0 },
  });
  const held = page.getByTestId('baseline_held');
  await expect(held).toContainText('42 items');
  await expect(held).toContainText('nothing was assumed');
  await page.getByRole('button', { name: 'Process these items' }).click();
  await expect(page.getByTestId('held-items')).toBeHidden();
});

test('background: a vault with nothing to report says so plainly', async ({ page }) => {
  await boot(page, { ...OVERVIEW, activity: [] });
  await expect(page.getByTestId('activity-log')).toContainText('Nothing has run yet');
});
