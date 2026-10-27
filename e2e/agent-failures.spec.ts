import { test, expect, type Locator, type Page } from '@playwright/test';
import { boot, openAssistantPanel } from './boot';

/**
 * A failed turn reads as a card with its fix (M56.4).
 *
 * The mock's failure scripts (`fail: <name>`, src/agent/mockAgent.ts) emit the
 * notice Rust's classifier gives the matching fixture, held equal to
 * conformance/failure/notices.json by mockAgent.test. What is under test here
 * is the panel's half: the card, its button, and the red box a failure Rust
 * could not type still gets.
 */

async function send(page: Page, message: string) {
  await openAssistantPanel(page);
  const panel = page.getByTestId('ai-panel');
  await expect(panel).toBeVisible();
  await panel.getByLabel('Message the assistant').fill(message);
  await panel.getByRole('button', { name: 'Send' }).click();
  return panel;
}

async function reviewFailure(panel: Locator, failure: Locator, question: string) {
  await expect(panel.getByTestId('chat-message')).toHaveCount(2);
  await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  const inspect = failure.getByRole('button', { name: 'Review what happened', exact: true });
  await inspect.click();
  const review = panel.getByRole('region', { name: 'Review what happened' });
  await expect(review).toBeVisible();
  await expect(review.getByText(question, { exact: true })).toBeVisible();
  await expect(review).toContainText('may be incomplete');
  await expect(panel.getByTestId('chat-message')).toHaveCount(2);
  await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await review.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(inspect).toBeFocused();
  await expect(failure).toBeVisible();
  await expect(panel.getByTestId('chat-message')).toHaveCount(2);
}

test("agent failures: not signed in opens Settings at Claude Code's row", async ({ page }) => {
  await boot(page);
  const panel = await send(page, 'fail: not-signed-in');

  const card = panel.getByRole('group', { name: "Claude Code isn't signed in" });
  await expect(card).toBeVisible();
  await expect(card).toContainText('type /login');
  await expect(card).toContainText('Reported by Claude Code 2.1.250');

  await card.getByRole('button', { name: 'Open Settings' }).click();
  await expect(page.getByTestId('settings-page')).toBeVisible();
  const row = page.getByTestId('settings-claude-code');
  await expect(row).toBeInViewport();
  await expect(row).toContainText('type /login');
});

test('agent failures: a usage limit names when it resets', async ({ page }) => {
  await boot(page);
  const panel = await send(page, 'fail: usage-limit');

  const card = panel.getByTestId('failure-notice');
  await expect(card).toHaveAccessibleName("You've reached your Claude usage limit");
  await expect(card).toContainText('your weekly limit is used up');
  // playwright.config.ts pins the browser to UTC.
  await expect(card.getByTestId('failure-notice-reset')).toHaveText(
    /^Resets Thu, Jan 1(?:,| at) 12:00 AM$/,
  );
  // What Claude Code said is one click away.
  await card.getByText('What Claude Code said').click();
  await expect(card.getByTestId('failure-notice-raw')).toContainText(
    "You've hit your weekly limit",
  );
  await reviewFailure(panel, card, 'fail: usage-limit');
});

test('agent failures: a failure Rust cannot type keeps the red box and its words', async ({
  page,
}) => {
  await boot(page);
  const panel = await send(page, 'fail: unknown');

  const reply = panel
    .getByTestId('chat-message')
    .filter({ hasText: 'API Error: 400 the request was not one Claude could take' });
  await expect(reply).toBeVisible();
  await expect(panel.getByTestId('failure-notice')).toHaveCount(0);
  await reviewFailure(panel, reply, 'fail: unknown');
});
