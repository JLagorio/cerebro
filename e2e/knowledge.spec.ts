import { test, expect, type Page } from '@playwright/test';

declare global {
  interface Window {
    __cerebroMockFs: Map<string, string>;
  }
}

async function readMockFile(page: Page, path: string): Promise<string> {
  const text = await page.evaluate((p) => window.__cerebroMockFs.get(p), path);
  if (text === undefined) throw new Error(`mock fs has no file at ${path}`);
  return text;
}

async function boot(page: Page): Promise<void> {
  // The background distiller (M8.6) is off for tests that are not about it:
  // a reader that fires four seconds in would rescan the vault mid-assertion.
  await page.addInitScript(() => window.localStorage.setItem('cerebro.autoLearn', 'false'));
  await page.goto('/');
  const demoButton = page.getByRole('button', { name: 'Open demo vault' });
  const sidebarTypes = page.getByTestId('sidebar-type');
  await expect(demoButton.or(sidebarTypes.first())).toBeVisible({ timeout: 10_000 });
  if (await demoButton.isVisible()) await demoButton.click();
  await expect(sidebarTypes.first()).toBeVisible({ timeout: 10_000 });
}

const CONCEPT = 'knowledge/metrics/sync-error-rate.md';

test('knowledge: browse the bundle, read provenance, and verify a concept', async ({ page }) => {
  await boot(page);

  await page
    .getByTestId('rail')
    .getByRole('button', { name: /^Knowledge/ })
    .click();
  await expect(page.getByTestId('knowledge-page')).toBeVisible();
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
  await expect(panel.getByTestId('trust-chip')).toHaveAttribute('data-tier', 'unverified');

  // -- Verify writes an OKF stamp and lifts the trust tier ---------------
  await page.getByRole('button', { name: /^Verify$/ }).click();
  await expect.poll(async () => readMockFile(page, CONCEPT)).toContain('human:me');
  await expect(panel.getByTestId('trust-chip')).toHaveAttribute('data-tier', 'human-reviewed');

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

test("knowledge: the bundle navigates by its own axes, not by Home's", async ({ page }) => {
  await boot(page);
  await page
    .getByTestId('rail')
    .getByRole('button', { name: /^Knowledge/ })
    .click();

  // The sidebar stops being Home's. Collections and Types describe a corpus
  // with a different author; standing on Knowledge they have no business here.
  await expect(page.getByTestId('sidebar-type')).toHaveCount(0);
  await expect(page.getByTestId('collection-node-collection')).toHaveCount(0);
  await expect(page.getByTestId('collection-node-list')).toHaveCount(0);

  const nav = page.getByTestId('knowledge-nav-row');
  const total = await page.getByTestId('concept-row').count();

  // -- Sections: the folders knowledge/index.md has always declared -------
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
  // concept back to the entity it is about.
  await expect(
    page.getByTestId('knowledge-panel').getByTestId('about-entity').first(),
  ).toBeVisible();

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
  const knowledge = page.getByTestId('rail').getByRole('button', { name: /^Knowledge/ });
  await expect(knowledge).toHaveAttribute('aria-label', 'Knowledge');
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
