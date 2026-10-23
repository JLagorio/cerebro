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
 * Research with subagents (M91.15): the mock's `research … with subagents`
 * script plays what Rust's fold sends for two cerebro-researcher subagents,
 * each under the Agent call that started it (M91.3b, M91.4). On a held clock
 * the turn stops while the first researcher works, so its running words, what
 * it is doing now and its own step are read where they stand; then it
 * reports. No subagent's tokens reach the page or the saved thread (Q7).
 */

test('research with subagents: a researcher works under its call, says its state in words, and reports without a token count', async ({
  page,
}) => {
  await boot(page);
  await openAssistantPanel(page);
  const panel = page.getByTestId('ai-panel');
  await holdClock(page);
  await askAssistant(page, 'research the open risks with subagents');

  // At work: the line says so in words, what it is doing now sits under it,
  // and its own first step runs inside it, drawn there once and nowhere else.
  const working = panel.locator('[data-slot="subagent"][data-status="running"]');
  const search = working.locator(
    '[data-testid="action-card"][data-tool="mcp__cerebro__search_notes"]',
  );
  await stepUntil(page, () => search.isVisible(), 'the researcher’s first step');
  await expect(working).toHaveCount(1);
  await expect(
    working.getByRole('button', {
      name: /^Running: Read the open risks by the cerebro-researcher /,
    }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(working.locator('[data-slot="step-progress"]')).toHaveText(
    'Searching for open risks',
  );
  await expect(search).toHaveAttribute('data-status', 'running');
  const reply = panel.locator('[data-testid="chat-message"][data-role="assistant"]');
  await expect(
    reply.locator('[data-testid="action-card"][data-tool="mcp__cerebro__search_notes"]'),
  ).toHaveCount(1);

  await stepUntilSettled(page, 1);

  // Done: each researcher folds to its line, which says what it was asked,
  // its kind, its tool uses and time, and never its tokens.
  const researchers = reply.locator('[data-slot="subagent"]');
  await expect(researchers).toHaveCount(2);
  await expect(researchers.nth(0)).toHaveAttribute('data-status', 'done');
  await expect(researchers.nth(1)).toHaveAttribute('data-status', 'done');
  const first = researchers.nth(0).getByRole('button', {
    name: /^Done: Read the open risks by the cerebro-researcher 2 tool uses · /,
  });
  await expect(first).toHaveAttribute('aria-expanded', 'false');
  await expect(
    researchers.nth(1).getByRole('button', {
      name: /^Done: Read the rollout plan by the cerebro-researcher 1 tool use · /,
    }),
  ).toBeVisible();

  // Opened: its own steps, drawn as the turn's are — its reasoning, its two
  // reads folded into one row — then the model that answered and its report.
  await first.click();
  const opened = researchers.nth(0);
  await expect(opened.getByRole('button', { name: 'Thought for under a second' })).toBeVisible();
  const reads = opened.getByTestId('action-group');
  await expect(reads).toHaveAttribute('data-count', '2');
  await reads.getByTestId('action-group-toggle').click();
  await expect(
    opened.locator('[data-testid="action-card"][data-tool="mcp__cerebro__get_note"]'),
  ).toHaveAttribute('data-status', 'done');
  await expect(opened.locator('[data-slot="subagent-model"]')).toHaveText('Model: mock-default');
  await expect(opened.locator('[data-slot="subagent-result"]')).toHaveText(
    'Scanner delivery threatens the launch most: it has a date and no recorded mitigation.',
  );
  await expect(reply).toContainText('Two researchers looked.');

  // No token count anywhere: not in the panel, folded or not, and not in
  // the thread as it was saved.
  expect(await panel.textContent()).not.toMatch(/\btokens?\b/i);
  const saved = await page.evaluate(() => localStorage.getItem('cerebro.conversations') ?? '');
  expect(saved).toContain('Read the open risks');
  expect(saved).not.toMatch(/token/i);
});
