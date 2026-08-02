import { test, expect, type Page } from '@playwright/test';

/**
 * The M8.2/M8.3 pipeline: ingest → distil → augment.
 *
 * The seeded demo vault carries one story end to end — a standup transcript
 * ingested as a working doc, a Jira ticket cached beside it, a concept
 * distilled from both and anchored to the project, and a PRD in that project
 * that the concept should surface next to.
 */

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

const TRANSCRIPT = 'inbox/phoenix-cutover-standup.md';
const CONCEPT = 'knowledge/systems/pick-queue-drain.md';

test('ingest: a dropped transcript becomes an untyped working doc in the Inbox', async ({
  page,
}) => {
  await boot(page);
  await page
    .getByTestId('rail')
    .getByRole('button', { name: /^Inbox/ })
    .click();

  // Drop a .vtt the way a user would. DataTransfer has to be built in the
  // page: Playwright cannot hand a File across the boundary.
  const handle = await page.evaluateHandle(() => {
    const vtt = [
      'WEBVTT',
      '',
      'NOTE auto-generated',
      '',
      '1',
      '00:00:03.000 --> 00:00:08.000',
      '<v Rosa Alvine>The scanner order slipped again, so night one is camera only.',
      '',
      '2',
      '00:00:08.500 --> 00:00:14.000',
      'Rosa Alvine: I want that written down before anyone plans around hardware.',
    ].join('\n');
    const dt = new DataTransfer();
    dt.items.add(new File([vtt], '2026-07-29 Scanner slip.vtt', { type: 'text/vtt' }));
    return dt;
  });
  await page.getByTestId('inbox-page').dispatchEvent('drop', { dataTransfer: handle });

  // It lands untyped — untyped is what queues it — and opens.
  const row = page.locator('[data-testid="inbox-row"][data-path="inbox/scanner-slip.md"]');
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('aria-selected', 'true');

  const written = await page.evaluate(
    () => window.__cerebroMockFs.get('inbox/scanner-slip.md') ?? '',
  );
  // The transcript is converted, not stored raw: cue timings and the WEBVTT
  // header are format, and the speaker turns are the content.
  expect(written).not.toContain('WEBVTT');
  expect(written).not.toContain('-->');
  expect(written).toContain('**Rosa Alvine:**');
  expect(written).toContain('camera only');
  // Provenance a distilled concept can cite later.
  expect(written).toContain('source_file:');
  expect(written).toContain('ingest_format: vtt');
  expect(written).not.toContain('\ntype:');
});

test('distil: the ingested transcript and its cached ticket are cited by a concept', async ({
  page,
}) => {
  await boot(page);
  await page
    .getByTestId('rail')
    .getByRole('button', { name: /^Knowledge/ })
    .click();

  await page.getByTestId('knowledge-nav-row').filter({ hasText: 'Phoenix warehouse' }).click();
  await page.locator(`[data-testid="concept-row"][data-path="${CONCEPT}"]`).click();

  // Both inlets show up as sources on the same concept: a dropped transcript
  // and a fetched ticket are the same kind of object by the time they get here.
  const panel = page.getByTestId('knowledge-panel');
  await expect(panel).toContainText('Phoenix cutover standup');
  await expect(panel).toContainText('PHX-421');
  // And it is anchored back to the work it describes.
  await expect(panel.getByTestId('about-entity')).toContainText(['Phoenix warehouse rollout']);
});

test('commit: any note says what the base took from it, not just Inbox captures', async ({
  page,
}) => {
  await boot(page);

  // A cached ticket is not an Inbox capture and never passed through the
  // queue, but the concept cites it — so it is committed, and its own page
  // says so. This is the whole point: the base grows from any note, and every
  // note can answer whether it has already been read.
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('phx-421');
  await page.getByTestId('quick-open-result').filter({ hasText: 'Rehearse' }).first().click();

  // M12: the cached ticket is a Source RECORD — it opens in the record
  // panel, where the knowledge loop lives collapsed until asked.
  const panel = page.getByTestId('detail-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('detail-knowledge-toggle').click();
  const commit = panel.getByTestId('knowledge-commit');
  await expect(commit).toHaveAttribute('data-state', 'committed');
  await expect(commit.getByTestId('committed-concept')).toContainText(['Pick queue drain time']);

  // Following it lands on the concept it produced.
  await commit.getByTestId('committed-concept').first().click();
  await expect(page.getByTestId('concept-body')).toContainText('40 minutes in staging');

  // The same fact, visible without opening anything: the transcript row in
  // the queue carries what was distilled from it.
  await page
    .getByTestId('rail')
    .getByRole('button', { name: /^Inbox/ })
    .click();
  const row = page.locator(`[data-testid="inbox-row"][data-path="${TRANSCRIPT}"]`);
  await expect(row.getByTestId('row-committed')).toHaveText('1');

  // And a capture nothing has been learned from says that plainly, with the
  // action that would change it — no queue, no badge, no nagging.
  await page.locator('[data-testid="inbox-row"]').filter({ hasText: 'Warehouse cutover' }).click();
  const organize = page.getByLabel('Organize').getByTestId('knowledge-commit');
  await expect(organize).toHaveAttribute('data-state', 'uncommitted');
  await expect(organize.getByRole('button', { name: 'Learn from this' })).toBeVisible();
});

test('augment: knowledge surfaces beside the PRD, and only when asked', async ({ page }) => {
  await boot(page);

  // Opened through Quick Open — the Docs tree layout is not what is under
  // test here.
  await page.keyboard.press('ControlOrMeta+k');
  const quickOpen = page.getByTestId('quick-open-input');
  await expect(quickOpen).toBeVisible();
  // Picked by name, not position: "go-live" also matches the warehouse key
  // result, and quick open breaks ties toward the shorter title.
  await quickOpen.fill('go-live');
  await page.getByTestId('quick-open-result').filter({ hasText: 'PRD' }).first().click();

  // M12: the PRD is a Spec RECORD now — it opens in the record panel, and
  // the knowledge view lives there too.
  const panel = page.getByTestId('detail-panel');
  await expect(panel).toBeVisible();

  // Nothing has spoken yet: the section exists but is collapsed, so the
  // draft is not annotated until the user opens it.
  await expect(panel.getByTestId('related-knowledge')).toHaveCount(0);

  await panel.getByTestId('detail-knowledge-toggle').click();
  const related = panel.getByTestId('related-knowledge');
  await expect(related).toBeVisible();
  // The PRD never names the concept; it is found through the project it lives in.
  await expect(related.getByTestId('related-concept')).toContainText(['Pick queue drain time']);

  // Following it lands on that concept, not on the head of the bundle.
  await related.getByTestId('related-concept').first().click();
  await expect(page.getByTestId('knowledge-page')).toBeVisible();
  await expect(page.getByTestId('concept-body')).toContainText('40 minutes in staging');
});

test('augment: Home volunteers at most a few unconfirmed things, and forgets what you dismiss', async ({
  page,
}) => {
  await boot(page);

  const card = page.getByTestId('learned-card');
  await expect(card).toBeVisible();
  const items = card.getByTestId('learned-item');
  const before = await items.count();
  expect(before).toBeGreaterThan(0);
  expect(before).toBeLessThanOrEqual(3);

  const first = items.first();
  const path = await first.locator('[data-path]').getAttribute('data-path');
  await first.getByRole('button', { name: /^Dismiss/ }).click();
  await expect(card.locator(`[data-path="${path}"]`)).toHaveCount(0);

  // Dismissed means dismissed — a card that came back tomorrow is the nagging
  // this surface is not allowed to do.
  await page.reload();
  await expect(page.getByTestId('learned-card').locator(`[data-path="${path}"]`)).toHaveCount(0);
});

test('grow: filing a capture hands it to the base without anyone asking', async ({ page }) => {
  // The one spec that leaves the background distiller on. Everything it does
  // is silent by design, so what is asserted is the absence of interruption
  // as much as the presence of the work.
  await page.addInitScript(() => window.localStorage.setItem('cerebro.autoLearn', 'true'));
  await page.goto('/');
  const demoButton = page.getByRole('button', { name: 'Open demo vault' });
  const sidebarTypes = page.getByTestId('sidebar-type');
  await expect(demoButton.or(sidebarTypes.first())).toBeVisible({ timeout: 10_000 });
  if (await demoButton.isVisible()) await demoButton.click();
  await expect(sidebarTypes.first()).toBeVisible({ timeout: 10_000 });

  await page
    .getByTestId('rail')
    .getByRole('button', { name: /^Inbox/ })
    .click();
  await page.locator('[data-testid="inbox-row"]').filter({ hasText: 'Warehouse cutover' }).click();

  const organize = page.getByLabel('Organize').getByTestId('knowledge-commit');
  await expect(organize).toHaveAttribute('data-state', 'uncommitted');
  await expect(organize.getByTestId('learn-queued')).toHaveCount(0);

  // Filing it is the trigger. No dialog, no prompt, no panel opening.
  await page.getByRole('button', { name: /Mark organized/i }).click();
  await expect(page.getByTestId('ai-panel')).toHaveCount(0);

  // The capture left the queue, so it is reached the way any filed note is.
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('warehouse cutover');
  await page.getByTestId('quick-open-result').first().click();
  await page.getByTestId('doc-side-panel').getByTestId('doc-panel-tab-knowledge').click();
  await expect(page.getByTestId('doc-side-panel').getByTestId('learn-queued')).toContainText(
    /Queued to be read|Reading this now/,
  );
});

test('retire: a replaced concept says so, and stops asking to be verified', async ({ page }) => {
  await boot(page);
  await page
    .getByTestId('rail')
    .getByRole('button', { name: /^Knowledge/ })
    .click();

  // The pilot's week-long offline window was replaced by the 72-hour decision.
  const replaced = page.locator(
    '[data-testid="concept-row"][data-path="knowledge/systems/offline-window-pilot.md"]',
  );
  await replaced.click();

  // It carries the edge it never declared: the REPLACEMENT is what knows.
  const relation = page
    .getByTestId('knowledge-panel')
    .getByTestId('concept-relation')
    .filter({ hasText: 'The offline guarantee' });
  await expect(relation).toHaveAttribute('data-label', 'Replaced by');

  // Following it lands on the concept that won.
  await relation.click();
  await expect(page.getByTestId('concept-body')).toContainText('72 hours');
  await expect(
    page.getByTestId('knowledge-panel').getByTestId('concept-relation').first(),
  ).toHaveAttribute('data-label', 'Replaces');

  // And the retired one is out of the review queue — verifying a claim that
  // something newer already overrode is busywork.
  await page.getByTestId('knowledge-nav-row').filter({ hasText: 'Needs review' }).click();
  await expect(
    page.locator(
      '[data-testid="concept-row"][data-path="knowledge/systems/offline-window-pilot.md"]',
    ),
  ).toHaveCount(0);
});

test('dossier: a project record says what the base believes, doubts, and no longer believes', async ({
  page,
}) => {
  await boot(page);

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('offline sync hardening');
  await page.getByTestId('quick-open-result').first().click();
  // M12.5 aftermath: a project is an ordinary record under records/projects/,
  // so its dossier rides the record panel (M14.2). The base holds concepts
  // ABOUT this record, which is what swaps the panel's related list for the
  // full dossier — capability, not type, decides.
  await expect(page.getByTestId('detail-panel')).toBeVisible();
  await page.getByTestId('detail-knowledge-toggle').click();

  const dossier = page.getByTestId('entity-dossier');
  await expect(dossier).toBeVisible();

  // What it currently believes — gathered from across the bundle's folders.
  const current = dossier.getByTestId('dossier-concept').filter({ hasNot: page.locator('s') });
  await expect(current.first()).toBeVisible();
  await expect(dossier).toContainText('The offline guarantee');

  // What it no longer believes is kept, not hidden: the record of what was
  // held before is part of knowing how the base got here.
  const retired = dossier.getByTestId('dossier-retired');
  await expect(retired).toContainText('The offline window');

  // What is unresolved. A summary that showed only the confident parts is the
  // kind of confident-and-wrong that makes people stop trusting the whole thing.
  await expect(dossier.getByTestId('dossier-unsettled')).toContainText('recheck');

  // And what it read to get there — the reading list behind the claims.
  await expect(dossier.getByTestId('dossier-source').first()).toBeVisible();

  // Following a concept lands on it in the bundle.
  await dossier.getByTestId('dossier-concept').first().click();
  await expect(page.getByTestId('knowledge-page')).toBeVisible();
  await expect(page.getByTestId('concept-body')).toBeVisible();
});
