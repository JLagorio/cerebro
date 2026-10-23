import { expect, test } from '@playwright/test';
import { askAssistant, assistantSettled, boot, openAssistantPanel } from './boot';

/**
 * Branch from here (M91.15, Q8): between a reply and the turn after it, a
 * Checkpoint starts a new conversation holding the thread up to that reply,
 * whose first send forks Claude Code's session at the line the reply's turn
 * ended on (M91.6). Nothing is rolled back: the marker says the files stay as
 * they are, and branching writes nothing. Only the mock's stamped scripts
 * name that line, so the first turn is `think it through`.
 */

const FIRST = 'think it through: which risk should I escalate?';
const SECOND = 'What is at risk right now?';

test('Branch from here starts a conversation with the turns up to that reply, and leaves the files as they are', async ({
  page,
}) => {
  await boot(page);
  await openAssistantPanel(page);
  const panel = page.getByTestId('ai-panel');
  const messages = panel.getByTestId('chat-message');

  await askAssistant(page, FIRST);
  await assistantSettled(page, 1);
  // After the last reply there is nothing to leave behind: no marker yet.
  await expect(panel.getByTestId('turn-checkpoint')).toHaveCount(0);
  await askAssistant(page, SECOND);
  await assistantSettled(page, 2);
  await expect(messages).toHaveCount(4);

  // One marker, between the first reply and the turn after it, its button
  // named by its words and the turn it follows, described by its note.
  const marker = panel.getByTestId('turn-checkpoint');
  await expect(marker).toHaveCount(1);
  const branch = marker.getByTestId('branch-from-here');
  await expect(branch).toHaveAccessibleName(`Branch from here, after your message “${FIRST}”`);
  await expect(branch).toHaveText('Branch from here');
  await expect(branch).toHaveAccessibleDescription('Files stay as they are');
  await expect(marker).toContainText('Files stay as they are');

  const writes = await page.evaluate(() => window.__cerebroMockWrites.length);
  await branch.click();

  // The new conversation: the first turn only, and the composer ready.
  await expect(messages).toHaveCount(2);
  await expect(messages.nth(0)).toHaveText(FIRST);
  await expect(messages.nth(1)).toContainText('Having thought it through: escalate');
  await expect(panel.getByLabel('Message the assistant')).toBeFocused();
  expect(await page.evaluate(() => window.__cerebroMockWrites.length)).toBe(writes);

  // Both conversations are listed: the branch, holding one turn, is the one
  // open; the conversation it came from still holds two.
  await panel.getByTestId('conversation-switcher').click();
  const rows = panel.getByTestId('conversation-row');
  await expect(rows).toHaveCount(2);
  const open = rows.filter({ has: page.locator('button[aria-current="true"]') });
  await expect(open).toHaveCount(1);
  await expect(open).toContainText('1');
  await expect(open).not.toContainText('2');
  const source = rows.filter({ hasNot: page.locator('button[aria-current="true"]') });
  await expect(source).toContainText('2');
  await panel.getByRole('button', { name: 'Close conversations', exact: true }).click();

  // Its first send goes on from the reply it holds.
  await askAssistant(page, SECOND);
  await assistantSettled(page, 2);
  await expect(messages).toHaveCount(4);
  await expect(messages.nth(3)).toContainText('Two risks are open.');

  // The conversation it came from is as it was.
  await panel.getByTestId('conversation-switcher').click();
  await source.getByRole('button').first().click();
  await expect(messages).toHaveCount(4);
  await expect(messages.nth(2)).toHaveText(SECOND);
  await expect(panel.getByTestId('turn-checkpoint')).toHaveCount(1);
});
