import { expect, test, type Page } from '@playwright/test';
import { boot, openKnowledgeTab } from './boot';

/**
 * Up next (M57.5): text sent while a turn runs waits under the composer, in
 * order, instead of being dropped. The mock agent's `wait for me` script holds
 * mid-tool until `window.__cerebroReleaseMockRuns()` lets it go, so a spec can
 * queue, edit, steer and stop while a run is busy.
 */

const RISKS = 'What is at risk right now?';
const RISKS_REPLY = 'Two risks are open';

async function openPanel(page: Page) {
  await boot(page);
  await page.getByTestId('sidebar').getByRole('button', { name: 'Assistant' }).click();
  const panel = page.getByTestId('ai-panel');
  await expect(panel).toBeVisible();
  return panel;
}

/** Type into the composer and press Enter, as a person does mid-turn. */
async function enter(page: Page, text: string) {
  const composer = page.getByTestId('ai-panel').getByLabel('Message the assistant');
  await composer.fill(text);
  await composer.press('Enter');
}

/** Start the held turn and wait until it is mid-tool. */
async function holdATurn(page: Page) {
  const panel = page.getByTestId('ai-panel');
  await enter(page, 'wait for me');
  await expect(panel.getByTestId('action-card').first()).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByTestId('composer-status')).toHaveText('Working… · Enter adds to Up next');
}

const assistants = (page: Page) =>
  page.getByTestId('ai-panel').locator('[data-testid="chat-message"][data-role="assistant"]');

test('agent: text sent mid-turn waits under Up next, and Steer runs it next', async ({ page }) => {
  const panel = await openPanel(page);
  await holdATurn(page);

  await enter(page, RISKS);
  const entries = panel.getByTestId('up-next-entry');
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toContainText(RISKS);
  // The draft went to Up next, not into the void.
  await expect(panel.getByLabel('Message the assistant')).toHaveValue('');

  await entries.first().getByTestId('up-next-steer').click();
  await expect(assistants(page).first().getByTestId('turn-cancelled')).toHaveText('Cancelled');
  await expect(assistants(page).nth(1)).toContainText(RISKS_REPLY, { timeout: 10_000 });
  await expect(panel.getByTestId('up-next')).toBeHidden();
  // Steer never holds: nothing is left on hold.
  await expect(panel.getByTestId('up-next-held')).toHaveCount(0);
});

test('agent: Up next entries can be edited and removed before they run', async ({ page }) => {
  const panel = await openPanel(page);
  await holdATurn(page);

  await enter(page, 'what is in the inbox?');
  await enter(page, 'say something else');
  const entries = panel.getByTestId('up-next-entry');
  await expect(entries).toHaveCount(2);

  await entries.first().getByTestId('up-next-edit').click();
  const editor = panel.getByTestId('up-next-editor');
  await editor.fill(RISKS);
  await editor.press('Enter');
  await expect(entries.first()).toContainText(RISKS);

  await entries.nth(1).getByTestId('up-next-remove').click();
  await expect(entries).toHaveCount(1);

  await page.evaluate(() =>
    (window as unknown as { __cerebroReleaseMockRuns: () => void }).__cerebroReleaseMockRuns(),
  );
  await expect(assistants(page).first()).toContainText('Done waiting.', { timeout: 10_000 });
  await expect(assistants(page).nth(1)).toContainText(RISKS_REPLY, { timeout: 10_000 });
  await expect(assistants(page)).toHaveCount(2);
  await expect(panel.getByTestId('up-next')).toBeHidden();
});

test('agent: Stop puts Up next on hold until Resume', async ({ page }) => {
  const panel = await openPanel(page);
  await holdATurn(page);
  await enter(page, RISKS);
  await expect(panel.getByTestId('up-next-entry')).toHaveCount(1);

  await panel.getByRole('button', { name: 'Stop' }).click();
  await expect(assistants(page).first().getByTestId('turn-cancelled')).toBeVisible();
  await expect(panel.getByTestId('up-next-held')).toContainText(
    'Up next is on hold because the last turn stopped.',
  );
  await expect(panel.getByTestId('up-next-entry')).toHaveCount(1);
  await expect(assistants(page)).toHaveCount(1);

  await panel.getByTestId('up-next-resume').click();
  await expect(assistants(page).nth(1)).toContainText(RISKS_REPLY, { timeout: 10_000 });
  await expect(panel.getByTestId('up-next')).toBeHidden();
});

test('agent: two page asks during a turn both wait under Up next', async ({ page }) => {
  const panel = await openPanel(page);
  await holdATurn(page);

  await openKnowledgeTab(page, 'all');
  await page
    .locator('[data-testid="concept-row"][data-path="knowledge/systems/pick-queue-drain.md"]')
    .click();
  await page.getByTestId('concept-review-bar').getByTestId('revise-concept').click();
  const entries = panel.getByTestId('up-next-entry');
  await expect(entries).toHaveCount(1);

  await openKnowledgeTab(page, 'all');
  await page
    .locator('[data-testid="concept-row"][data-path="knowledge/metrics/sync-error-rate.md"]')
    .click();
  await page.getByTestId('concept-review-bar').getByTestId('recheck-concept').click();
  await expect(entries).toHaveCount(2);
  await expect(entries.first()).toContainText('Pick queue drain time');
  await expect(entries.nth(1)).toContainText('Sync error rate');
  // A page ask is not typed text: it is never offered for editing.
  await expect(panel.getByTestId('up-next-edit')).toHaveCount(0);
});

test('agent: Steer with a card open cancels it and runs the entry at once', async ({ page }) => {
  await boot(page);
  const PAGE = 'delivery/how-we-schedule.md';
  await page.evaluate(([path]) => window.__cerebroMockFs.set(path, '# How we schedule\n'), [PAGE]);
  await page.evaluate(() => {
    (window as unknown as { __cerebroMockAsk?: string[] }).__cerebroMockAsk = ['append_to_note'];
  });
  await page.getByTestId('sidebar').getByRole('button', { name: 'Assistant' }).click();
  const panel = page.getByTestId('ai-panel');
  await enter(page, `append "- call the vendor" to ${PAGE}`);
  const card = panel.getByTestId('interaction-card');
  await expect(card).toBeVisible({ timeout: 10_000 });

  await enter(page, RISKS);
  await expect(panel.getByTestId('up-next-entry')).toHaveCount(1);
  await panel.getByTestId('up-next-steer').click();
  await expect(card).toBeHidden();
  await expect(panel.getByTestId('action-card').filter({ hasText: PAGE })).toHaveAttribute(
    'data-status',
    'cancelled',
  );
  await expect(assistants(page).nth(1)).toContainText(RISKS_REPLY, { timeout: 10_000 });
  await expect(panel.getByTestId('up-next')).toBeHidden();
});
