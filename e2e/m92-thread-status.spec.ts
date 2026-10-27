import { expect, test, type Page } from '@playwright/test';
import {
  askAssistant,
  boot,
  holdClock,
  openAssistantCanvas,
  releaseHeldTurns,
  stepUntil,
  stepUntilSettled,
} from './boot';

/**
 * A conversation's status and its turn's lines (M92.2, M92.7). The list
 * marks a thread whose turn works or waits on the person, in the list only
 * (Q7), and clears the mark when its run ends, the open thread's from its
 * own turn and a thread left mid-turn from its run (CV-30). Under the reply
 * at work, a line says how long it has worked on the run's own clock, which
 * a held page clock steps; while a card waits it says so with no figure,
 * and the settled turn's chain says how long Claude Code counted it worked.
 */

const conversations = (page: Page) => page.getByRole('navigation', { name: 'Conversations' });
const threadRow = (page: Page, title: string) =>
  conversations(page).getByTestId('conversation-row').filter({ hasText: title });

/** Let the held turn go on a held clock, where it has long reached its
 *  hold: the clock steps it from there. */
async function releaseHeldRuns(page: Page) {
  await page.evaluate(() =>
    (window as unknown as { __cerebroReleaseMockRuns: () => void }).__cerebroReleaseMockRuns(),
  );
}

test('a thread left mid-turn shows Working in the list, and clears when its run ends', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  const panel = await openAssistantCanvas(page);
  // A turn that holds mid-tool until it is let go.
  await askAssistant(page, 'wait for me');
  await expect(panel.getByTestId('action-card').first()).toBeVisible();

  // The open thread's chip comes from its own turn, inside the row's button,
  // so the button's name says it.
  const held = threadRow(page, 'wait for me');
  await expect(held).toHaveAttribute('data-thread-status', 'working');
  await expect(held.getByTestId('thread-status')).toHaveAttribute('data-status', 'working');
  await expect(held.getByTestId('thread-status')).toHaveText('Working');
  await expect(held.getByRole('button', { name: /wait for me.*Working/ })).toBeVisible();

  // Another conversation: the turn goes on, detached, and the list still
  // says so from its run.
  await conversations(page).getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(panel.getByTestId('chat-welcome')).toBeVisible();
  await expect(held.locator('button[aria-current="true"]')).toHaveCount(0);
  await expect(held.getByTestId('thread-status')).toHaveAttribute('data-status', 'working');
  await expect(held.getByTestId('thread-status')).toHaveText('Working');
  await expect(conversations(page).getByTestId('section-unavailable')).toHaveCount(0);

  // Its run ends with nobody watching: the chip goes, and nothing says
  // Working in its place.
  await releaseHeldTurns(page, async () => (await held.getByTestId('thread-status').count()) === 0);
  await expect(held.getByTestId('thread-status')).toHaveCount(0);
  await expect(held).not.toHaveAttribute('data-thread-status', 'working');
  await expect(conversations(page).getByTestId('thread-status')).toHaveCount(0);
});

test('the turn’s line ticks on a held clock, waits in words while a card waits, and the settled turn says how long it worked', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  const panel = await openAssistantCanvas(page);
  await holdClock(page);
  const replies = panel.locator('[data-testid="chat-message"][data-role="assistant"]');

  // A held turn: under a second it is working with no figure, then each
  // whole second of the run's own clock.
  await askAssistant(page, 'wait for me');
  const working = replies.first().getByTestId('turn-working');
  await stepUntil(page, () => working.isVisible(), 'the working line');
  await expect(working).toHaveText('Working…');
  await expect(working).toHaveAttribute('aria-hidden', 'true');
  await page.clock.runFor(1_000);
  await expect(working).toHaveText('Working for 1s');
  await page.clock.runFor(1_000);
  await expect(working).toHaveText('Working for 2s');
  await releaseHeldRuns(page);
  await stepUntilSettled(page, 1);
  await expect(replies.first().getByTestId('turn-working')).toHaveCount(0);
  // Its runs reported no time (an unstamped script), so it claims none.
  await expect(replies.first()).not.toContainText('Worked for');

  // A call that waits on the person: the line says so, with no figure,
  // however long the wait.
  await page.evaluate(() => {
    (window as unknown as { __cerebroMockAsk: string[] }).__cerebroMockAsk = ['append_to_note'];
  });
  await askAssistant(page, 'append "- call the vendor" to delivery/how-we-schedule.md');
  const card = panel.getByTestId('interaction-card');
  await stepUntil(page, () => card.isVisible(), 'the waiting card');
  const waiting = replies.nth(1).getByTestId('turn-working');
  await expect(waiting).toHaveText('Waiting for your answer');
  await page.clock.runFor(2_000);
  await expect(waiting).toHaveText('Waiting for your answer');
  await card.getByTestId('interaction-allow').click();
  await stepUntilSettled(page, 2);
  await expect(card).toBeHidden();
  await expect(replies.nth(1).getByTestId('turn-working')).toHaveCount(0);

  // A turn whose run reported how long it worked: its chain says so once it
  // has settled, never while it runs.
  await askAssistant(page, 'think it through: which risk should I escalate?');
  const chain = replies.nth(2).getByTestId('turn-chain');
  await stepUntil(page, () => chain.isVisible(), 'the chain of thought');
  await expect(chain).not.toContainText('Worked for');
  await stepUntilSettled(page, 3);
  await expect(
    chain.getByRole('button', { name: /^Worked for \d+(\.\d)?s · \d+ steps$/ }),
  ).toBeVisible();
});
