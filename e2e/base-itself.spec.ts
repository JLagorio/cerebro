import { test, expect, type Page } from '@playwright/test';
import { boot, openKnowledgeSystem, openKnowledgeTab } from './boot';

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
  // A ledger id, as the wire sends it (M52.4): the concept is named by `path`.
  entity_id: 'e1'.repeat(16),
  path: 'metrics/sync-error-rate.md',
  predicate: 'ci_status',
  state_stage: 'implemented',
  // As Rust says a facet of a belief with more than one (M52.5); a sole
  // facet's row carries none.
  scope_text: 'CI status, at the implemented stage',
  reasons: ['freshness_stale'],
  reason_text: 'past its recheck date',
  reliance: ['qualified'],
  reliance_text: 'Relied on — it is no longer a draft',
  edge_id: null,
  relation_id: null,
};

const QUIET_CHANGES = {
  schema_version: 'convergence-v1',
  window: { from_seq: 0, to_seq: 0 },
  quiet: true,
  sections: [],
};

/** Where each Status-hub section lives since M51: Review holds what waits
 *  on a person, Activity what happened, and System (folded under Activity)
 *  the machinery. */
type Where = 'review' | 'activity' | 'system';

async function go(page: Page, where: Where): Promise<void> {
  if (where === 'system') await openKnowledgeSystem(page);
  else await openKnowledgeTab(page, where);
}

/**
 * Boot, stage the feeds, and land on one of the tabs.
 *
 * The seeds go in before the tab mounts so its first read already has them —
 * which is why they are staged here rather than inside each test, and why a
 * test that wants a second place calls `go` again rather than
 * re-seeding.
 */
async function open(
  page: Page,
  where: Where,
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
  await go(page, where);
}

test('base itself: every lane is on the tab, and an empty one says so in its own words', async ({
  page,
}) => {
  await open(page, 'activity');

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
  await open(page, 'activity');

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
  await open(page, 'activity', {
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
  // The concept by its title, never its path (M52.3).
  await expect(item).toContainText('Sync error rate');
  await expect(item).not.toContainText('metrics/sync-error-rate.md');
  // Which of its claims, as a quiet qualifier on the name (M52.5).
  await expect(item.getByTestId('lane-scope')).toHaveText('· CI status, at the implemented stage');
  // The words arrive composed. If this ever renders a reason CODE, some
  // surface has started spelling the lane rules a second time. A recheck
  // the concept's own file dates reads as its row and page read it (M52.5)
  // — "Past its recheck date" was a third wording for it.
  await expect(item.getByTestId('lane-reason')).toHaveText('Due a recheck · 2 days overdue');
  await expect(item).toContainText('Relied on — it is no longer a draft');

  // A cap nobody can see reads as "there is nothing else" — and says why
  // (M52.4): one row listed is not a list cut at ten, so it was held back
  // another way (M52.5).
  await expect(page.getByTestId('lane-withheld')).toContainText('4 more');
  await expect(page.getByTestId('lane-withheld')).toContainText('dismissed, or shown recently');

  // And the title opens the concept, like every other concept link here.
  await item.getByTestId('activity-concept').click();
  await expect(page.getByTestId('concept-title')).toHaveValue('Sync error rate');
});

test('base itself: a feed that refused says so, and takes no other tab with it', async ({
  page,
}) => {
  // The mock refuses exactly as the real command does for a vault with no
  // ledger store, which is the case this surface most has to get right.
  //
  // M51 put three of these sections back on one page (Activity). The claim
  // is unchanged: each section is its own mount with its own read, so one
  // refusal sits beside answers rather than taking them with it.
  await open(page, 'activity', { changes: null });

  const changed = page.locator('[data-section="changed"]');
  await expect(changed.getByTestId('section-unavailable')).toContainText('What changed');
  await expect(changed).not.toContainText('Nothing has changed');

  // Every other section still answered. Separate reads, separate answers — a
  // missing ledger does not take the review queue or the background with it,
  // and after M33.3/M33.4 those two are BODIES rather than doors, which makes
  // the independence claim stronger than it was: each section owns its own
  // read and its own failure.
  await expect(page.locator('[data-section="contradiction"]')).toContainText(
    'Nothing in contradiction.',
  );

  await go(page, 'system');
  await expect(page.locator('[data-section="system"]').getByTestId('budget-meter')).toBeVisible();

  // The needs section answered too — with the corpus's cards, since M33.10
  // gave the operational surfaces a corpus of their own.
  await go(page, 'review');
  await expect(
    page.locator('[data-section="needs-review"]').getByTestId('review-card'),
  ).not.toHaveCount(0);
});

test('base itself: what the backend could not see is named, not dropped', async ({ page }) => {
  await open(page, 'activity', {
    lanes: {
      ...LANES,
      incomplete: [
        'Parked promotions could not be read, so what is taken on trust may be under-reported.',
      ],
    },
  });

  await expect(page.getByTestId('lanes-incomplete')).toContainText('under-reported');
  // And the debt lane still renders — a degraded feed is not a missing lane.
  await expect(page.locator('[data-section="epistemic_debt"]')).toBeVisible();
});

test('base itself: what changed is read aloud, and a quiet window says one sentence', async ({
  page,
}) => {
  await open(page, 'activity', {
    changes: {
      schema_version: 'convergence-v1',
      window: { from_seq: 4, to_seq: 12 },
      quiet: false,
      sections: [
        {
          id: 'material',
          label: 'Concepts that changed',
          empty_text: 'No concept changed.',
          lines: [],
        },
        {
          id: 'contestation',
          label: 'New contradictions',
          empty_text: 'No new contradictions opened.',
          lines: [
            {
              text: 'is in a new genuine direct contradiction, classified agent-supplied',
              belief_id: 'b'.repeat(32),
              entity_id: null,
              path: null,
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
  // reducer fact. No file projects this belief, so it is "A claim" — never
  // the 32 hex characters it carries.
  await expect(page.getByTestId('change-line')).toContainText('agent-supplied');
  await expect(page.getByTestId('change-line')).toContainText('A claim is in a new');
  await expect(page.getByTestId('change-line')).not.toContainText('b'.repeat(32));

  await open(page, 'activity');
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
  await open(page, 'review', { review: { cards: [], applications: [] } });
  const section = page.locator('[data-section="needs-review"]');
  await expect(section).toContainText('Nothing is waiting on a decision.');

  // And with a card queued, the card itself is here — no summary, no door.
  await open(page, 'review', {
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
  // M52.2: the headline is words; the op the ledger recorded is its data-op.
  await expect(section.getByTestId('card-op')).toHaveAttribute('data-op', 'tombstone_belief');
  await expect(section.getByTestId('card-op')).toHaveText('Retire');
  await expect(section.getByRole('button', { name: 'Approve' })).toBeVisible();
  await expect(section.getByTestId('review-summary')).toHaveCount(0);

  // M33.4 did the same to the background summary: the controls are the tab's
  // body now, so neither of the two doors this surface used to hold exists.
  await go(page, 'system');
  await expect(page.getByTestId('health-summary')).toHaveCount(0);
  await expect(page.locator('[data-section="system"]').getByTestId('lane-toggles')).toBeVisible();
});

test('base itself: three tabs, the Status sections inside them, the machinery folded (M51)', async ({
  page,
}) => {
  await open(page, 'activity');

  // Three tabs a reader can follow. The eight M50.5 inherited from the
  // Status hub are sections of Review and Activity now.
  const tabs = page.getByRole('navigation', { name: 'Knowledge views' });
  await expect(tabs.getByRole('button')).toHaveCount(3);
  await expect(page.getByTestId('knowledge-tab-activity')).toHaveAttribute('aria-current', 'page');

  // Activity: what changed, what Knowledge is unsure of, and the log.
  await expect(page.locator('[data-section="changed"]')).toBeVisible();
  await expect(page.locator('[data-section="contradiction"]')).toBeVisible();
  await expect(page.getByTestId('knowledge-log')).toBeVisible();
  // The machinery is folded — and not even read until somebody opens it.
  await expect(page.locator('[data-section="system"]')).toHaveCount(0);
  await page.getByTestId('knowledge-system').locator('summary').click();
  await expect(page.locator('[data-section="system"]')).toBeVisible();
  await expect(page.locator('[data-section="gates"]')).toBeVisible();

  // And none of it is a row in the sidebar: that is folders and Review.
  const rows = page.getByTestId('knowledge-nav-row');
  await expect(rows.filter({ hasText: 'What changed' })).toHaveCount(0);
  await expect(rows.last()).toHaveAttribute('data-tab', 'review');
});

test('base itself: the gate board is the shared artifact, and never-evaluated is said out loud', async ({
  page,
}) => {
  await open(page, 'system');

  // Collapsed, the tab is one line (M33a.2 / D5): a wall of "Never evaluated
  // here" cards was 55% of the old page, and the count is the answer. The
  // number is the registry's — spec D6 guessed 24, the artifact declares 14 —
  // so this assertion drifts with the artifact rather than with the prose.
  await expect(page.getByTestId('gates-summary')).toHaveText(
    '14 are held back; none is needed yet.',
  );
  await expect(page.getByTestId('gate-row')).toHaveCount(0);
  await page.getByTestId('gates-expand').click();

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
  await go(page, 'system');

  // A firing is the one thing the collapse does NOT hide: it is the only news
  // this tab ever has, and a headline behind a click is a headline nobody
  // reads.
  const summary = page.locator('[data-section="gates"]').getByTestId('gates-summary');
  await expect(summary).toContainText('curiosity discovery loop is needed now');
  await expect(summary).toHaveAttribute('data-fired', 'R13:root');
  await page.getByTestId('gates-expand').click();

  const row = page.locator('[data-gate="R13:root"]');
  await expect(row).toHaveAttribute('data-result', 'fired');
  await expect(row).toContainText('A firing licenses a dated plan, never code.');
});

test('base itself: evaluate answers honestly in the browser, where no runtime database exists', async ({
  page,
}) => {
  await open(page, 'system');

  await page.getByTestId('gates-evaluate').click();
  // The mock invents no results — every gate answers not-evaluated with the
  // reason, and the surface renders each refusal as its own sentence.
  await expect(page.getByTestId('gates-run-outcome')).toContainText('Evaluated 0 gates');
  await expect(page.getByTestId('gates-run-skip').first()).toContainText('browser mock');
});

test('base itself: declaring an R7 scope walks the real guards and round-trips', async ({
  page,
}) => {
  await open(page, 'system');
  await expect(page.getByTestId('r7-scope-none')).toContainText(
    'Nothing is chosen to cross-check yet',
  );

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
