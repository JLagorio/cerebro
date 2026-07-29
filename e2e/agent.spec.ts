import { test, expect, type Page } from '@playwright/test';

/**
 * The panel runs against the scripted mock in browser mode (see
 * src/agent/mockAgent.ts) — the real agent is a local process reached through
 * Tauri. What is under test here is cerebro's half: the transcript, the tool
 * chips, streaming state, and the review loop. The CLI's half is covered by
 * the Rust unit tests over its stream format.
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

test('agent: the panel streams a reply and shows what it did', async ({ page }) => {
  await boot(page);

  await page.getByTestId('rail').getByRole('button', { name: 'Assistant' }).click();
  const panel = page.getByTestId('ai-panel');
  await expect(panel).toBeVisible();

  await panel.getByLabel('Message the assistant').fill('What is at risk right now?');
  await panel.getByRole('button', { name: 'Send' }).click();

  // The user's message is in the transcript immediately.
  await expect(panel.getByTestId('chat-message').filter({ hasText: 'What is at risk' })).toBeVisible();

  // Tool use is visible, not hidden: an agent that reads your vault should
  // say so.
  await expect(panel.getByTestId('tool-chip')).toContainText('search notes');

  // The reply arrives and wikilinks in it are rendered as links.
  const reply = panel.getByTestId('chat-message').filter({ hasText: 'Two risks are open' });
  await expect(reply).toBeVisible({ timeout: 10_000 });
  await expect(reply.getByRole('button', { name: /scanner/i })).toBeVisible();
});

test('agent: shell access is one persisted ceiling in Settings, not a per-chat mode', async ({
  page,
}) => {
  await boot(page);

  // M8.1: the three-mode dropdown is gone from the panel. It asked the user to
  // declare a policy before knowing what they were going to ask for; what the
  // agent may change now follows from which folder it is writing to.
  await page.getByTestId('rail').getByRole('button', { name: 'Assistant' }).click();
  await expect(page.getByTestId('ai-panel').getByRole('combobox')).toHaveCount(0);

  await page.getByTestId('rail').getByRole('button', { name: 'Settings' }).click();
  const shell = page.getByRole('switch', { name: 'Shell access' });
  // Off by default — shell access is chosen, never inherited.
  await expect(shell).not.toBeChecked();
  // The checkbox itself is 0×0 by design; the label is what a user clicks.
  await page
    .locator('label.cb-switch')
    .filter({ has: page.getByRole('switch', { name: 'Shell access' }) })
    .click();
  await expect(shell).toBeChecked();

  await page.reload();
  await page.getByTestId('rail').getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('switch', { name: 'Shell access' })).toBeChecked();
});

const PROPOSED = 'inbox/warehouse-cutover-thought.md';

test('agent: a suggested filing is shown for approval, never applied', async ({ page }) => {
  await boot(page);

  // Driven through the panel, not by reaching into the module: the previous
  // version imported agentIpc inside page.evaluate, which Vite serves at a
  // different URL than the app's own copy once the file has been touched
  // since the dev server started (`?t=<hmr>`). Two module instances, two
  // listener sets, and the emit reached nobody — so the test passed on a cold
  // server and failed on a warm one.
  await page.getByTestId('rail').getByRole('button', { name: 'Assistant' }).click();
  const panel = page.getByTestId('ai-panel');
  await panel.getByLabel('Message the assistant').fill('Help me clear the Inbox');
  await panel.getByRole('button', { name: 'Send' }).click();

  // Proposing lands you on the Inbox, on the capture the proposal is ABOUT —
  // not on whatever the queue would otherwise have opened.
  await expect(page.getByTestId('inbox-page')).toBeVisible();
  await expect(page.locator(`[data-testid="inbox-row"][data-path="${PROPOSED}"]`)).toHaveAttribute(
    'aria-selected',
    'true',
  );

  const capturePath = PROPOSED;
  const card = page.getByTestId('proposal-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('reads as a work item');
  await expect(card).toContainText('Work item');

  // Still untyped: a proposal is a suggestion until the user acts on it.
  const beforeType = await page.evaluate(
    (p) => window.__cerebroMockFs.get(p as string) ?? '',
    capturePath,
  );
  expect(beforeType).not.toContain('type: Work item');

  await card.getByRole('button', { name: 'Apply' }).click();
  await expect
    .poll(async () =>
      page.evaluate((p) => window.__cerebroMockFs.get(p as string) ?? '', capturePath),
    )
    .toContain('type: Work item');
  await expect(card).toBeHidden();
});

test('agent: organizing AI-written work records who signed off', async ({ page }) => {
  await boot(page);
  await page.getByTestId('rail').getByRole('button', { name: /^Inbox/ }).click();

  // The seeded capture carrying `generated: {by: claude-code}` is labelled.
  const aiRow = page.getByTestId('inbox-row').filter({ has: page.getByTestId('from-ai') }).first();
  await expect(aiRow).toBeVisible();
  const path = await aiRow.getAttribute('data-path');
  await aiRow.click();

  await page.getByRole('button', { name: /Mark organized/i }).click();

  // Organizing agent output IS the review, so it leaves a human stamp —
  // that is what closes the loop the knowledge bundle opened.
  await expect
    .poll(async () => page.evaluate((p) => window.__cerebroMockFs.get(p as string) ?? '', path))
    .toContain('human:me');
});
