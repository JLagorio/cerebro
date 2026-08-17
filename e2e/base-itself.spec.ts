import { test, expect, type Page } from '@playwright/test';
import { boot, openKnowledgeTab } from './boot';

/**
 * What the base knows about ITSELF — the Knowledge tab's second nav group
 * (M27.8d as the Epistemic Status hub, folded in here by M33a.2).
 *
 * The file was `status.spec.ts` until the hub stopped existing. Every test in
 * it opens Knowledge now, so the old name was the last thing in the tree
 * claiming there is a Status destination.
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

/** The six rows the M33a.2 merge added, in the order the nav renders them. */
const ITSELF_ROWS = [
  'What changed',
  "What's contested",
  'Waiting on you',
  'Background',
  'Agent work',
  'Deferral gates',
];

/**
 * Boot, stage the feeds, and land on one of the tabs.
 *
 * The seeds go in before the tab mounts so its first read already has them —
 * which is why they are staged here rather than inside each test, and why a
 * test that wants a second tab calls `openKnowledgeTab` again rather than
 * re-seeding.
 */
async function open(
  page: Page,
  row: string,
  seed: { lanes?: unknown; changes?: unknown | null; review?: unknown } = {},
): Promise<void> {
  await boot(page);
  await page.evaluate(
    ({ lanes, changes, review }) => {
      window.__cerebroSeedLanes(lanes);
      window.__cerebroSeedChanges(changes);
      // (M33.3 — the needs section reads the queue itself now.)
      if (review !== undefined) window.__cerebroSeedReview(review);
    },
    {
      lanes: seed.lanes ?? LANES,
      changes: seed.changes === undefined ? QUIET_CHANGES : seed.changes,
      review: seed.review,
    },
  );
  await openKnowledgeTab(page, row);
}

test('base itself: every lane is on the tab, and an empty one says so in its own words', async ({
  page,
}) => {
  await open(page, "What's contested");

  // All four, including the ones holding nothing. A lane that appeared only
  // when it had contents would make "no coverage gaps" and "coverage was
  // never computed" the same screen.
  for (const id of ['contradiction', 'blindness', 'staleness', 'epistemic_debt']) {
    await expect(page.locator(`[data-section="${id}"]`)).toBeVisible();
    await expect(page.locator(`[data-section="${id}"]`)).toContainText(`Nothing in ${id}.`);
  }
});

test('base itself: the protected lanes say they are protected, and the tunable ones do not', async ({
  page,
}) => {
  await open(page, "What's contested");

  // §33 on screen rather than in a comment. Two lanes no preference can hide.
  await expect(page.getByTestId('protected-badge')).toHaveCount(2);
  await expect(
    page.locator('[data-section="contradiction"]').getByTestId('protected-badge'),
  ).toBeVisible();
  await expect(
    page.locator('[data-section="staleness"]').getByTestId('protected-badge'),
  ).toHaveCount(0);
});

test('base itself: a lane item carries its reason and what the base is standing on', async ({
  page,
}) => {
  await open(page, "What's contested", {
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

test('base itself: a feed that refused says so, and takes no other tab with it', async ({
  page,
}) => {
  // The mock refuses exactly as the real command does for a vault with no
  // ledger store, which is the case this surface most has to get right.
  //
  // M33a.2 walks the tabs in turn rather than reading one scroll column. The
  // claim is unchanged and the mechanism is stronger for it: these were four
  // sections of one page that could have shared a read, and they are four
  // separate mounts that demonstrably do not.
  await open(page, 'What changed', { changes: null });

  await expect(page.getByTestId('section-unavailable')).toContainText('What changed');
  await expect(page.locator('[data-section="changed"]')).not.toContainText('Nothing has changed');

  // Every other tab still answered. Separate reads, separate answers — a
  // missing ledger does not take the review queue or the background with it,
  // and after M33.3/M33.4 those two are BODIES rather than doors, which makes
  // the independence claim stronger than it was: each section owns its own
  // read and its own failure.
  await openKnowledgeTab(page, "What's contested");
  await expect(page.locator('[data-section="contradiction"]')).toContainText(
    'Nothing in contradiction.',
  );

  await openKnowledgeTab(page, 'Background');
  await expect(page.locator('[data-section="system"]').getByTestId('budget-meter')).toBeVisible();

  // The needs section answered too — with the corpus's cards, since M33.10
  // gave the operational surfaces a corpus of their own.
  await openKnowledgeTab(page, 'Waiting on you');
  await expect(
    page.locator('[data-section="needs-review"]').getByTestId('review-card'),
  ).not.toHaveCount(0);
});

test('base itself: what the backend could not see is named, not dropped', async ({ page }) => {
  await open(page, "What's contested", {
    lanes: {
      ...LANES,
      incomplete: ['Parked promotions could not be read, so epistemic debt may be under-reported.'],
    },
  });

  await expect(page.getByTestId('lanes-incomplete')).toContainText('under-reported');
  // And the debt lane still renders — a degraded feed is not a missing lane.
  await expect(page.locator('[data-section="epistemic_debt"]')).toBeVisible();
});

test('base itself: what changed is read aloud, and a quiet window says one sentence', async ({
  page,
}) => {
  await open(page, 'What changed', {
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

  await open(page, 'What changed');
  await expect(page.locator('[data-section="changed"]')).toContainText('Nothing has changed');
});

test('base itself: waiting-on-you holds the cards themselves, not a door to them', async ({
  page,
}) => {
  // M33.3 INVERTED this assertion. It used to prove the section was a count
  // and a door — "not a second copy of the cards" — because the cards lived
  // on their own tab. The tab is gone: this is where they live, so the door
  // is what must not exist now. The card behaviours themselves are proved in
  // `review.spec.ts`, against this same section.
  // With nothing queued the honest answer is still the empty one. Asked for
  // explicitly since M33.10: the demo corpus seeds a real queue, so "empty"
  // is now a case a spec stages rather than one it inherits.
  await open(page, 'Waiting on you', { review: { cards: [], applications: [] } });
  const section = page.locator('[data-section="needs-review"]');
  await expect(section).toContainText('Nothing is waiting on a decision.');

  // And with a card queued, the card itself is here — no summary, no door.
  await open(page, 'Waiting on you', {
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

  // M33.4 did the same to the background summary: the controls are the tab's
  // body now, so neither of the two doors this surface used to hold exists.
  await openKnowledgeTab(page, 'Background');
  await expect(page.getByTestId('health-summary')).toHaveCount(0);
  await expect(page.locator('[data-section="system"]').getByTestId('lane-toggles')).toBeVisible();
});

test('base itself: the Knowledge nav carries these six rows, not the record sidebar (M33a.2)', async ({
  page,
}) => {
  await open(page, 'What changed');

  // Home's sidebar lists types and views — a description of the RECORD
  // corpus, which has nothing to say about runs, budgets or queued
  // proposals. Knowledge answers its own question and navigates itself.
  await expect(page.getByTestId('sidebar-type')).toHaveCount(0);
  const nav = page.getByTestId('knowledge-nav-row');
  // The six the merge added. Asserted by NAME rather than by count: the group
  // above them grows a row whenever the bundle grows a folder or a subject,
  // so a total would be a number about the demo corpus, not about this merge.
  for (const row of ITSELF_ROWS) await expect(nav.filter({ hasText: row })).toHaveCount(1);

  // A nav row takes you to its tab, and the selection remembers which — so a
  // tab is a place the back button can return to.
  await nav.filter({ hasText: 'Agent work' }).click();
  await expect(page.locator('[data-section="fleet"]')).toBeVisible();
  await expect(nav.filter({ hasText: 'Agent work' })).toHaveAttribute('aria-current', 'page');

  // And no counts on any of them: a badge here would be the chrome nagging
  // somebody to drain a queue, which is the rule that kept one off Knowledge
  // and History. (The rows ABOVE this group may carry one — a destination is
  // allowed to say how big it is; the chrome is not allowed to count at you.)
  for (const row of ITSELF_ROWS) {
    await expect(nav.filter({ hasText: row })).not.toContainText(/\d/);
  }
});

test('base itself: the gate board is the shared artifact, and never-evaluated is said out loud', async ({
  page,
}) => {
  await open(page, 'Deferral gates');

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

test('base itself: a fired gate is loud, and even then licenses only a dated plan', async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => {
    window.__cerebroSeedTriggerLatest('R13:root', {
      evaluation_id: 'e'.repeat(64),
      result: 'fired',
      evaluated_at: '2026-08-14T09:00:00Z',
      window_end: '2026-08-14T00:00:00+02:00',
    });
  });
  await openKnowledgeTab(page, 'Deferral gates');

  const row = page.locator('[data-gate="R13:root"]');
  await expect(row).toHaveAttribute('data-result', 'fired');
  await expect(row).toContainText('A firing licenses a dated plan, never code.');
  await expect(page.locator('[data-section="gates"]')).toContainText('R13:root has fired');
});

test('base itself: evaluate answers honestly in the browser, where no runtime database exists', async ({
  page,
}) => {
  await open(page, 'Deferral gates');

  await page.getByTestId('gates-evaluate').click();
  // The mock invents no results — every gate answers not-evaluated with the
  // reason, and the surface renders each refusal as its own sentence.
  await expect(page.getByTestId('gates-run-outcome')).toContainText('Evaluated 0 gates');
  await expect(page.getByTestId('gates-run-skip').first()).toContainText('browser mock');
});

test('base itself: declaring an R7 scope walks the real guards and round-trips', async ({
  page,
}) => {
  await open(page, 'Deferral gates');
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
