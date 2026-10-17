import { expect, test, type Locator, type Page } from '@playwright/test';
import { boot, openAssistantPanel } from './boot';

/**
 * Review notes on a turn's diff (M58.5): a turn's View diff opens the
 * version lens on Lines, a note goes on a line, and the dock under Up next
 * sends every queued note to the agent as one numbered prompt, through Up
 * next when the conversation is busy.
 *
 * Through the mock agent's append script (src/agent/mockAgent.ts), whose run
 * commits what it wrote (src/lib/mockGit.ts `commitRun`), its `wait for me`
 * script and `window.__cerebroReleaseMockRuns()`, and its review-notes reply.
 */

const SCANNER = 'records/risks/risk-scanner-delivery.md';
const MESSAGING = 'records/risks/risk-messaging-unvalidated.md';

const panel = (page: Page) => page.getByTestId('ai-panel');
const users = (page: Page) => panel(page).locator('[data-testid="chat-message"][data-role="user"]');
const assistants = (page: Page) =>
  panel(page).locator('[data-testid="chat-message"][data-role="assistant"]');

async function openPanel(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  await openAssistantPanel(page);
  await expect(panel(page)).toBeVisible();
}

async function enter(page: Page, text: string) {
  const composer = panel(page).getByLabel('Message the assistant');
  await composer.fill(text);
  await composer.press('Enter');
}

/** Run one append turn and wait for its commit to land in the footer. */
async function appendTurn(page: Page, line: string, path: string): Promise<Locator> {
  const before = await assistants(page).count();
  await enter(page, `append "${line}" to ${path}`);
  const reply = assistants(page).nth(before);
  await expect(reply).toContainText(`I appended that to ${path}.`, { timeout: 10_000 });
  await expect(reply.getByTestId('turn-changeset')).toContainText('Changed 1 file', {
    timeout: 10_000,
  });
  return reply;
}

/** The turn's action card View diff, then a note on the added line. */
async function noteOn(page: Page, reply: Locator, line: string, text: string) {
  const card = reply.getByTestId('action-card').first();
  await card.locator('button').first().click();
  await card.getByTestId('action-view-diff').click();
  const lens = page.getByTestId('inline-diff');
  await expect(lens).toBeVisible({ timeout: 10_000 });
  await expect(lens.getByTestId('version-tab-lines')).toHaveAttribute('aria-selected', 'true');
  const row = lens.locator('[data-kind="add"]').filter({ hasText: line });
  await row.getByTestId('diff-note-line').click();
  await lens.getByTestId('diff-note-text').fill(text);
  await lens.getByTestId('diff-note-add').click();
  await expect(lens.getByTestId('diff-note').filter({ hasText: text })).toContainText(
    'Queued for the agent',
  );
}

test('two notes on two files reach the agent as one numbered prompt', async ({ page }) => {
  await openPanel(page);
  const first = await appendTurn(page, 'The vendor named a third date.', SCANNER);
  await noteOn(page, first, 'The vendor named a third date.', 'Name the vendor.');
  const second = await appendTurn(page, 'No customer has seen the copy.', MESSAGING);
  await noteOn(page, second, 'No customer has seen the copy.', 'Say which customers.');

  const dock = panel(page).getByTestId('review-notes-dock');
  await expect(dock.getByTestId('review-notes-count')).toHaveText('2 review notes ready');
  const bubbles = await users(page).count();
  await dock.getByTestId('review-notes-send').click();

  await expect(users(page)).toHaveCount(bubbles + 1);
  const bubble = users(page).last();
  await expect(bubble).toContainText(
    'I reviewed your changes and left 2 notes. Work through them in order:',
  );
  await expect(bubble).toContainText(`1. \`${MESSAGING}\`, line`);
  await expect(bubble).toContainText(
    '(starting "No customer has seen the copy."): Say which customers.',
  );
  await expect(bubble).toContainText(`2. \`${SCANNER}\`, line`);
  await expect(bubble).toContainText(
    '(starting "The vendor named a third date."): Name the vendor.',
  );
  await expect(assistants(page).last()).toContainText('2 review notes', { timeout: 10_000 });
  await expect(dock).toBeHidden();

  const lens = page.getByTestId('inline-diff');
  await expect(lens.getByTestId('diff-note-status')).toHaveText([/^Sent to the agent/]);

  // Notes are this viewer's, in this device's storage: a reload keeps them sent.
  await page.reload();
  const stored = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem('cerebro.reviewNotes') ?? 'null'),
  );
  expect(stored.v).toBe(1);
  expect(stored.notes.map((n: { path: string }) => n.path).sort()).toEqual(
    [MESSAGING, SCANNER].sort(),
  );
  expect(stored.notes.every((n: { sentAt?: number }) => typeof n.sentAt === 'number')).toBe(true);
  // The panel stayed open across the reload; the thread and its notes are back.
  await expect(panel(page)).toBeVisible({ timeout: 10_000 });
  await expect(assistants(page).first()).toContainText(`I appended that to ${SCANNER}.`);
  await expect(panel(page).getByTestId('review-notes-dock')).toHaveCount(0);
  const card = assistants(page).first().getByTestId('action-card').first();
  await card.locator('button').first().click();
  await card.getByTestId('action-view-diff').click();
  await expect(page.getByTestId('inline-diff').getByTestId('diff-note-status')).toHaveText(
    /^Sent to the agent/,
    { timeout: 10_000 },
  );
});

test('busy, Send waits in Up next; removing the entry returns the notes', async ({ page }) => {
  await openPanel(page);
  const reply = await appendTurn(page, 'The vendor named a third date.', SCANNER);
  await noteOn(page, reply, 'The vendor named a third date.', 'Name the vendor.');

  await enter(page, 'wait for me');
  await expect(panel(page).getByTestId('composer-status')).toHaveText(
    'Working… · Enter adds to Up next',
    { timeout: 10_000 },
  );
  const dock = panel(page).getByTestId('review-notes-dock');
  await dock.getByTestId('review-notes-send').click();

  const entries = panel(page).getByTestId('up-next-entry');
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toContainText('I reviewed your changes and left a note on');
  await expect(entries.first().getByTestId('up-next-edit')).toHaveCount(0);
  await expect(dock).toBeHidden();
  const lens = page.getByTestId('inline-diff');
  await expect(lens.getByTestId('diff-note-status')).toHaveText('Waiting in Up next');

  await entries.first().getByTestId('up-next-remove').click();
  await expect(entries).toHaveCount(0);
  await expect(dock.getByTestId('review-notes-count')).toHaveText('1 review note ready');
  await expect(lens.getByTestId('diff-note-status')).toHaveText('Queued for the agent');

  await page.evaluate(() =>
    (window as unknown as { __cerebroReleaseMockRuns: () => void }).__cerebroReleaseMockRuns(),
  );
  await expect(assistants(page).last()).toContainText('Done waiting.', { timeout: 10_000 });
});
