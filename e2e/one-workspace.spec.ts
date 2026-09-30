import { test, expect, type Page } from '@playwright/test';
import { boot, openAgents, openKnowledgeTab } from './boot';

/**
 * M50 — one workspace. The owner, 2026-09-28: the agents, Knowledge, the docs
 * and the AI panel "feel disconnected … the knowledge/base looks like a
 * separate UI". Each test here walks one of the joins that were missing.
 */

const CUTOVER = 'Warehouse cutover: go-live and rollback';

/** A record, found by its title, opened as a page. */
async function openRecordPage(page: Page, title: string) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill(title.toLowerCase());
  await page.getByTestId('quick-open-result').filter({ hasText: title }).first().click();
  await page.getByRole('button', { name: 'Open in full page' }).click();
  await expect(page.getByTestId('doc-page')).toBeVisible();
}

/** The Phoenix project, as a page. Knowledge holds two concepts about it. */
const openPhoenixPage = (page: Page) => openRecordPage(page, 'Phoenix warehouse rollout');

test('one workspace: a page says what Knowledge holds about it, and a concept is a page', async ({
  page,
}) => {
  await boot(page);
  await openPhoenixPage(page);

  // M50.2 — said where the page is read, not in a collapsed section.
  const strip = page.getByTestId('knowledge-strip');
  await expect(strip.getByTestId('knowledge-strip-concept')).toContainText(['Warehouse cutover']);
  await strip
    .getByTestId('knowledge-strip-concept')
    .filter({ hasText: 'Warehouse cutover' })
    .click();

  // M50.1 — the same page chrome as any page; M51.3 — its review under the
  // title, where the page is read.
  await expect(page.getByTestId('doc-page')).toBeVisible();
  await expect(page.getByTestId('concept-title')).toHaveValue(CUTOVER);
  await expect(page.getByTestId('concept-review-bar')).toBeVisible();
  await expect(page.getByTestId('markdown-editor')).toContainText('Go-live night');

  // Its crumb roots at Knowledge, and Knowledge is a list of such pages.
  await page
    .getByTestId('doc-page')
    .getByRole('button', { name: 'Knowledge', exact: true })
    .click();
  await expect(page.getByTestId('knowledge-page')).toBeVisible();
  await expect(page.getByTestId('knowledge-heading')).toContainText('Knowledge');
});

test('one workspace: the assistant follows the page — its knowledge and its questions', async ({
  page,
}) => {
  await boot(page);
  await openPhoenixPage(page);
  await page.getByTestId('sidebar').getByRole('button', { name: 'Assistant' }).click();
  const panel = page.getByTestId('ai-panel');

  // M50.4 — the questions this page's own surfaces ask, not the Inbox's —
  // and by the names those surfaces give them (M52.3).
  await expect(panel.getByTestId('ai-suggestion')).toHaveText([
    'What does Knowledge say about this?',
    "What's missing?",
    'Learn from this page',
  ]);

  // And the turn carries what Knowledge holds about it, shown and openable.
  const chip = panel.getByTestId('context-knowledge');
  await expect(chip).toContainText('Knowledge · 2');
  await chip.click();
  await panel.getByTestId('context-knowledge-list').getByText('Warehouse cutover').click();
  await expect(page.getByTestId('concept-title')).toHaveValue(CUTOVER);
});

// M52.4 — the chip counted every concept the turn carries, replaced ones
// too, so beside a strip saying two it said three.
test('one workspace: the assistant counts the Knowledge that stands, as the page does', async ({
  page,
}) => {
  await boot(page);
  await openRecordPage(page, 'Offline sync hardening');
  const strip = page.getByTestId('knowledge-strip').getByTestId('knowledge-strip-concept');
  await expect(strip).toHaveCount(2);
  await expect(strip.filter({ hasText: 'The offline window' })).toHaveCount(0);

  await page.getByTestId('sidebar').getByRole('button', { name: 'Assistant' }).click();
  const panel = page.getByTestId('ai-panel');
  const chip = panel.getByTestId('context-knowledge');
  await expect(chip).toContainText(`Knowledge · ${await strip.count()}`);
  await chip.click();
  // The replaced concept still travels — the agent must not quote it as
  // current — so it is listed, last, and says so.
  const rows = panel.getByTestId('context-knowledge-list').getByRole('button');
  await expect(rows).toHaveCount(3);
  await expect(rows.last()).toContainText('The offline window');
  await expect(rows.last()).toContainText('· replaced');
  await expect(rows.last()).not.toContainText('unreviewed');
});

test('one workspace: asking about a concept says what was asked, about which page, once', async ({
  page,
}) => {
  await boot(page);
  await openKnowledgeTab(page, 'all');
  await page
    .locator('[data-testid="concept-row"][data-path="knowledge/systems/pick-queue-drain.md"]')
    .click();

  // M52.3 — due nothing on the corpus's day, so the bar offers a revision,
  // and the transcript says that rather than pasting the prompt behind it.
  await page.getByTestId('concept-review-bar').getByTestId('revise-concept').click();
  const panel = page.getByTestId('ai-panel');
  const asked = 'Ask to revise · Pick queue drain time';
  await expect(panel.locator('[data-testid="chat-message"][data-role="user"]')).toHaveText(asked);
  await expect(panel.getByTestId('conversation-switcher')).toHaveText(asked);
  // The page is where you stand AND what you asked about: one chip, not two.
  await expect(panel.getByTestId('context-chip')).toHaveCount(1);
  await expect(panel.getByTestId('context-chip')).toContainText('Pick queue drain time');
});

test('one workspace: a run names the concepts it changed, each one a page', async ({ page }) => {
  await boot(page);
  await openAgents(page);

  // M50.3 — "2 applied" used to be all a run's detail could say.
  await page.locator('[data-testid="fleet-row"][data-run="run-ingest-2"]').click();
  const detail = page.getByTestId('run-detail');
  const writes = detail.getByTestId('run-detail-knowledge-write');
  await expect(writes).toHaveCount(2);
  await expect(writes.first()).toContainText('applied');
  await writes.filter({ hasText: 'Warehouse cutover' }).click();
  await expect(page.getByTestId('concept-title')).toHaveValue(CUTOVER);

  // And a run that recorded nothing about Knowledge says so, not "nothing".
  await openAgents(page);
  await page.locator('[data-testid="fleet-row"][data-run="run-scout-1"]').click();
  await expect(page.getByTestId('run-detail-knowledge')).toContainText('not recorded');
});
