import { expect, test, type Page } from '@playwright/test';
import { boot } from './boot';

/**
 * The agent asks the person questions mid-turn (M57.3). In the browser the
 * mock agent's `ask me which format` calls AskUserQuestion with two
 * questions, a single-select "Which format?" (Markdown, Plain text) and a
 * multi-select "Which sections?" (Summary, Risks, Next steps); the mock book
 * (src/agent/mockInteractions.ts) checks the answers by the rules Rust's
 * does, and the resume reads them back to the model as Claude Code does.
 * `ask me "<question>"` offers no options, so no card can show it.
 */

async function openPanel(page: Page) {
  await boot(page);
  await page.getByTestId('sidebar').getByRole('button', { name: 'Assistant' }).click();
  const panel = page.getByTestId('ai-panel');
  await expect(panel).toBeVisible();
  return panel;
}

async function send(page: Page, text: string) {
  const panel = page.getByTestId('ai-panel');
  await panel.getByLabel('Message the assistant').fill(text);
  await panel.getByRole('button', { name: 'Send' }).click();
}

async function askWhichFormat(page: Page) {
  const panel = await openPanel(page);
  await send(page, 'ask me which format');
  const card = panel.getByTestId('question-card');
  await expect(card).toBeVisible({ timeout: 10_000 });
  return { panel, card };
}

const option = (page: Page, n: number, label: string) =>
  page
    .getByTestId('question-card')
    .getByTestId(`question-${n}`)
    .locator(`[data-testid="question-option"][data-label="${label}"]`);

/** The AskUserQuestion row's output, opened. */
async function rowOutput(page: Page) {
  const row = page.getByTestId('ai-panel').getByTestId('action-card').last();
  await row.getByRole('button').first().click();
  return row.getByTestId('action-output');
}

test('agent questions: the card returns the chosen labels, and the reply goes on in the same bubble', async ({
  page,
}) => {
  const { panel, card } = await askWhichFormat(page);
  await expect(card).toContainText('A question for you');
  await expect(card.getByTestId('question-1')).toContainText('Which format?');
  await expect(card.getByTestId('question-2')).toContainText('Which sections?');
  await expect(option(page, 1, 'Markdown')).toHaveAttribute('type', 'radio');
  await expect(option(page, 2, 'Summary')).toHaveAttribute('type', 'checkbox');
  await expect(panel.getByTestId('composer-status')).toHaveText('Waiting for your answer');

  await option(page, 1, 'Markdown').check();
  await option(page, 2, 'Summary').check();
  await option(page, 2, 'Risks').check();
  await card.getByTestId('question-send').click();
  await expect(card).toBeHidden();

  await expect(
    panel.getByTestId('chat-message').filter({ hasText: 'Got it: Markdown; Summary, Risks.' }),
  ).toHaveCount(1, { timeout: 10_000 });
  await expect(panel.locator('[data-testid="chat-message"][data-role="assistant"]')).toHaveCount(1);
  const output = await rowOutput(page);
  await expect(output).toContainText('"Which format?"="Markdown"');
  await expect(output).toContainText('"Which sections?"="Summary, Risks"');
});

test('agent questions: Other sends the typed text', async ({ page }) => {
  const { panel, card } = await askWhichFormat(page);
  const first = card.getByTestId('question-1');
  await expect(first.getByTestId('question-other-text')).toBeDisabled();
  await first.getByTestId('question-other').check();
  await first.getByTestId('question-other-text').fill('HTML');
  await option(page, 2, 'Next steps').check();
  await card.getByTestId('question-send').click();
  await expect(card).toBeHidden();
  await expect(
    panel.getByTestId('chat-message').filter({ hasText: 'Got it: HTML; Next steps.' }),
  ).toHaveCount(1, { timeout: 10_000 });
  await expect(await rowOutput(page)).toContainText('"Which format?"="HTML"');
});

test('agent questions: Send answers waits until every question has one', async ({ page }) => {
  const { card } = await askWhichFormat(page);
  const sendAnswers = card.getByTestId('question-send');
  await expect(sendAnswers).toBeDisabled();
  await option(page, 1, 'Plain text').check();
  await expect(sendAnswers).toBeDisabled();
  await expect(card.getByTestId('question-2').getByTestId('question-problem')).toHaveText(
    'Pick at least one',
  );
  await card.getByTestId('question-2').getByTestId('question-other').check();
  await expect(card.getByTestId('question-2').getByTestId('question-problem')).toHaveText(
    'Type your answer or pick an option',
  );
  await expect(sendAnswers).toBeDisabled();
  await option(page, 2, 'Risks').check();
  await card.getByTestId('question-2').getByTestId('question-other').uncheck();
  await expect(sendAnswers).toBeEnabled();
});

test('agent questions: Don’t answer declines, and the reply says it went ahead', async ({
  page,
}) => {
  const { panel, card } = await askWhichFormat(page);
  await card.getByTestId('question-decline-message').fill('your call');
  await card.getByTestId('question-decline').click();
  await expect(card).toBeHidden();
  await expect(panel.getByTestId('chat-message').filter({ hasText: 'went ahead' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(await rowOutput(page)).toContainText(
    'The person chose not to answer, so decide yourself and say what you assumed. They said: your call',
  );
});

test('agent questions: Stop with a question open removes the card, and the next send works', async ({
  page,
}) => {
  const { panel, card } = await askWhichFormat(page);
  await panel.getByRole('button', { name: 'Stop' }).click();
  await expect(card).toBeHidden();
  const row = panel.getByTestId('action-card').last();
  await expect(row).toHaveAttribute('data-status', 'cancelled');

  await send(page, 'read five notes');
  await expect(
    panel.getByTestId('chat-message').filter({ hasText: 'I read the five open risks.' }),
  ).toBeVisible({ timeout: 10_000 });
});

test('agent questions: a set no card can show is refused, and the agent hears why', async ({
  page,
}) => {
  const panel = await openPanel(page);
  await send(page, 'ask me "Which release?"');
  await expect(
    panel.getByTestId('chat-message').filter({ hasText: "Cerebro couldn't show this question" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByTestId('question-card')).toHaveCount(0);
  await expect(panel.getByTestId('interaction-card')).toHaveCount(0);
});
