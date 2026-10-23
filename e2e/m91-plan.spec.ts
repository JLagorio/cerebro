import { expect, test } from '@playwright/test';
import {
  askAssistant,
  boot,
  holdClock,
  openAssistantPanel,
  stepUntil,
  stepUntilSettled,
} from './boot';

/**
 * The plan (M91.15, Q9): the mock's `make a todo list` script writes its
 * todo list with TodoWrite four times as it works through it. Each write is a
 * Plan in the turn; while the turn works, the dock over the composer follows
 * the latest list, the step under way in the agent's own words, and what is
 * sent meanwhile waits beneath it in Up next, a Queue. On a held clock the
 * turn stops between its steps, so each state is read where it stands.
 */

test('make a todo list: the dock follows the plan while the turn works, Up next waits beneath it, and the turn keeps its Plan', async ({
  page,
}) => {
  await boot(page);
  await openAssistantPanel(page);
  const panel = page.getByTestId('ai-panel');
  await holdClock(page);
  await askAssistant(page, 'make a todo list of the open risks');

  // Working: the dock's plan, the step under way in the agent's words.
  const dock = panel.getByRole('region', { name: 'Plan', exact: true });
  await stepUntil(page, () => dock.isVisible(), 'the dock’s plan');
  await expect(dock).toHaveAttribute('data-testid', 'live-plan');
  await expect(dock).toHaveAttribute('data-slot', 'queue');
  const doing = dock.locator('[data-slot="queue-item"]');
  await expect(doing).toHaveText([
    'In progress: Listing the open risks',
    'To do: Read the dated risks',
    'To do: Name the risk to escalate',
  ]);
  await expect(dock.getByRole('button', { name: '3 to do', exact: true })).toBeVisible();

  // …and the turn's own Plan, at work with it.
  const reply = panel.locator('[data-testid="chat-message"][data-role="assistant"]').first();
  await expect(
    reply.getByRole('button', { name: 'In progress: Plan 0 of 3 done', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');

  // Sent while it works: it waits in Up next, under the plan.
  await askAssistant(page, 'What is at risk right now?');
  const upNext = panel.getByRole('region', { name: 'Up next', exact: true });
  await expect(upNext).toHaveAttribute('data-slot', 'queue');
  await expect(upNext.getByTestId('up-next-entry')).toHaveText(/What is at risk right now\?/);
  await expect(panel.getByTestId('composer-status')).toHaveText('Working… · Enter adds to Up next');

  // The plan moves on as the agent writes it again.
  await stepUntil(
    page,
    async () => (await doing.first().textContent()) === 'In progress: Reading the dated risks',
    'the plan’s second step',
  );
  await expect(dock.getByRole('button', { name: '2 to do', exact: true })).toBeVisible();
  await expect(dock.getByRole('button', { name: '1 done', exact: true })).toBeVisible();

  // The turn ends and Up next runs: the dock's plan goes, and the reply
  // keeps each Plan its writes left, the last one all done.
  await stepUntilSettled(page, 2);
  await expect(panel.getByTestId('live-plan')).toHaveCount(0);
  await expect(panel.getByTestId('up-next')).toHaveCount(0);
  const plans = reply.locator('[data-slot="plan"]');
  await expect(plans).toHaveCount(4);
  const last = reply.getByRole('button', { name: 'Plan 3 of 3 done', exact: true });
  await expect(last).toHaveAttribute('aria-expanded', 'false');
  await last.click();
  await expect(
    plans.last().locator('[data-slot="plan-steps"] [data-slot="trace-line"]'),
  ).toHaveText([
    'Done: List the open risks',
    'Done: Read the dated risks',
    'Done: Name the risk to escalate',
  ]);
  await expect(reply).toContainText('All three done');
  await expect(
    panel.locator('[data-testid="chat-message"][data-role="assistant"]').nth(1),
  ).toContainText('Two risks are open.');
});

test('make a todo list: the dock keeps the plan while the turn waits on the person, without the working light', async ({
  page,
}) => {
  await boot(page);
  // The mock gate asks before the script's get_note, so the turn waits on a
  // card with its plan half done: a deferral's Done ends the bubble's stream
  // while the turn stays in flight.
  await page.evaluate(() => {
    (window as unknown as { __cerebroMockAsk?: string[] }).__cerebroMockAsk = ['get_note'];
  });
  await openAssistantPanel(page);
  const panel = page.getByTestId('ai-panel');
  await askAssistant(page, 'make a todo list of the open risks');

  const card = panel.getByTestId('interaction-card');
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByTestId('composer-status')).toHaveText('Waiting for your answer');
  const dock = panel.getByTestId('live-plan');
  await expect(dock).toBeVisible();
  await expect(dock.locator('[data-section="todo"] [data-slot="queue-item"]')).toHaveText([
    'In progress: Read the dated risks',
    'To do: Name the risk to escalate',
  ]);
  await expect(dock.getByRole('button', { name: '1 done', exact: true })).toBeVisible();
  // Waiting on the person: the step under way carries no working light.
  await expect(dock.locator('[data-slot="trace-line"][data-status="running"]')).toHaveCount(0);
});
