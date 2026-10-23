import { expect, test, type Page } from '@playwright/test';
import {
  askAssistant,
  assistantSettled,
  boot,
  holdClock,
  openAssistantPanel,
  stepUntil,
  stepUntilSettled,
} from './boot';

/**
 * Reasoning (M91.15): the model's thinking is a Reasoning line in the turn's
 * chain of thought, "Thinking" and open while its words arrive, then
 * "Thought". How long it took is said only when both its times were
 * recorded (CV-05): the mock's `think it through` script stamps its lines as
 * Claude Code does, and a reply whose lines carry no times says no duration.
 */

const reply = (page: Page) =>
  page.getByTestId('ai-panel').locator('[data-testid="chat-message"][data-role="assistant"]');

test('think it through: reasoning streams open as Thinking, then reads Thought, timed only from recorded times', async ({
  page,
}) => {
  await boot(page);
  await openAssistantPanel(page);
  await holdClock(page);
  await askAssistant(page, 'think it through: which risk should I escalate?');

  // While its words arrive: open, with the words so far.
  const thinking = reply(page).locator('[data-slot="reasoning"][data-status="running"]');
  await stepUntil(page, () => thinking.isVisible(), 'the first reasoning');
  await expect(thinking.getByRole('button', { name: 'Thinking', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await stepUntil(
    page,
    async () => ((await thinking.textContent()) ?? '').includes('The person wants'),
    'the reasoning’s first words',
  );

  await stepUntilSettled(page, 1);

  // Done: the chain's header says how long the run worked, from its stamped
  // result (M92.2). In the chain, the first block reads "Thought" (nothing
  // recorded when it began), the answer's "Thought for under a second" (from
  // the call before it); each opens onto its words.
  const chain = reply(page).getByTestId('turn-chain');
  await expect(
    chain.getByRole('button', { name: 'Worked for 2.6s · 3 steps', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(chain.locator('[data-slot="reasoning"]')).toHaveCount(2);
  await expect(chain.locator('[data-slot="reasoning"][data-status="running"]')).toHaveCount(0);
  const first = chain.getByRole('button', { name: 'Thought', exact: true });
  const timed = chain.getByRole('button', { name: 'Thought for under a second', exact: true });
  await expect(first).toHaveAttribute('aria-expanded', 'false');
  await timed.click();
  await expect(timed).toHaveAttribute('aria-expanded', 'true');
  await expect(chain).toContainText(
    'It has a date, nothing mitigates it, and the launch depends on it.',
  );
  await expect(reply(page)).toContainText('Having thought it through: escalate');
  await expect(reply(page)).not.toContainText(/Thought for 0/);
});

test('reasoning whose lines carry no times says no duration', async ({ page }) => {
  await boot(page);
  await openAssistantPanel(page);
  await askAssistant(page, 'hello');
  await assistantSettled(page, 1);

  const reasoning = reply(page).locator('[data-slot="reasoning"]');
  await expect(reasoning).toHaveCount(1);
  await expect(reasoning.getByRole('button', { name: 'Thought', exact: true })).toBeVisible();
  await expect(reply(page)).not.toContainText('Thought for');
});
