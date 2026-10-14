import { test, expect } from '@playwright/test';
import { boot } from './boot';

/**
 * Transcript rows drawn by the tool manifest (M56.8), against the scripted
 * mock (src/agent/mockAgent.ts): "read five notes" calls get_note on five
 * demo-vault notes, and the panel folds the run into one row.
 */

test('agent: five note reads fold into one row', async ({ page }) => {
  await boot(page);

  await page.getByTestId('sidebar').getByRole('button', { name: 'Assistant' }).click();
  const panel = page.getByTestId('ai-panel');
  await expect(panel).toBeVisible();

  await panel.getByLabel('Message the assistant').fill('read five notes');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(
    panel.getByTestId('chat-message').filter({ hasText: 'I read the five open risks.' }),
  ).toBeVisible({ timeout: 10_000 });

  // One row, not five cards.
  const group = panel.getByTestId('action-group');
  await expect(group).toHaveCount(1);
  await expect(group).toHaveAttribute('data-count', '5');
  await expect(group.getByTestId('action-group-toggle')).toContainText('Read 5 notes');
  const cards = group.getByTestId('action-card');
  await expect(cards.first()).toBeHidden();

  // Expanded, it is the five cards it folded.
  await group.getByTestId('action-group-toggle').click();
  await expect(cards).toHaveCount(5);
  for (let at = 0; at < 5; at += 1) {
    await expect(cards.nth(at)).toBeVisible();
    await expect(cards.nth(at)).toHaveAttribute('data-tool', 'get_note');
    await expect(cards.nth(at)).toHaveAttribute('data-status', 'done');
  }
});
