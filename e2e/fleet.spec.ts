import { test, expect, type Page } from '@playwright/test';
import { boot, openStatusSection, seedBeforeBoot } from './boot';

/**
 * The fleet section (M33.5): every run the app has booked, filterable and
 * inspectable.
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
  return openStatusSection(page, 'fleet');
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
  await expect(section.getByTestId('section-unavailable')).toContainText('run history');
  await expect(section.getByTestId('section-empty')).toHaveCount(0);
});

test('fleet: a genuinely quiet fleet says nothing has run', async ({ page }) => {
  const section = await openFleet(page, []);
  await expect(section.getByTestId('section-empty')).toContainText('Nothing has run');
  await expect(section.getByTestId('section-unavailable')).toHaveCount(0);
});
