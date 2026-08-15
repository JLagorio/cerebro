import { test, expect, type Page } from '@playwright/test';
import { boot, openStatusSection, seedBeforeBoot } from './boot';

/**
 * The M24.9 review surface: what the base is holding until a person decides.
 *
 * The browser mock has no ledger, so these specs stage CARDS — the shapes
 * `policy/review.rs` returns — and assert the surface renders and acts on
 * them. What is being tested here is the surface: that a queued card says
 * why it is waiting, that a stale one says so before anyone clicks, that
 * rejection cannot be sent without a reason, and that a revert only exists
 * where the server offered one. The DECISIONS themselves are Rust's, proved
 * against the real interpreter in `policy::review` and `policy::evals`.
 *
 * **M33.3 moved the home, not the behaviour.** These cards live in the Status
 * hub's "Needs review" section now; there is no review tab. Every card testid
 * below is unchanged on purpose — that is what makes this file able to prove
 * the extraction dropped nothing. The spec also stopped hand-rolling its own
 * boot: it used to set two localStorage keys and never pin the clock, which
 * is exactly the shelf-life bug `boot.ts` exists to prevent.
 */

const CARD = {
  proposal_id: '0000000000000000000000000000000a',
  commit_set_id: '0000000000000000000000000000000f',
  run_id: '9111111111111111111111111111111f',
  actor: 'agent:claude',
  op: 'tombstone_belief',
  effective_risk: 'HIGH',
  review: null as string | null,
  queued_for: [] as string[],
  intended_use_kind: 'ReversibleWork',
  intended_use_stakes: 'LOW',
  transition_cause: 'new_evidence',
  evidence_refs: [] as string[],
  coverage_refs: [] as string[],
  authority_refs: [] as string[],
  targets: [
    {
      target_class: 'belief',
      target_id: 'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1',
      expected_version: 1,
      current_version: 1,
      stale: false,
    },
  ],
  reason: 'this concept was superseded by the Q3 rewrite',
  set_members: ['0000000000000000000000000000000a'],
  set_ready: false,
};

type Card = typeof CARD;

/** Boot into the hub with these cards staged, and hand back the section that
 * holds them. */
async function openNeedsReview(page: Page, fixture: { cards?: Card[]; applications?: unknown[] }) {
  await seedBeforeBoot(page, '__cerebroSeedReview', fixture);
  await boot(page);
  return openStatusSection(page, 'needs-review');
}

test('review: a queued card says what it is, how dangerous it is, and why it waits', async ({
  page,
}) => {
  const section = await openNeedsReview(page, {
    cards: [{ ...CARD, queued_for: ['high_stakes_verification_required'] }],
  });
  const card = section.getByTestId('review-card');
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('card-op')).toHaveText('tombstone_belief');
  await expect(card.getByTestId('card-risk')).toHaveText('HIGH');
  // The table's own words, not a paraphrase.
  await expect(card.getByTestId('card-queued-for')).toHaveText('high_stakes_verification_required');
  await expect(card.getByTestId('card-targets')).toContainText('belief');
});

test('review: a card whose world moved says so before anyone clicks', async ({ page }) => {
  const section = await openNeedsReview(page, {
    cards: [
      {
        ...CARD,
        targets: [{ ...CARD.targets[0], current_version: 2, stale: true }],
      },
    ],
  });
  await expect(section.getByTestId('card-stale')).toBeVisible();
  await expect(section.getByTestId('card-targets')).toContainText('@1 → 2');
});

test('review: a CRITICAL card is marked for diff review', async ({ page }) => {
  const section = await openNeedsReview(page, {
    cards: [{ ...CARD, effective_risk: 'CRITICAL', review: 'diff' }],
  });
  await expect(section.getByTestId('card-diff')).toBeVisible();
});

test('review: rejecting needs a reason, and approving clears the card', async ({ page }) => {
  const section = await openNeedsReview(page, { cards: [CARD] });
  // Reject is unavailable until there is something to record.
  const reject = section.getByRole('button', { name: 'Reject' });
  await expect(reject).toBeDisabled();
  await section.getByPlaceholder('Why not?').fill('the rewrite did not supersede this');
  await expect(reject).toBeEnabled();

  await section.getByRole('button', { name: 'Approve' }).click();
  await expect(section.getByTestId('review-card')).toHaveCount(0);
});

test('review: revert is offered only where the server offered one', async ({ page }) => {
  const section = await openNeedsReview(page, {
    cards: [],
    applications: [
      {
        proposal_id: '0000000000000000000000000000000b',
        op: 'update_belief',
        applied_event_id: 'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1',
        reason: 'corrected the churn definition',
      },
    ],
  });
  const application = section.getByTestId('revertable');
  await expect(application).toHaveCount(1);
  await section.getByRole('button', { name: 'Revert' }).click();
  await expect(section.getByTestId('revertable')).toHaveCount(0);
});
