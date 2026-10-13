import { test, expect, type Page } from '@playwright/test';
import { boot, openKnowledgeTab, readMockFile, showConceptDetails } from './boot';

const CONCEPT = 'knowledge/metrics/sync-error-rate.md';

/** A concept is a page (M50.1): open it from the list, and wait until the
 *  body has loaded — Verify pins the body on screen (M49.3). */
async function openConcept(page: Page, title: string) {
  await openKnowledgeTab(page, 'all');
  await page.getByTestId('concept-row').filter({ hasText: title }).first().click();
  await expect(page.getByTestId('doc-page')).toBeVisible();
  await expect(page.getByTestId('markdown-editor')).toBeVisible();
  return page.getByTestId('concept-review-bar');
}

const verify = (page: Page) => page.getByRole('button', { name: /^Verify$/ });

test('knowledge: browse the bundle, read provenance, and verify a concept', async ({ page }) => {
  await boot(page);

  await openKnowledgeTab(page, 'all');
  await expect(page.getByTestId('knowledge-page')).toBeVisible();
  // Counts come from the seed and change whenever it does. Assert the
  // relationships instead: the review queue is a proper subset of the bundle.
  const all = await page.getByTestId('concept-row').count();
  expect(all).toBeGreaterThan(2);

  // -- The review queue: each row says why it is there (M51.2) ------------
  await openKnowledgeTab(page, 'review');
  const queued = page.getByTestId('queue-row');
  const queuedCount = await queued.count();
  expect(queuedCount).toBeGreaterThan(0);
  expect(queuedCount).toBeLessThan(all);
  // Human-reviewed, in date, not deprecated — nothing to act on.
  await expect(queued.filter({ hasText: 'The offline guarantee' })).toHaveCount(0);
  const sync = queued.filter({ hasText: 'Sync error rate' });
  // Never reviewed, so it leads with that, as its page does (M52.5); the
  // recheck it is also due, and how late, is the reason's sentence on hover.
  await expect(sync).toHaveAttribute('data-reason', 'new');
  await expect(sync.getByTestId('queue-reason')).toHaveText('Unreviewed');
  await expect(sync.getByTestId('queue-reason')).toHaveAttribute(
    'title',
    'New from Assistant · 9d ago — Due a recheck · 2 days overdue',
  );

  // -- A concept opens as a page, its review in a bar under the title -----
  await sync.click();
  await expect(page.getByTestId('concept-title')).toHaveValue('Sync error rate');
  const bar = page.getByTestId('concept-review-bar');
  // Written by the attended assistant — said in the app's words (M50.3).
  await expect(bar.getByTestId('review-bar-author')).toHaveAttribute('data-author', 'assistant');
  // M27.5c: whether a review covers what this says NOW, and who did it.
  await expect(bar.getByTestId('review-chip')).toHaveAttribute('data-review', 'unreviewed');
  await expect(bar.getByTestId('review-chip')).toHaveAttribute('data-by', 'nobody');
  // The evidence is a click away, not a column wide.
  await expect(page.getByTestId('knowledge-panel')).toHaveCount(0);
  await bar.getByTestId('review-bar-sources').click();
  const panel = page.getByTestId('knowledge-panel');
  await expect(panel).toContainText('Nobody yet');
  await expect(panel).toContainText('42,000 uses');

  // -- Verify writes an OKF stamp and the review becomes current ---------
  await expect(verify(page)).toBeEnabled();
  await verify(page).click();
  await expect.poll(async () => readMockFile(page, CONCEPT)).toContain('human:me');
  await expect(bar.getByTestId('review-chip')).toHaveAttribute('data-review', 'current');
  await expect(bar.getByTestId('review-chip')).toHaveAttribute('data-by', 'human');
  // Verification and freshness are INDEPENDENT signals: confirming a claim
  // does not move its stale_after date.
  // How late, in the words the table's hover used (M52.5); the date on hover.
  await expect(bar).toContainText('Due a recheck · 2 days overdue');

  // M52.3 — but a person read it once it was due, so the row is cleared: a
  // row Verify could not clear kept the Review count from ever reaching zero.
  await openKnowledgeTab(page, 'review');
  await expect(page.getByTestId('queue-row')).toHaveCount(queuedCount - 1);
  await expect(page.getByTestId('queue-row').filter({ hasText: 'Sync error rate' })).toHaveCount(0);

  // A concept whose only flag was "unverified" leaves the queue too.
  await page.getByTestId('queue-row').filter({ hasText: 'Warehouse cutover' }).click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible();
  await expect(verify(page)).toBeEnabled();
  await verify(page).click();
  await expect
    .poll(async () => readMockFile(page, 'knowledge/playbooks/warehouse-cutover.md'))
    .toContain('human:me');
  await openKnowledgeTab(page, 'review');
  await expect(page.getByTestId('queue-row')).toHaveCount(queuedCount - 2);
});

test('knowledge: the queue is walkable from inside it (M51.2)', async ({ page }) => {
  await boot(page);
  await openKnowledgeTab(page, 'review');
  const first = page.getByTestId('queue-row').first();
  const second = await page.getByTestId('queue-row').nth(1).getAttribute('data-path');
  await first.click();
  await expect(page.getByTestId('review-pager')).toContainText('Review 1 of');
  await page.getByTestId('review-next').click();
  await expect(page.getByTestId('review-pager')).toContainText('Review 2 of');
  await expect(page.getByTestId('doc-page')).toBeVisible();
  const title = await page.getByTestId('concept-title').inputValue();
  await openKnowledgeTab(page, 'review');
  await expect(page.locator(`[data-testid="queue-row"][data-path="${second}"]`)).toContainText(
    title,
  );
});

// M52.5 — the whole queue went round from "9 of 9" to 1 while a folder's
// walk stopped; both end now, and Done goes back where the walk began.
test('knowledge: the queue ends at its last concept, and Done returns to Review', async ({
  page,
}) => {
  await boot(page);
  await openKnowledgeTab(page, 'review');
  const rows = page.getByTestId('queue-row');
  const total = await rows.count();
  await rows.last().click();
  const pager = page.getByTestId('review-pager');
  await expect(pager.getByRole('button', { name: `Review ${total} of ${total}` })).toBeVisible();
  await expect(page.getByTestId('review-next')).toHaveCount(0);
  await pager.getByTestId('review-done').click();
  await expect(page.getByTestId('knowledge-tab-review')).toHaveAttribute('aria-current', 'page');
});

// M52.5 — verifying the whole queue's last concept left its page with no
// pager at all, where a folder's walk said "Nothing left to review in
// Systems · Done". The whole queue's walk ends the same way, at Review.
test('knowledge: verifying through the whole queue ends the walk at Review', async ({ page }) => {
  await boot(page);
  await openKnowledgeTab(page, 'review');
  const total = await page.getByTestId('queue-row').count();
  expect(total).toBeGreaterThan(1);
  await page.getByTestId('knowledge-start-review').click();
  const pager = page.getByTestId('review-pager');
  for (let left = total; left > 0; left--) {
    await expect(page.getByTestId('markdown-editor')).toBeVisible();
    // Each verified concept leaves the queue, so the next is always its first.
    await expect(pager.getByRole('button', { name: `Review 1 of ${left}` })).toBeVisible();
    await verify(page).click();
    if (left > 1) {
      await expect(page.getByTestId('review-next')).toHaveText('Next to review');
      await page.getByTestId('review-next').click();
    }
  }
  await expect(pager).toContainText('Nothing left to review');
  await pager.getByTestId('review-done').click();
  await expect(page.getByTestId('knowledge-tab-review')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('queue-row')).toHaveCount(0);
});

test("knowledge: a page's strip opens what waits for review, and the queue takes over (M52.3)", async ({
  page,
}) => {
  await boot(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('phoenix warehouse rollout');
  await page
    .getByTestId('quick-open-result')
    .filter({ hasText: 'Phoenix warehouse rollout' })
    .first()
    .click();
  await page.getByRole('button', { name: 'Open in full page' }).click();
  const waiting = page.getByTestId('knowledge-strip').getByTestId('knowledge-strip-waiting');
  await expect(waiting).toContainText('to review');
  await waiting.click();
  // A concept page, with the pager saying where it sits in the queue.
  await expect(page.getByTestId('concept-review-bar')).toBeVisible();
  await expect(page.getByTestId('review-pager')).toContainText(/Review \d+ of \d+/);
});

test('knowledge: a verified concept revised later shows the predating notice (M23.4)', async ({
  page,
}) => {
  await boot(page);

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
  await openConcept(page, 'Warehouse cutover');
  await expect(verify(page)).toBeEnabled();
  await verify(page).click();
  await expect
    .poll(async () => readMockFile(page, 'knowledge/playbooks/warehouse-cutover.md'))
    .toContain('human:me');

  const bar = await openConcept(page, 'Sync error rate');
  const panel = await showConceptDetails(page);
  await expect(panel.getByTestId('verified-notice')).toContainText(
    'verified at r2; current is r3 — attestation predates revision',
  );
  // `predates_current` keeps the fact that somebody looked, which
  // `unverified` used to throw away.
  await expect(bar.getByTestId('review-chip')).toHaveAttribute('data-review', 'predates_current');
});

test("knowledge: the bundle navigates by its own axes, not by Home's", async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Open Knowledge' }).click();

  // M51: the section's rows are the bundle's folders, then Review — and the
  // page opens on every concept, filed under the same folders.
  await expect(page.getByTestId('sidebar-type').first()).toBeVisible();
  const nav = page.getByTestId('knowledge-nav-row');
  await expect(nav.first()).toHaveAttribute('data-tab', 'section');
  await expect(nav.last()).toHaveAttribute('data-tab', 'review');
  await expect(page.getByTestId('knowledge-tab-all')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('knowledge-heading')).toHaveText('Knowledge');
  const total = await page.getByTestId('concept-row').count();

  // -- A folder row narrows Concepts to that folder, and lights ------------
  const metrics = nav.filter({ hasText: 'Metrics' });
  await metrics.click();
  await expect(metrics).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('knowledge-heading')).toContainText('Metrics');
  await expect(page.getByTestId('knowledge-tab-all')).toHaveAttribute('aria-current', 'page');
  const inMetrics = await page.getByTestId('concept-row').count();
  expect(inMetrics).toBeGreaterThan(0);
  expect(inMetrics).toBeLessThan(total);
  const metricPaths = await page
    .getByTestId('concept-row')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-path') ?? ''));
  expect(metricPaths.every((p) => p.startsWith('knowledge/metrics/'))).toBe(true);

  // -- A concept is its page, and its details lead back into the vault -----
  await page.getByTestId('concept-row').filter({ hasText: 'Sync error rate' }).click();
  await expect(page.getByTestId('concept-title')).toHaveValue('Sync error rate');
  // M52.3 — reading one of its concepts, you are still in Knowledge: the
  // concept's folder stays lit, and nothing else does.
  await expect(metrics).toHaveAttribute('aria-current', 'page');
  await expect(nav.and(page.locator('[aria-current="page"]'))).toHaveCount(1);
  const panel = await showConceptDetails(page);
  await expect(panel.getByTestId('about-entity').first()).toBeVisible();

  // -- The log: what the agent has actually done, under Activity ----------
  await openKnowledgeTab(page, 'activity');
  await expect(page.getByTestId('knowledge-log')).toBeVisible();
  // The day as the table's Updated says it, the date itself kept on it (M52.5).
  const day = page.getByTestId('log-day').first().locator('time');
  await expect(day).toHaveText('Today');
  await expect(day).toHaveAttribute('datetime', '2026-07-28');
  await expect(page.getByTestId('log-entry').first()).toHaveAttribute('data-kind', 'creation');
  // A replacement reads as one: its tag and its sentence say the same thing.
  const replaced = page
    .getByTestId('log-entry')
    .filter({ has: page.getByTestId('log-entry-label').getByText('Replaced', { exact: true }) });
  await expect(replaced).toHaveCount(1);
  await expect(replaced).toContainText('The offline window was replaced by The offline guarantee');

  // An entry names the concept it touched — by its title now, not the words
  // logged on the day (M52.5) — and that name is a way back to it.
  await page
    .getByTestId('log-concept-link')
    .filter({ hasText: 'Warehouse cutover: go-live and rollback' })
    .click();
  await expect(page.getByTestId('concept-title')).toHaveValue(
    'Warehouse cutover: go-live and rollback',
  );
  await expect(page.getByTestId('markdown-editor')).toContainText('Go-live night');
});

// M52.5 — "Table, like collections": one row per concept under its folder's
// band, one status each, and a front door into the queue.
test('knowledge: Concepts is a table filed by folder, and Start review opens the queue', async ({
  page,
}) => {
  // Wide enough for every column: a narrower table sets Sources and Written by
  // aside for the summary, and then the summary.
  await page.setViewportSize({ width: 1800, height: 1000 });
  await boot(page);
  await openKnowledgeTab(page, 'review');
  const first = await page.getByTestId('queue-row').first().getAttribute('data-path');
  await openKnowledgeTab(page, 'all');

  const table = page.getByTestId('concept-list');
  await expect(table.getByRole('columnheader')).toHaveText([
    'Concept',
    'Summary',
    'Status',
    'Sources',
    'Written by',
    'Updated',
  ]);
  // Every row sits in its folder's band, and each band is a way into it.
  const rows = page.getByTestId('concept-row');
  const total = await rows.count();
  let filed = 0;
  for (const section of await page.getByTestId('concept-section').all()) {
    const folder = await section.getAttribute('data-folder');
    const paths = await section
      .getByTestId('concept-row')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-path') ?? ''));
    expect(paths.every((p) => p.startsWith(`knowledge/${folder}/`))).toBe(true);
    filed += paths.length;
  }
  expect(filed).toBe(total);
  // One status per row — a view's select value, a dot and a word.
  for (const row of await rows.all()) {
    await expect(row.getByTestId('concept-status').locator('[data-status-value]')).toHaveCount(1);
  }
  // Absent is never zero: the concept whose file keeps no sources list.
  await expect(
    page
      .locator('[data-testid="concept-row"][data-path="knowledge/systems/status-model.md"]')
      .locator('[data-column="sources"]'),
  ).toHaveText('not recorded');

  // M52.5 — the title outranks the summary: no title is cut while a summary
  // is drawn beside it.
  const cut = await table
    .locator('[data-concept-title-box]')
    .evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth).length);
  expect(cut).toBe(0);

  // A reviewed concept with a change waiting on it says what its page says,
  // and marks the change beside it (M52.5) — never a second status.
  const guarantee = page.locator(
    '[data-testid="concept-row"][data-path="knowledge/systems/offline-guarantee.md"]',
  );
  await expect(guarantee.locator('[data-status-value]')).toHaveText('Reviewed');
  await expect(guarantee.getByTestId('concept-proposal')).toHaveText('+1 change');
  // And a retired one stays retired, with its card marked beside it.
  const webinar = page.locator(
    '[data-testid="concept-row"][data-path="knowledge/metrics/webinar-attendance.md"]',
  );
  await expect(webinar.locator('[data-status-value]')).toHaveText('Deprecated');
  await expect(webinar.getByTestId('concept-proposal')).toHaveText('+1 change');
  // A queued one keeps saying why it is queued, and marks the card beside
  // it (M52.5): the demo's link card names both of its concepts, as Rust's
  // `edit_relation` cards do — so each end says "+1 link", the two marks
  // read as the one card the header counts, and the hover names the other end.
  for (const [path, other] of [
    ['knowledge/systems/pick-queue-drain.md', 'this concept refines Warehouse cutover'],
    ['knowledge/playbooks/warehouse-cutover.md', 'Pick queue drain time refines this concept'],
  ]) {
    const linked = page.locator(`[data-testid="concept-row"][data-path="${path}"]`);
    await expect(linked.locator('[data-status-value]')).toHaveText('Unreviewed');
    const mark = linked.getByTestId('concept-proposal');
    await expect(mark).toHaveText('+1 link');
    await expect(mark.locator('[title]')).toHaveAttribute(
      'title',
      new RegExp(`^Add a link: ${other}`),
    );
  }

  // The count beside the title, as a view's; Review counts both of its queues.
  await expect(page.getByTestId('knowledge-count')).toHaveText(String(total));
  const queued = Number(await page.getByTestId('knowledge-start-count').textContent());
  await expect(page.getByTestId('knowledge-summary')).toContainText(
    `${queued} to verify · 3 proposals`,
  );
  await expect(page.getByTestId('knowledge-tab-review')).toHaveText(`Review${queued + 3}`);

  // Narrower, the summary steps aside once it would get under 200px, and the
  // rest still fit.
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(table.getByRole('columnheader', { name: 'Summary' })).toBeHidden();
  await expect(table.getByRole('columnheader', { name: 'Status' })).toBeVisible();
  // …and its room goes to the titles (M52.5): the row reaches the table's
  // end — no empty strip after the last column — and no title is cut.
  await expect
    .poll(() =>
      table.evaluate((t) => {
        const header = t.querySelector('[role="row"]');
        const box = t.parentElement;
        if (header?.lastElementChild == null || box === null) return null;
        const end = header.lastElementChild.getBoundingClientRect().right;
        return Math.round(box.getBoundingClientRect().left + box.clientWidth - end);
      }),
    )
    .toBe(0);
  expect(
    await table
      .locator('[data-concept-title-box]')
      .evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth).length),
  ).toBe(0);

  await page.getByTestId('knowledge-start-review').click();
  await expect(page.getByTestId('review-pager')).toContainText('Review 1 of');
  await expect(page.getByTestId('doc-page')).toBeVisible();
  expect(first).not.toBeNull();
  await openKnowledgeTab(page, 'review');
  await expect(page.getByTestId('queue-row').first()).toHaveAttribute('data-path', first ?? '');
});

// M52.5 — in wrap mode the row's Open pill sat centred over the cell and
// covered the words of the title it opens. It floats at the end of the first
// line now, and the lines flow around it.
test('knowledge: a wrapped title keeps its Open pill off its words', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await boot(page);
  await openKnowledgeTab(page, 'all');
  // The Assistant beside it leaves the table too narrow for the longest
  // titles, with Updated already gone: they wrap.
  await page.getByTestId('sidebar').getByRole('button', { name: 'Assistant' }).click();
  const table = page.getByTestId('concept-list');
  await expect(table.getByRole('columnheader', { name: 'Updated' })).toHaveCount(0);
  const wrapped = table.locator('[data-testid="concept-row"]').filter({
    has: page.locator('[data-concept-title-box] > [data-testid="concept-open"]'),
  });
  await expect(wrapped.first()).toBeVisible();

  // The row whose title takes the most lines.
  const lines = (row: typeof wrapped) =>
    row.evaluate((r) => {
      const range = document.createRange();
      range.selectNodeContents(r.querySelector('[data-concept-title]') as Node);
      return range.getClientRects().length;
    });
  let most = wrapped.first();
  for (const row of await wrapped.all()) if ((await lines(row)) > (await lines(most))) most = row;
  expect(await lines(most)).toBeGreaterThan(1);

  await most.hover();
  const pill = most.getByTestId('concept-open');
  await expect(pill).toHaveCSS('opacity', '1');
  const overlaps = await most.evaluate((r) => {
    const box = (
      r.querySelector('[data-testid="concept-open"]') as HTMLElement
    ).getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(r.querySelector('[data-concept-title]') as Node);
    return [...range.getClientRects()].filter(
      (line) =>
        line.left < box.right &&
        line.right > box.left &&
        line.top < box.bottom &&
        line.bottom > box.top,
    ).length;
  });
  expect(overlaps).toBe(0);
});

// M52.5 — a folder's view counts the folder, and its Start review walks the
// folder: "Review 2 of 3" from a folder with one waiting, and Next walking
// into another folder, were the bundle's numbers under a folder's name.
test("knowledge: a folder's view counts the folder and walks only it", async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Open Knowledge' }).click();
  await page.getByTestId('knowledge-nav-row').filter({ hasText: 'Systems' }).click();
  await expect(page.getByTestId('knowledge-heading')).toContainText('Systems');
  // The crumb names the folder: no band repeats it, and no tab counts the
  // bundle beside it.
  await expect(page.getByTestId('concept-group')).toHaveCount(0);
  await expect(page.getByTestId('knowledge-tab-all')).toHaveText('Concepts');
  const rows = await page.getByTestId('concept-row').count();
  await expect(page.getByTestId('knowledge-count')).toHaveText(String(rows));
  await expect(page.getByTestId('knowledge-start-count')).toHaveText('1');

  await page.getByTestId('knowledge-start-review').click();
  const pager = page.getByTestId('review-pager');
  await expect(pager.getByRole('button', { name: 'Review 1 of 1 in Systems' })).toBeVisible();
  // The walk ends at its last concept: Done, not a Next into another folder.
  await expect(page.getByTestId('review-next')).toHaveCount(0);
  await pager.getByTestId('review-done').click();
  await expect(page.getByTestId('knowledge-heading')).toContainText('Systems');
});

test('knowledge: the Knowledge section carries no review badge', async ({ page }) => {
  await boot(page);

  // A count in the chrome is the app nagging you to drain a queue. The same
  // number lives on the Review row, where it describes a destination.
  const section = page.locator('button[aria-expanded]', { hasText: /^Knowledge$/ });
  await expect(section).toBeVisible();
  await expect(section.getByTestId('nav-badge')).toHaveCount(0);

  await expect(page.getByTestId('knowledge-nav-row').filter({ hasText: 'Review' })).toContainText(
    /\d/,
  );
});

test('knowledge: the bundle stays out of the surfaces you author', async ({ page }) => {
  await boot(page);

  // OKF concept types are the agent's vocabulary, not the vault's schema —
  // they must not appear as ghost types in the sidebar.
  const types = page.getByTestId('sidebar-type');
  await expect(types.filter({ hasText: 'Metric' })).toHaveCount(0);
  await expect(types.filter({ hasText: 'Playbook' })).toHaveCount(0);

  // Not in the Pages tree: the bundle is not yours to edit, so `docsOnly`
  // prunes its files and the knowledge/ folder with them (M38.3 — the tree
  // is the standing pages nav now that the Docs surface is gone).
  const tree = page.getByTestId('file-tree');
  await expect(tree.getByTestId('tree-row').first()).toBeVisible();
  const docPaths = await tree
    .getByTestId('tree-row')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-path') ?? ''));
  expect(docPaths.length).toBeGreaterThan(0);
  expect(docPaths.some((p) => p.startsWith('knowledge'))).toBe(false);

  // Not in the Inbox either, despite carrying no `_organized` flag.
  await page
    .getByTestId('nav-surfaces')
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
        support_text: 'no evidence offered',
        coverage_text: 'sources not observed',
        validity_text: 'stale and contested',
        line: 'no evidence offered, sources not observed, stale and contested',
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
        support_text: 'corroborated by 2 independent sources',
        coverage_text: 'sources observed',
        validity_text: 'fresh',
        line: 'corroborated by 2 independent sources, sources observed, fresh',
      },
    ],
  },
];

test('knowledge: the three axes render per facet, and review is not one of them', async ({
  page,
}) => {
  await boot(page);
  await page.evaluate((rows) => window.__cerebroSeedChips(rows), AXES);

  const bar = await openConcept(page, 'Sync error rate');
  const panel = await showConceptDetails(page);
  const rows = panel.getByTestId('facet-chips');
  await expect(rows).toHaveCount(2);

  // Two claims on one revision, and they disagree. A single row about "the
  // belief" would have to pick one and be wrong about the other.
  await expect(rows.nth(0)).toHaveAttribute('data-facet', 'bill_of_materials at shipping');
  await expect(rows.nth(1)).toHaveAttribute('data-facet', 'ci_status at implemented');
  // The key stays on the element; the reader gets Activity's words (M52.5).
  await expect(rows.nth(1).getByTestId('facet-scope')).toHaveText(
    'CI status, at the implemented stage',
  );

  const bom = rows.nth(0).getByTestId('axis-chip');
  await expect(bom).toHaveCount(3);
  await expect(bom.nth(0)).toHaveText('no evidence offered');
  await expect(bom.nth(1)).toHaveText('sources not observed');
  await expect(bom.nth(2)).toHaveText('stale and contested');

  const ci = rows.nth(1).getByTestId('axis-chip');
  await expect(ci.nth(0)).toHaveText('corroborated by 2 independent sources');
  await expect(ci.nth(1)).toHaveText('sources observed');
  await expect(ci.nth(2)).toHaveText('fresh');

  // The review chip is apart from the axes — in the bar, not the details.
  // Verifying the concept moves it to `current` and moves NOTHING on the
  // Support chip — an attestation says a person looked, not that anything
  // rests underneath.
  await expect(panel.getByTestId('review-chip')).toHaveCount(0);
  await expect(bar.getByTestId('review-chip')).toHaveAttribute('data-review', 'unreviewed');
  await expect(verify(page)).toBeEnabled();
  await verify(page).click();
  await expect(bar.getByTestId('review-chip')).toHaveAttribute('data-review', 'current');
  await expect(rows.nth(0).getByTestId('axis-chip').nth(0)).toHaveText('no evidence offered');
});

test('knowledge: a vault with no ledger shows no axes rather than empty ones', async ({ page }) => {
  // Nothing seeded, so nothing derived. Saying "unsupported" about a belief
  // nobody folded would be inventing an answer, and an empty chip row would
  // read as "we looked and found nothing".
  await boot(page);
  const bar = await openConcept(page, 'Sync error rate');
  await expect(bar.getByTestId('review-chip')).toBeVisible();
  const panel = await showConceptDetails(page);
  await expect(panel.getByTestId('belief-axes')).toHaveCount(0);
  await expect(panel.getByTestId('axis-chip')).toHaveCount(0);
});
