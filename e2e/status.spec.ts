import { test, expect, type Page } from '@playwright/test';
import { boot } from './boot';

/**
 * The Epistemic Status surface (M27.8d, §35 skeleton).
 *
 * FIXED SHAPES, NO ENGINE — the same rule the M25 control-surface specs
 * state. Lane order, reason ranking, the freshness clock and the coverage
 * fold are proved in Rust against shared artifacts and goldens; a second
 * copy of any of them here would be the twin-implementation defect
 * `shared/policy/README.md` exists to prevent.
 *
 * What these specs test is the SURFACE, and mostly ONE property of it: that
 * a section which could not read its feed never renders as a section with
 * nothing in it. "There are no contradictions" and "we could not tell you
 * whether there are contradictions" are opposite sentences, and a page that
 * says the first when it means the second is worse than a page that says
 * nothing.
 */

function lane(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    label: id === 'contradiction' ? 'Contradictions' : id,
    blurb: 'what belongs here',
    empty_text: `Nothing in ${id}.`,
    protected: id === 'contradiction' || id === 'blindness',
    items: [],
    withheld: 0,
    ...over,
  };
}

const LANES = {
  rule_version: 'lanes-v1',
  lanes: [lane('contradiction'), lane('blindness'), lane('staleness'), lane('epistemic_debt')],
  withheld: 0,
  incomplete: [] as string[],
};

const STALE_ITEM = {
  lane: 'staleness',
  belief_id: 'b'.repeat(32),
  entity_id: 'sync-error-rate',
  path: 'metrics/sync-error-rate.md',
  predicate: 'ci_status',
  state_stage: 'implemented',
  scope_text: 'ci_status at implemented',
  reasons: ['freshness_stale'],
  reason_text: 'past its freshness rule',
  reliance: ['qualified'],
  reliance_text: 'relied on: promoted past draft',
  edge_id: null,
  relation_id: null,
};

const QUIET_CHANGES = {
  schema_version: 'convergence-v1',
  window: { from_seq: 0, to_seq: 0 },
  quiet: true,
  sections: [],
};

async function open(
  page: Page,
  seed: { lanes?: unknown; changes?: unknown | null; review?: unknown } = {},
): Promise<void> {
  await boot(page);
  await page.evaluate(
    ({ lanes, changes, review }) => {
      window.__cerebroSeedLanes(lanes);
      window.__cerebroSeedChanges(changes);
      // Seeded before the hub mounts, so its first read already has them
      // (M33.3 — the needs section reads the queue itself now).
      if (review !== undefined) window.__cerebroSeedReview(review);
    },
    {
      lanes: seed.lanes ?? LANES,
      changes: seed.changes === undefined ? QUIET_CHANGES : seed.changes,
      review: seed.review,
    },
  );
  await page.getByTestId('rail').getByRole('button', { name: 'Epistemic status' }).click();
  await expect(page.getByTestId('status-page')).toBeVisible();
}

test('status: every lane is on the page, and an empty one says so in its own words', async ({
  page,
}) => {
  await open(page);

  // All four, including the ones holding nothing. A lane that appeared only
  // when it had contents would make "no coverage gaps" and "coverage was
  // never computed" the same screen.
  for (const id of ['contradiction', 'blindness', 'staleness', 'epistemic_debt']) {
    await expect(page.locator(`[data-section="${id}"]`)).toBeVisible();
    await expect(page.locator(`[data-section="${id}"]`)).toContainText(`Nothing in ${id}.`);
  }
});

test('status: the protected lanes say they are protected, and the tunable ones do not', async ({
  page,
}) => {
  await open(page);

  // §33 on screen rather than in a comment. Two lanes no preference can hide.
  await expect(page.getByTestId('protected-badge')).toHaveCount(2);
  await expect(
    page.locator('[data-section="contradiction"]').getByTestId('protected-badge'),
  ).toBeVisible();
  await expect(
    page.locator('[data-section="staleness"]').getByTestId('protected-badge'),
  ).toHaveCount(0);
});

test('status: a lane item carries its reason and what the base is standing on', async ({
  page,
}) => {
  await open(page, {
    lanes: {
      ...LANES,
      lanes: [
        lane('contradiction'),
        lane('blindness'),
        lane('staleness', { items: [STALE_ITEM], withheld: 4 }),
        lane('epistemic_debt'),
      ],
      withheld: 4,
    },
  });

  const item = page.getByTestId('lane-item');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('metrics/sync-error-rate.md');
  await expect(item).toContainText('ci_status at implemented');
  // The words arrive composed. If this ever renders a reason CODE, some
  // surface has started spelling the lane rules a second time.
  await expect(item).toContainText('past its freshness rule');
  await expect(item).toContainText('relied on: promoted past draft');

  // A cap nobody can see reads as "there is nothing else".
  await expect(page.getByTestId('lane-withheld')).toContainText('4 more');
});

test('status: a feed that refused says so, and does not borrow the empty state', async ({
  page,
}) => {
  // The mock refuses exactly as the real command does for a vault with no
  // ledger store, which is the case this page most has to get right.
  await open(page, { changes: null });

  await expect(page.getByTestId('section-unavailable')).toContainText('What changed');
  await expect(page.locator('[data-section="changed"]')).not.toContainText('Nothing has changed');
  // Every other section still answered. Four separate reads, four separate
  // answers — a missing ledger does not take the review queue with it.
  await expect(page.locator('[data-section="contradiction"]')).toContainText(
    'Nothing in contradiction.',
  );
  await expect(page.getByTestId('health-summary')).toBeVisible();
});

test('status: what the backend could not see is named, not dropped', async ({ page }) => {
  await open(page, {
    lanes: {
      ...LANES,
      incomplete: ['Parked promotions could not be read, so epistemic debt may be under-reported.'],
    },
  });

  await expect(page.getByTestId('lanes-incomplete')).toContainText('under-reported');
  // And the debt lane still renders — a degraded feed is not a missing lane.
  await expect(page.locator('[data-section="epistemic_debt"]')).toBeVisible();
});

test('status: what changed is read aloud, and a quiet window says one sentence', async ({
  page,
}) => {
  await open(page, {
    changes: {
      schema_version: 'convergence-v1',
      window: { from_seq: 4, to_seq: 12 },
      quiet: false,
      sections: [
        { id: 'material', label: 'Beliefs that moved', empty_text: 'No beliefs moved.', lines: [] },
        {
          id: 'contestation',
          label: 'New contradictions',
          empty_text: 'No new contradictions opened.',
          lines: [
            {
              text: 'a genuine direct contradiction opened, classified agent-supplied',
              belief_id: 'b'.repeat(32),
              entity_id: null,
            },
          ],
        },
      ],
    },
  });

  // One line, from the one section that has news. A section with nothing in
  // it is not news inside a loud window — five "nothing happened" lines
  // would bury the one thing that did.
  await expect(page.getByTestId('change-line')).toHaveCount(1);
  await expect(page.getByTestId('change-section')).toHaveCount(1);
  // The spec's word travels verbatim: a model's verdict never reads as a
  // reducer fact.
  await expect(page.getByTestId('change-line')).toContainText('agent-supplied');

  await open(page);
  await expect(page.locator('[data-section="changed"]')).toContainText('Nothing has changed');
});

test('status: needs-review holds the cards themselves, not a door to them', async ({ page }) => {
  // M33.3 INVERTED this assertion. It used to prove the section was a count
  // and a door — "not a second copy of the cards" — because the cards lived
  // on their own tab. The tab is gone: the hub is where they live, so the
  // door is what must not exist now. The card behaviours themselves are
  // proved in `review.spec.ts`, against this same section.
  // With nothing queued the honest answer is still the empty one.
  await open(page);
  const section = page.locator('[data-section="needs-review"]');
  await expect(section).toContainText('Nothing is waiting on a decision.');

  // And with a card queued, the card itself is here — no summary, no door.
  await open(page, {
    review: {
      cards: [
        {
          proposal_id: '0000000000000000000000000000000a',
          commit_set_id: '0000000000000000000000000000000f',
          run_id: '9111111111111111111111111111111f',
          actor: 'agent:claude',
          op: 'tombstone_belief',
          effective_risk: 'HIGH',
          review: null,
          queued_for: [],
          intended_use_kind: 'ReversibleWork',
          intended_use_stakes: 'LOW',
          transition_cause: 'new_evidence',
          evidence_refs: [],
          coverage_refs: [],
          authority_refs: [],
          targets: [],
          reason: 'this concept was superseded by the Q3 rewrite',
          set_members: ['0000000000000000000000000000000a'],
          set_ready: false,
        },
      ],
    },
  });
  await expect(section.getByTestId('review-card')).toHaveCount(1);
  await expect(section.getByTestId('card-op')).toHaveText('tombstone_belief');
  await expect(section.getByRole('button', { name: 'Approve' })).toBeVisible();
  await expect(section.getByTestId('review-summary')).toHaveCount(0);

  // And the background summary still takes you to the surface that can act
  // on it. (M33.4 turns this one into a body too.)
  await page.getByTestId('health-summary').click();
  await expect(page.getByTestId('pipeline-page')).toBeVisible();
});

test('status: the gate board is the shared artifact, and never-evaluated is said out loud', async ({
  page,
}) => {
  await open(page);

  // The mock derives the board from the SAME registry file the Rust runner
  // reads — 14 entries, 34 declared gates. A count drift here means the
  // surface and the artifact stopped agreeing.
  await expect(page.getByTestId('gate-entry')).toHaveCount(14);
  await expect(page.getByTestId('gate-row')).toHaveCount(34);
  // Nothing has ever been evaluated, and each row says so.
  await expect(page.locator('[data-gate="R13:root"]')).toContainText('Never evaluated here.');
  // R14 declares no gates yet, and the entry says why instead of leaving a
  // hole in the numbering.
  await expect(page.locator('[data-entry="R14"]')).toContainText('no connector is registered');
  // A discretionary gate names what it waits for.
  await expect(page.locator('[data-gate="R8:root"]')).toContainText('owner evidence pack');
});

test('status: a fired gate is loud, and even then licenses only a dated plan', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    window.__cerebroSeedTriggerLatest('R13:root', {
      evaluation_id: 'e'.repeat(64),
      result: 'fired',
      evaluated_at: '2026-08-14T09:00:00Z',
      window_end: '2026-08-14T00:00:00+02:00',
    });
  });
  await page.getByTestId('rail').getByRole('button', { name: 'Epistemic status' }).click();

  const row = page.locator('[data-gate="R13:root"]');
  await expect(row).toHaveAttribute('data-result', 'fired');
  await expect(row).toContainText('A firing licenses a dated plan, never code.');
  await expect(page.locator('[data-section="gates"]')).toContainText('R13:root has fired');
});

test('status: evaluate answers honestly in the browser, where no runtime database exists', async ({
  page,
}) => {
  await open(page);

  await page.getByTestId('gates-evaluate').click();
  // The mock invents no results — every gate answers not-evaluated with the
  // reason, and the surface renders each refusal as its own sentence.
  await expect(page.getByTestId('gates-run-outcome')).toContainText('Evaluated 0 gates');
  await expect(page.getByTestId('gates-run-skip').first()).toContainText('browser mock');
});

test('status: declaring an R7 scope walks the real guards and round-trips', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('r7-scope-none')).toContainText('No scope is declared');

  // An empty declaration meets the validator, and the refusal is a sentence
  // beside the form — the same words the desktop build refuses with.
  await page.getByTestId('r7-scope-open').click();
  await page.getByTestId('r7-scope-save').click();
  await expect(page.getByTestId('r7-scope-error')).toContainText('verifies nothing');

  await page.getByTestId('r7-scope-subjects').fill('e0000000000000000000000000000001');
  await page.getByTestId('r7-scope-classes').fill('operational_status');
  await page.getByTestId('r7-scope-save').click();

  // The digest on screen is the digest the pinned cross-language vector
  // proves both engines derive.
  await expect(page.getByTestId('r7-scope-digest')).toContainText('093da74e0fbf');
  await expect(page.getByTestId('r7-scope-declared')).toContainText('operational_status');
});
