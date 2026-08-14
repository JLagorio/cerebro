import { test, expect, type Page } from '@playwright/test';

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

async function boot(page: Page, fixture: { cards?: Card[]; applications?: unknown[] }) {
  await page.addInitScript(
    ({ seed }) => {
      window.localStorage.setItem('cerebro.autoLearn', 'false');
      window.localStorage.setItem('cerebro.themeMode', 'light');
      // Staged before the app boots, so the first load already has them.
      const pending = seed;
      const install = () => {
        const w = window as unknown as {
          __cerebroSeedReview?: (f: unknown) => void;
        };
        if (w.__cerebroSeedReview === undefined) {
          setTimeout(install, 10);
          return;
        }
        w.__cerebroSeedReview(pending);
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
  await page.getByRole('button', { name: 'Needs review' }).click();
  await expect(page.getByTestId('review-page')).toBeVisible();
}

test('review: a queued card says what it is, how dangerous it is, and why it waits', async ({
  page,
}) => {
  await boot(page, {
    cards: [{ ...CARD, queued_for: ['high_stakes_verification_required'] }],
  });
  const card = page.getByTestId('review-card');
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('card-op')).toHaveText('tombstone_belief');
  await expect(card.getByTestId('card-risk')).toHaveText('HIGH');
  // The table's own words, not a paraphrase.
  await expect(card.getByTestId('card-queued-for')).toHaveText('high_stakes_verification_required');
  await expect(card.getByTestId('card-targets')).toContainText('belief');
});

test('review: a card whose world moved says so before anyone clicks', async ({ page }) => {
  await boot(page, {
    cards: [
      {
        ...CARD,
        targets: [{ ...CARD.targets[0], current_version: 2, stale: true }],
      },
    ],
  });
  await expect(page.getByTestId('card-stale')).toBeVisible();
  await expect(page.getByTestId('card-targets')).toContainText('@1 → 2');
});

test('review: a CRITICAL card is marked for diff review', async ({ page }) => {
  await boot(page, {
    cards: [{ ...CARD, effective_risk: 'CRITICAL', review: 'diff' }],
  });
  await expect(page.getByTestId('card-diff')).toBeVisible();
});

test('review: rejecting needs a reason, and approving clears the card', async ({ page }) => {
  await boot(page, { cards: [CARD] });
  // Reject is unavailable until there is something to record.
  const reject = page.getByRole('button', { name: 'Reject' });
  await expect(reject).toBeDisabled();
  await page.getByPlaceholder('Why not?').fill('the rewrite did not supersede this');
  await expect(reject).toBeEnabled();

  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByTestId('review-card')).toHaveCount(0);
});

test('review: revert is offered only where the server offered one', async ({ page }) => {
  await boot(page, {
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
  const application = page.getByTestId('revertable');
  await expect(application).toHaveCount(1);
  await page.getByRole('button', { name: 'Revert' }).click();
  await expect(page.getByTestId('revertable')).toHaveCount(0);
});
