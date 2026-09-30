import { test, expect } from '@playwright/test';
import { boot, openKnowledgeTab, seedBeforeBoot } from './boot';

/**
 * A proposal shown on the concept it would change (M52.2).
 *
 * The cards lived only in Review's "Waiting on you", so the concept an agent
 * wanted to retire said nothing of it — the page and the decision about it
 * were two places that never named each other. These specs walk the demo
 * corpus's own cards (`demoReviewCards`): from a card to its concept, the
 * card on that concept's page, a decision made there, and Review agreeing.
 */

const RETIRE = 'p0000000000000000000000000000002'; // targets webinar-attendance
const REVISE = 'p0000000000000000000000000000001'; // targets offline-guarantee, stale

/** A revise card an agent queued against one concept, for a spec to stage. */
function reviseCard(path: string, reason: string) {
  return {
    proposal_id: '0000000000000000000000000000000c',
    commit_set_id: '0000000000000000000000000000000d',
    run_id: 'run-1',
    actor: 'claude-code',
    op: 'update_belief',
    effective_risk: 'HIGH',
    review: null,
    queued_for: [],
    intended_use_kind: 'ReversibleWork',
    intended_use_stakes: 'LOW',
    transition_cause: 'new_evidence',
    evidence_refs: ['e1'],
    coverage_refs: [],
    authority_refs: [],
    targets: [
      {
        target_class: 'belief',
        target_id: 'b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3',
        expected_version: 2,
        current_version: 2,
        stale: false,
        path,
      },
    ],
    reason,
    set_members: ['0000000000000000000000000000000c'],
    set_ready: true,
  };
}

test('proposals: a card opens its concept, which shows it and decides it', async ({ page }) => {
  await boot(page);
  await openKnowledgeTab(page, 'review');
  const waiting = page.locator('[data-section="needs-review"]');
  await expect(waiting.getByTestId('review-card')).toHaveCount(3);

  // In Review the card names what it would change, in the app's words, and
  // who asks.
  const retire = waiting.locator(`[data-proposal="${RETIRE}"]`);
  await expect(retire.getByTestId('card-op')).toHaveText('Retire Webinar attendance');
  await expect(retire.getByTestId('card-author')).toHaveText('Release scout');

  // The target opens as the concept page (M50.3 — the path is vault-relative
  // on both sides, `knowledge/…`).
  await retire.getByTestId('card-target-open').click();
  await expect(page.getByTestId('doc-page')).toBeVisible();
  await expect(page.getByTestId('concept-title')).toHaveValue('Webinar attendance');

  // The page shows the card that targets it, and only that one.
  const bar = page.getByTestId('concept-review-bar');
  const here = bar.getByTestId('concept-proposals').getByTestId('review-card');
  await expect(here).toHaveCount(1);
  await expect(here).toHaveAttribute('data-proposal', RETIRE);
  await expect(here.getByTestId('card-op')).toHaveText('Retire this concept');
  // Verify stays where it was.
  await expect(bar.getByRole('button', { name: /Verify/ })).toBeVisible();

  // Decided on the page — and Review agrees.
  await here.getByTestId('approve').click();
  await expect(bar.getByTestId('concept-proposals')).toHaveCount(0);
  await openKnowledgeTab(page, 'review');
  await expect(waiting.getByTestId('review-card')).toHaveCount(2);
  await expect(waiting.locator(`[data-proposal="${RETIRE}"]`)).toHaveCount(0);
});

test('proposals: a card whose concept moved says so on that concept', async ({ page }) => {
  await boot(page);
  await openKnowledgeTab(page, 'review');
  await page
    .locator(`[data-section="needs-review"] [data-proposal="${REVISE}"]`)
    .getByTestId('card-target-open')
    .click();
  await expect(page.getByTestId('concept-title')).toHaveValue('The offline guarantee');
  const card = page.getByTestId('concept-proposals').getByTestId('review-card');
  await expect(card.getByTestId('card-op')).toHaveText('Revise this concept');
  await expect(card.getByTestId('card-stale')).toHaveText(
    'This concept changed after this was proposed.',
  );
  await expect(card.getByTestId('approve')).toBeDisabled();
});

test('proposals: a queue row says when its concept has a card waiting', async ({ page }) => {
  // Staged against a concept nobody has reviewed (and due a recheck), alone
  // in the queue, so the one mark and the reason beside it are both this
  // card's.
  await seedBeforeBoot(page, '__cerebroSeedReview', {
    cards: [
      reviseCard(
        'knowledge/metrics/sync-error-rate.md',
        'the threshold moved in the August review',
      ),
    ],
  });
  await boot(page);
  await openKnowledgeTab(page, 'review');

  const marked = page.getByTestId('queue-proposal');
  await expect(marked).toHaveCount(1);
  // A mark beside the reason, not in its place (M52.5); the card's own
  // sentence is its hover.
  await expect(marked).toHaveText('+1 change');
  await expect(marked.locator('[title]')).toHaveAttribute(
    'title',
    /^A proposal to revise it is waiting on you/,
  );
  const row = page.locator(
    '[data-testid="queue-row"][data-path="knowledge/metrics/sync-error-rate.md"]',
  );
  await expect(row.getByTestId('queue-proposal')).toHaveCount(1);
  // The row still says why it is queued: the card does not replace that.
  await expect(row.getByTestId('queue-reason')).toHaveText('Unreviewed');
  // The full card is still under Waiting on you.
  await expect(
    page.locator('[data-section="needs-review"]').getByTestId('review-card'),
  ).toHaveCount(1);

  // The row leads to the page where it is decided.
  await row.click();
  await expect(page.getByTestId('concept-proposals').getByTestId('review-card')).toHaveCount(1);
});

// M52.4 — the pager's Next swaps the concept under a page that stays mounted,
// and the review bar kept the queue it read for the concept before: a card
// waiting on the next one did not show until something else re-read it.
test('proposals: the pager lands on a concept with its card showing', async ({ page }) => {
  // No card waiting to start with — the demo's own link card names the
  // queue's first two concepts — so the one that shows is the one queued
  // while the page is open.
  await seedBeforeBoot(page, '__cerebroSeedReview', { cards: [] });
  await boot(page);
  await openKnowledgeTab(page, 'review');
  const rows = page.getByTestId('queue-row');
  const second = await rows.nth(1).getAttribute('data-path');
  if (second === null) throw new Error('the queue has no second row');
  await rows.first().click();
  await expect(page.getByTestId('review-pager')).toContainText('Review 1 of');
  await expect(page.getByTestId('concept-proposals')).toHaveCount(0);

  // An agent queues a change to the next concept while this one is open.
  await page.evaluate(
    (card) => window.__cerebroSeedReview({ cards: [card] }),
    reviseCard(second, 'queued while the page was open'),
  );
  await page.getByTestId('review-next').click();
  await expect(page.getByTestId('review-pager')).toContainText('Review 2 of');
  const proposals = page.getByTestId('concept-proposals');
  await expect(proposals).toBeVisible();
  await expect(proposals.getByTestId('review-card')).toHaveCount(1);
});

// M52.5 — a link card targets both of its concepts, as Rust builds one
// (`policy::review`: the two beliefs, then the relation), so each end shows
// it: on its page, and as a mark beside its reason in Review — "+1 link", so
// the two ends' marks read as the one card.
test('proposals: a link card shows on both of its concepts', async ({ page }) => {
  await boot(page);
  await openKnowledgeTab(page, 'review');
  for (const path of [
    'knowledge/systems/pick-queue-drain.md',
    'knowledge/playbooks/warehouse-cutover.md',
  ]) {
    const row = page.locator(`[data-testid="queue-row"][data-path="${path}"]`);
    await expect(row.getByTestId('queue-reason')).toHaveText('Unreviewed');
    await expect(row.getByTestId('queue-proposal')).toHaveText('+1 link');
  }
  await page
    .locator('[data-testid="queue-row"][data-path="knowledge/systems/pick-queue-drain.md"]')
    .click();
  const card = page.getByTestId('concept-proposals').getByTestId('review-card');
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('card-op')).toHaveText(
    'Add a link: this concept refines Warehouse cutover: go-live and rollback',
  );
});
