import { test, expect, type Page } from '@playwright/test';
import { boot, openKnowledgeTab, seedBeforeBoot } from './boot';

/**
 * The fleet section: who works here (M33b.3) and the run history behind them
 * (M33.5), filterable and inspectable.
 *
 * FIXED SHAPES, NO ENGINE — the same rule the other operational specs state.
 * Ordering, filtering and the 200-row clamp are proved against the real SQL
 * in `runtime::fleet` and mirrored in `mockIpc.test.ts`; a third copy here
 * would be the twin-implementation defect.
 *
 * What this file tests is the SURFACE, and mostly the property M33 turns on:
 * **absent is never zero.** It also carries the one assertion that outlived
 * `pipeline-surface.spec.ts`'s deleted activity tests — a run whose usage was
 * never reported says UNKNOWN, not zero — plus the distinction that surface
 * could not express at all: "nothing has run" and "we could not read the
 * runs" are different sentences.
 */

const RUN = {
  run_id: 'run-2',
  // Typed wide on purpose: `null` is the unattributed category, and inferring
  // `string` here would make the fixture unable to express the case this file
  // most has to cover.
  actor: 'agent:m26-ingest' as string | null,
  vault_id: 'v1',
  mode: 'ambient',
  lane: 'behind',
  started_at: '2026-07-28T11:00:00Z',
  ended_at: '2026-07-28T11:02:00Z',
  outcome: 'succeeded',
  usage_state: 'exact',
  input_tokens: 11_500,
  output_tokens: 900,
  proposals_submitted: 2,
  applied: 1,
  rejected: 1,
};

/** A run whose usage was lost. Its token columns are zero and that is NOT a
 * measurement — the surface has to say so. */
const LOST = {
  ...RUN,
  run_id: 'run-1',
  actor: null,
  lane: 'filed',
  started_at: '2026-07-28T10:00:00Z',
  outcome: 'abandoned_usage_unknown',
  usage_state: 'unknown',
  input_tokens: 0,
  output_tokens: 0,
  proposals_submitted: 0,
  applied: 0,
  rejected: 0,
};

type Run = typeof RUN;
type Detail = { run: Run; cost_components: unknown[] | null; assembly: unknown | null };

async function openFleet(page: Page, runs: Run[] | null, details: Record<string, Detail> = {}) {
  await seedBeforeBoot(page, '__cerebroSeedFleet', runs, details);
  await boot(page);
  await openKnowledgeTab(page, 'Agent work');
  return page.locator('[data-section="fleet"]');
}

test('fleet: runs come back newest first, attributed to whoever ran them', async ({ page }) => {
  const section = await openFleet(page, [LOST, RUN]);
  const rows = section.getByTestId('fleet-row');
  await expect(rows).toHaveCount(2);
  // Newest first, whatever order they were seeded in.
  await expect(rows.first()).toHaveAttribute('data-run', 'run-2');
  await expect(rows.first()).toContainText('agent:m26-ingest');
  await expect(rows.first()).toContainText('1 applied');
  // And the run nobody attributed says so rather than rendering blank.
  await expect(rows.nth(1)).toContainText('unattributed');
});

test('fleet: a run whose usage was never reported says unknown, not zero', async ({ page }) => {
  // Reborn from pipeline-surface.spec.ts, which lost it with the activity
  // table M33.4 deleted.
  const section = await openFleet(page, [LOST]);
  await expect(section.getByTestId('usage-unknown')).toBeVisible();
  await expect(section.getByTestId('fleet-row')).not.toContainText('0 tokens');
});

test('fleet: filtering by actor narrows the list', async ({ page }) => {
  const section = await openFleet(page, [LOST, RUN]);
  await expect(section.getByTestId('fleet-row')).toHaveCount(2);

  await section.getByTestId('fleet-filter-actor').selectOption('agent:m26-ingest');
  await expect(section.getByTestId('fleet-row')).toHaveCount(1);
  await expect(section.getByTestId('fleet-row')).toHaveAttribute('data-run', 'run-2');
});

test('fleet: a run opens, and an unrecorded cost says so rather than showing a zero', async ({
  page,
}) => {
  // Three submitted, two decided: one is still waiting, which is what earns
  // the door to the needs section.
  const undecided = { ...RUN, proposals_submitted: 3 };
  const section = await openFleet(page, [undecided], {
    'run-2': { run: undecided, cost_components: null, assembly: null },
  });
  await section.getByTestId('fleet-row').click();

  const detail = section.getByTestId('run-detail');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('not recorded');
  await expect(detail).not.toContainText('$0');
  await expect(detail.getByTestId('run-detail-to-review')).toContainText('1 still waiting');
});

test('fleet: a run that left nothing undecided offers no door to the review section', async ({
  page,
}) => {
  // RUN submitted two and decided both. A door to an empty queue would be
  // worse than no door.
  const section = await openFleet(page, [RUN], {
    'run-2': { run: RUN, cost_components: null, assembly: null },
  });
  await section.getByTestId('fleet-row').click();
  await expect(section.getByTestId('run-detail')).toBeVisible();
  await expect(section.getByTestId('run-detail-to-review')).toHaveCount(0);
});

test('fleet: recorded components render, and an estimate is marked as one', async ({ page }) => {
  const section = await openFleet(page, [RUN], {
    'run-2': {
      run: RUN,
      cost_components: [
        {
          component: 'output_tokens',
          unit: 'tokens',
          model_id: 'claude-opus-5',
          quantity: 900,
          observed_cost_micros: 13_500,
          estimated: false,
          pricing_snapshot_id: 'snap-1',
          recorded_at: '2026-07-28T11:02:00Z',
        },
        {
          component: 'tool_calls',
          unit: 'calls',
          model_id: null,
          quantity: 4,
          observed_cost_micros: null,
          estimated: true,
          pricing_snapshot_id: null,
          recorded_at: '2026-07-28T11:02:00Z',
        },
      ],
      assembly: null,
    },
  });
  await section.getByTestId('fleet-row').click();

  const components = section.getByTestId('cost-component');
  await expect(components).toHaveCount(2);
  await expect(components.nth(1)).toHaveAttribute('data-estimated', 'true');
  await expect(components.nth(1)).toContainText('estimated');
});

// The distinction the old activity log could not express: it said "Nothing
// has run yet" for both. Two tests rather than one, because `seedBeforeBoot`
// installs an init script per call and a second boot in the same test would
// run both seeds against one page.
test('fleet: an unreadable run history says so', async ({ page }) => {
  const section = await openFleet(page, null);
  // TWO notes, not one, and that is the point: the roster and the history
  // read the fleet separately, so each says what it could not find out. The
  // roster keeps the team on screen — who works here came off the vault, not
  // off the read that failed.
  await expect(section.getByTestId('section-unavailable')).toHaveCount(2);
  await expect(section.getByTestId('agent-row')).toHaveCount(1);
  await expect(section.getByTestId('agent-last-run')).toContainText('not read');
  await expect(section.getByTestId('section-empty')).toHaveCount(0);
});

test('fleet: a genuinely quiet fleet says nothing has run', async ({ page }) => {
  const section = await openFleet(page, []);
  await expect(section.getByTestId('section-empty')).toContainText('Nothing has run');
  await expect(section.getByTestId('section-unavailable')).toHaveCount(0);
  // And the agent is still on screen, because it exists whether or not it has
  // ever run (D6).
  await expect(section.getByTestId('agent-row')).toHaveCount(1);
  await expect(section.getByTestId('agent-last-run')).toContainText('has never run');
  await expect(section.getByTestId('agent-spend')).toContainText('no runs yet');
});

// --- Who works here (M33b.3 / M33b.4) ---------------------------------------

test('fleet: the surface lists agents, and says which of them is a description', async ({
  page,
}) => {
  // demo-vault ships `release-scout` with its `schedule:` deliberately off,
  // which is exactly D6's case: activation is a human act, and an Agent
  // record without a schedule is a description rather than a daemon.
  const section = await openFleet(page, [RUN]);
  const row = section.getByTestId('agent-row');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-actor', 'process:release-scout');
  await expect(row).toContainText('Release scout');
  await expect(section.getByTestId('agent-duty')).toContainText('description, not a daemon');
});

test('fleet: an agent says what it has queued waiting on you', async ({ page }) => {
  // The demo queue holds two of release-scout's proposals awaiting a decision.
  const section = await openFleet(page, [RUN]);
  await expect(section.getByTestId('agent-waiting')).toContainText('2 waiting on you');
});

test('fleet: work that no agent record owns is named, not given a face', async ({ page }) => {
  // The internal constructs run work and are not standing agents. They stay
  // visible in the history and get no roster row.
  const section = await openFleet(page, [RUN, LOST]);
  await expect(section.getByTestId('roster-unowned')).toContainText('agent:m26-ingest');
  await expect(section.getByTestId('agent-row')).toHaveCount(1);
});

test('fleet: clicking an agent narrows the history to its runs', async ({ page }) => {
  const scoutRun = { ...RUN, run_id: 'run-scout', actor: 'process:release-scout' };
  const section = await openFleet(page, [scoutRun, LOST]);
  await expect(section.getByTestId('fleet-row')).toHaveCount(2);

  await section.getByTestId('agent-row').click();
  await expect(section.getByTestId('fleet-row')).toHaveCount(1);
  await expect(section.getByTestId('fleet-row')).toHaveAttribute('data-run', 'run-scout');
  // The chip and the selection are one filter, so the chip says so too.
  await expect(section.getByTestId('fleet-filter-actor')).toHaveValue('process:release-scout');

  // And clicking again lets go of it: a filter you cannot clear is a trap.
  await section.getByTestId('agent-row').click();
  await expect(section.getByTestId('fleet-row')).toHaveCount(2);
});

test('fleet: a run row says when it happened', async ({ page }) => {
  // Carried from M33.1–.10. The rows named who, what lane, what outcome and
  // what it cost, and never once said WHEN — so "newest first" was an
  // ordering nobody could verify. The clock is pinned to VAULT_TODAY and the
  // fixture sits an hour before it.
  const section = await openFleet(page, [RUN]);
  const when = section.getByTestId('fleet-when');
  await expect(when).toContainText('hour');
  await expect(when).toHaveAttribute('title', RUN.started_at);
});
