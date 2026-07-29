import { test, expect, type Page } from '@playwright/test';

/**
 * The panel runs against the scripted mock in browser mode (see
 * src/agent/mockAgent.ts) — the real agent is a local process reached through
 * Tauri. What is under test here is cerebro's half: the transcript, the tool
 * chips, streaming state, and the review loop. The CLI's half is covered by
 * the Rust unit tests over its stream format.
 */

async function boot(page: Page): Promise<void> {
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

test('agent: permission mode is a visible, persisted choice', async ({ page }) => {
  await boot(page);
  await page.getByTestId('rail').getByRole('button', { name: 'Assistant' }).click();
  const panel = page.getByTestId('ai-panel');

  // Defaults to vault edits — shell access is never inherited.
  const mode = panel.getByRole('combobox');
  await expect(mode).toHaveValue('vault_edits');
  await mode.selectOption('read_only');
  await expect(panel).toContainText('Cannot change anything');

  await page.reload();
  await expect(page.getByTestId('ai-panel').getByRole('combobox')).toHaveValue('read_only');
});

test('agent: a suggested filing is shown for approval, never applied', async ({ page }) => {
  await boot(page);
  await page.getByTestId('rail').getByRole('button', { name: /^Inbox/ }).click();

  const capture = page.getByTestId('inbox-row').first();
  const capturePath = await capture.getAttribute('data-path');
  await capture.click();

  // The agent proposes through the UI-action channel; nothing is written.
  await page.evaluate(async (path) => {
    const mod = await import('/src/agent/agentIpc.ts');
    mod.emitUiAction({
      action: 'propose_organize',
      path,
      type: 'Work item',
      properties: { status: 'todo', priority: 'high' },
      reasoning: 'It names an action and an owner, so it reads as a work item.',
    });
  }, capturePath);

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
