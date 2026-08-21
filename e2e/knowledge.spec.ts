import { test, expect } from '@playwright/test';
import { boot, readMockFile } from './boot';

const CONCEPT = 'knowledge/metrics/sync-error-rate.md';

test('knowledge: browse the bundle, read provenance, and verify a concept', async ({ page }) => {
  await boot(page);

  await page.getByTestId('rail').getByRole('button', { name: /^Base/ }).click();
  await expect(page.getByTestId('knowledge-page')).toBeVisible();
  // M33a.3 — the tab opens on the heaviest THREAD now, not the flat list, so
  // a spec about the whole bundle has to ask for the whole bundle.
  await page.getByTestId('knowledge-nav-row').filter({ hasText: 'All concepts' }).click();
  // Counts come from the seed and change whenever it does. Assert the
  // relationships instead: the review queue is a proper subset of the bundle.
  const all = await page.getByTestId('concept-row').count();
  expect(all).toBeGreaterThan(2);

  // -- The review queue is the unverified/stale/deprecated set -----------
  await page.getByTestId('knowledge-nav-row').filter({ hasText: 'Needs review' }).click();
  const queued = page.getByTestId('concept-row');
  const queuedCount = await queued.count();
  expect(queuedCount).toBeGreaterThan(0);
  expect(queuedCount).toBeLessThan(all);
  // Human-reviewed, in date, not deprecated — nothing to act on.
  await expect(queued.filter({ hasText: 'The offline guarantee' })).toHaveCount(0);

  // -- Provenance is shown, not summarised into a score ------------------
  await queued.filter({ hasText: 'Sync error rate' }).click();
  const panel = page.getByTestId('knowledge-panel');
  await expect(panel).toContainText('claude-code');
  await expect(panel).toContainText('Nobody yet');
  await expect(panel).toContainText('42,000 uses');
  // M27.5c: the chip answers whether a review covers what this says NOW, and
  // names who did it beside the status rather than ranking a person above a
  // process. `data-tier` and its three rungs are gone.
  await expect(panel.getByTestId('review-chip')).toHaveAttribute('data-review', 'unreviewed');
  await expect(panel.getByTestId('review-chip')).toHaveAttribute('data-by', 'nobody');

  // -- Verify writes an OKF stamp and the review becomes current ---------
  await page.getByRole('button', { name: /^Verify$/ }).click();
  await expect.poll(async () => readMockFile(page, CONCEPT)).toContain('human:me');
  await expect(panel.getByTestId('review-chip')).toHaveAttribute('data-review', 'current');
  await expect(panel.getByTestId('review-chip')).toHaveAttribute('data-by', 'human');

  // Still queued — and that is the point. Verification and freshness are
  // INDEPENDENT signals: confirming a claim does not move its stale_after
  // date, so a reviewed-but-expired concept still wants attention.
  await expect(page.getByTestId('concept-row')).toHaveCount(queuedCount);
  await expect(panel).toContainText('Stale since 2026-07-26');

  // A concept whose only flag was "unverified" does leave the queue.
  await page.getByTestId('concept-row').filter({ hasText: 'Warehouse cutover' }).click();
  await page.getByRole('button', { name: /^Verify$/ }).click();
  await expect(page.getByTestId('concept-row')).toHaveCount(queuedCount - 1);
});

test('knowledge: a verified concept revised later shows the predating notice (M23.4)', async ({
  page,
}) => {
  await boot(page);
  await page.getByTestId('rail').getByRole('button', { name: /^Base/ }).click();
  // The flat list, because the two concepts this walks between sit in
  // different threads (M33a.3 moved the default off `all`).
  await page.getByTestId('knowledge-nav-row').filter({ hasText: 'All concepts' }).click();

  // The agent revised a previously verified concept: the projection renders
  // the review notice instead of silently reverting to "Nobody yet".
  await page.evaluate((p) => {
    const text = window.__cerebroMockFs.get(p);
    if (text === undefined) throw new Error(`no mock file at ${p}`);
    const close = text.indexOf('\n---\n', 4);
    const notice = 'verified: verified at r2; current is r3 — attestation predates revision\n';
    window.__cerebroMockFs.set(p, text.slice(0, close + 1) + notice + text.slice(close + 1));
  }, CONCEPT);
  // The mock has no watcher; a store write (verifying another concept)
  // triggers the rescan that picks the projection up.
  await page.getByTestId('concept-row').filter({ hasText: 'Warehouse cutover' }).click();
  await page.getByRole('button', { name: /^Verify$/ }).click();

  await page.getByTestId('concept-row').filter({ hasText: 'Sync error rate' }).click();
  const panel = page.getByTestId('knowledge-panel');
  await expect(panel.getByTestId('verified-notice')).toContainText(
    'verified at r2; current is r3 — attestation predates revision',
  );
  // The stale review does NOT count as verification of the current content —
  // and M27.5c says which of the two it is. `predates_current` keeps the fact
  // that somebody looked, which `unverified` used to throw away.
  await expect(panel.getByTestId('review-chip')).toHaveAttribute('data-review', 'predates_current');
});

test("knowledge: the bundle navigates by its own axes, not by Home's", async ({ page }) => {
  await boot(page);
  await page.getByTestId('rail').getByRole('button', { name: /^Base/ }).click();

  // The sidebar stops being Home's. Collections and Types describe a corpus
  // with a different author; standing on Knowledge they have no business here.
  await expect(page.getByTestId('sidebar-type')).toHaveCount(0);
  await expect(page.getByTestId('collection-node-collection')).toHaveCount(0);
  await expect(page.getByTestId('collection-node-list')).toHaveCount(0);

  const nav = page.getByTestId('knowledge-nav-row');

  // -- Threads lead, and the tab opens on the heaviest one (M33a.3) -------
  // Not a fixed name: the demo bundle anchors three concepts to the offline
  // sync work and two to Phoenix, so the winner is a fact about the seed. What
  // is under test is that a THREAD is where you land, not the flat list.
  const landed = nav.filter({ hasText: 'Offline sync hardening' });
  await expect(landed).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('knowledge-heading')).toHaveText('Offline sync hardening');

  // -- And it reads the thread, not the first concept in it (M33a.4) ------
  // What the base believes about a subject is the whole thread; opening
  // whichever concept sorted first answered a question nobody asked.
  const thread = page.getByTestId('thread-view');
  await expect(thread).toBeVisible();
  await expect(page.getByTestId('knowledge-panel')).toHaveCount(0);
  // Contested leads, and it names what replaced what. The pilot's week-long
  // window lost to the 72-hour decision, and the seed says so in a field.
  await expect(page.locator('[data-section="thread-contested"]')).toContainText(
    'replaced by The offline guarantee',
  );
  await expect(page.locator('[data-section="thread-stale"]')).toContainText('Sync error rate');
  await expect(page.locator('[data-section="thread-sources"]')).toContainText('cited by');

  await nav.filter({ hasText: 'All concepts' }).click();
  const total = await page.getByTestId('concept-row').count();

  // -- Folders: the directories knowledge/index.md has always declared ----
  await nav.filter({ hasText: 'Metrics' }).click();
  await expect(page.getByTestId('knowledge-heading')).toHaveText('Metrics');
  const inMetrics = await page.getByTestId('concept-row').count();
  expect(inMetrics).toBeGreaterThan(0);
  expect(inMetrics).toBeLessThan(total);
  const metricPaths = await page
    .getByTestId('concept-row')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-path') ?? ''));
  expect(metricPaths.every((p) => p.startsWith('knowledge/metrics/'))).toBe(true);

  // -- By entity: the join `about:` exists to make ------------------------
  await nav.filter({ hasText: 'Offline sync hardening' }).click();
  await expect(page.getByTestId('knowledge-heading')).toHaveText('Offline sync hardening');
  const aboutPaths = await page
    .getByTestId('concept-row')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-path') ?? ''));
  // Knowledge about one project, gathered from across the bundle's folders —
  // which a section-only nav could never assemble.
  expect(aboutPaths).toContain('knowledge/metrics/sync-error-rate.md');
  expect(aboutPaths).toContain('knowledge/systems/offline-guarantee.md');

  // The anchor is followable in both directions: the panel gets you from a
  // concept back to the entity it is about. Opened by name, because a thread
  // no longer auto-selects one (M33a.4) — and the way back to the whole thread
  // is the row above the list.
  await page.getByTestId('concept-row').first().click();
  await expect(
    page.getByTestId('knowledge-panel').getByTestId('about-entity').first(),
  ).toBeVisible();
  await page.getByTestId('thread-overview-row').click();
  await expect(page.getByTestId('thread-view')).toBeVisible();

  // -- The log: what the agent has actually done -------------------------
  await nav.filter({ hasText: 'Update log' }).click();
  await expect(page.getByTestId('knowledge-log')).toBeVisible();
  await expect(page.getByTestId('log-day').first()).toContainText('2026-07-28');
  await expect(page.getByTestId('log-entry').first()).toHaveAttribute('data-kind', 'creation');

  // An entry names the concept it touched, and that name is a way back to it.
  await page.getByTestId('log-concept-link').filter({ hasText: 'Warehouse cutover' }).click();
  await expect(page.getByTestId('knowledge-panel')).toBeVisible();
  await expect(page.getByTestId('concept-body')).toContainText('Go-live night');
});

test('knowledge: the Rail carries no review badge', async ({ page }) => {
  await boot(page);

  // A count in the chrome is the app nagging you to drain a queue. The same
  // number lives on the "Needs review" row, where it describes a destination.
  const knowledge = page.getByTestId('rail').getByRole('button', { name: /^Base/ });
  await expect(knowledge).toHaveAttribute('aria-label', 'Base');
  await expect(knowledge.getByTestId('rail-badge')).toHaveCount(0);

  await knowledge.click();
  await expect(
    page.getByTestId('knowledge-nav-row').filter({ hasText: 'Needs review' }),
  ).toContainText(/\d/);
});

test('knowledge: the bundle stays out of the surfaces you author', async ({ page }) => {
  await boot(page);

  // OKF concept types are the agent's vocabulary, not the vault's schema —
  // they must not appear as ghost types in the sidebar.
  const types = page.getByTestId('sidebar-type');
  await expect(types.filter({ hasText: 'Metric' })).toHaveCount(0);
  await expect(types.filter({ hasText: 'Playbook' })).toHaveCount(0);

  // Not in Docs: the bundle is not yours to edit. Rail-scoped because the
  // demo vault also has folders whose names collide with the nav items.
  await page.getByTestId('rail').getByRole('button', { name: 'Docs' }).click();
  await expect(page.getByTestId('recent-doc').first()).toBeVisible();
  const docPaths = await page
    .getByTestId('recent-doc')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-path') ?? ''));
  expect(docPaths.some((p) => p.startsWith('knowledge/'))).toBe(false);

  // Not in the Inbox either, despite carrying no `_organized` flag.
  await page
    .getByTestId('rail')
    .getByRole('button', { name: /^Inbox/ })
    .click();
  // Asserted on PATHS, not row text: a capture in the demo vault is itself
  // about the sync error rate, so matching on title text would pass or fail
  // for reasons that have nothing to do with the bundle.
  const inboxPaths = await page
    .getByTestId('inbox-row')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-path') ?? ''));
  expect(inboxPaths.length).toBeGreaterThan(0);
  expect(inboxPaths.some((p) => p.startsWith('knowledge/'))).toBe(false);
});

/**
 * One row per facet, three chips per row, and a review chip that is none of
 * them (M27.5c).
 *
 * The browser mock has no ledger, so the axes are staged rather than derived —
 * the same seam `review.spec.ts` uses for cards. What is under test here is
 * the rendering contract: three orthogonal answers stay three, the scope of a
 * multi-facet belief is named, and an attestation never moves Support.
 */
const AXES = [
  {
    belief_id: '1'.repeat(32),
    path: 'metrics/sync-error-rate.md',
    belief_revision_event_id: 'r'.repeat(32),
    facets: [
      {
        key: {
          belief_id: '1'.repeat(32),
          belief_revision_event_id: 'r'.repeat(32),
          predicate: { kind: 'known', value: 'bill_of_materials' },
          state_stage: 'shipping',
        },
        support: {
          level: 'unsupported',
          ancestral_family_count: 0,
          independent_family_count: 0,
          independence_unknown_count: 0,
        },
        families: [],
        independence_edges: [],
        coverage: {
          kind: 'assessed',
          summary: 'blind',
          assessment_ids: ['a'.repeat(32)],
          fold_rule_version: 'coverage-fold-v1',
          dimensions: {},
        },
        validity: { freshness: 'stale', conflict: 'contested', lifecycle: 'active' },
        freshness_basis: {
          predicate_class: 'shipping_bom',
          anchor_event_id: 'o'.repeat(32),
          anchor_at: '2026-07-01T00:00:00Z',
          stale_after: '2026-07-08T00:00:00Z',
        },
        review: { status: 'unreviewed' },
        support_text: 'unsupported',
        coverage_text: 'blind coverage',
        validity_text: 'stale and contested',
        line: 'unsupported, blind coverage, stale and contested',
      },
      {
        key: {
          belief_id: '1'.repeat(32),
          belief_revision_event_id: 'r'.repeat(32),
          predicate: { kind: 'known', value: 'ci_status' },
          state_stage: 'implemented',
        },
        support: {
          level: 'corroborated',
          ancestral_family_count: 2,
          independent_family_count: 2,
          independence_unknown_count: 0,
        },
        families: [],
        independence_edges: [],
        coverage: {
          kind: 'assessed',
          summary: 'observed',
          assessment_ids: ['b'.repeat(32)],
          fold_rule_version: 'coverage-fold-v1',
          dimensions: {},
        },
        validity: { freshness: 'fresh', conflict: 'clear', lifecycle: 'active' },
        freshness_basis: {
          predicate_class: 'ci_status',
          anchor_event_id: 'p'.repeat(32),
          anchor_at: '2026-07-28T09:00:00Z',
          stale_after: '2026-07-28T15:00:00Z',
        },
        review: { status: 'unreviewed' },
        support_text: 'corroborated by 2 independent',
        coverage_text: 'observed coverage',
        validity_text: 'fresh',
        line: 'corroborated by 2 independent, observed coverage, fresh',
      },
    ],
  },
];

test('knowledge: the three axes render per facet, and review is not one of them', async ({
  page,
}) => {
  await boot(page);
  await page.evaluate((rows) => window.__cerebroSeedChips(rows), AXES);

  await page.getByTestId('rail').getByRole('button', { name: /^Base/ }).click();
  await page.getByTestId('concept-row').filter({ hasText: 'Sync error rate' }).click();

  const panel = page.getByTestId('knowledge-panel');
  const rows = panel.getByTestId('facet-chips');
  await expect(rows).toHaveCount(2);

  // Two claims on one revision, and they disagree. A single row about "the
  // belief" would have to pick one and be wrong about the other.
  await expect(rows.nth(0)).toHaveAttribute('data-facet', 'bill_of_materials at shipping');
  await expect(rows.nth(1)).toHaveAttribute('data-facet', 'ci_status at implemented');

  const bom = rows.nth(0).getByTestId('axis-chip');
  await expect(bom).toHaveCount(3);
  await expect(bom.nth(0)).toHaveText('unsupported');
  await expect(bom.nth(1)).toHaveText('blind coverage');
  await expect(bom.nth(2)).toHaveText('stale and contested');

  const ci = rows.nth(1).getByTestId('axis-chip');
  await expect(ci.nth(0)).toHaveText('corroborated by 2 independent');
  await expect(ci.nth(1)).toHaveText('observed coverage');
  await expect(ci.nth(2)).toHaveText('fresh');

  // The review chip is beside the axes and stays out of them. Verifying the
  // concept moves it to `current` and moves NOTHING on the Support chip —
  // an attestation says a person looked, not that anything rests underneath.
  await expect(panel.getByTestId('review-chip')).toHaveAttribute('data-review', 'unreviewed');
  await page.getByRole('button', { name: /^Verify$/ }).click();
  await expect(panel.getByTestId('review-chip')).toHaveAttribute('data-review', 'current');
  await expect(rows.nth(0).getByTestId('axis-chip').nth(0)).toHaveText('unsupported');
});

test('knowledge: a vault with no ledger shows no axes rather than empty ones', async ({ page }) => {
  // Nothing seeded, so nothing derived. Saying "unsupported" about a belief
  // nobody folded would be inventing an answer, and an empty chip row would
  // read as "we looked and found nothing".
  await boot(page);
  await page.getByTestId('rail').getByRole('button', { name: /^Base/ }).click();
  await page.getByTestId('concept-row').filter({ hasText: 'Sync error rate' }).click();

  const panel = page.getByTestId('knowledge-panel');
  await expect(panel.getByTestId('review-chip')).toBeVisible();
  await expect(panel.getByTestId('belief-axes')).toHaveCount(0);
  await expect(panel.getByTestId('axis-chip')).toHaveCount(0);
});
