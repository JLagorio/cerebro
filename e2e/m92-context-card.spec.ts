import { expect, test, type Locator } from '@playwright/test';
import {
  askAssistant,
  assistantSettled,
  boot,
  contextReadingsWithoutBreakdown,
  openAssistantCanvas,
  releaseHeldTurns,
} from './boot';

/**
 * The rail's Context card (M92.14): the composer ring's own pull of the
 * conversation's context, read into the card. Before any turn there is no
 * session to read; after one, the reading Claude Code's breakdown came with
 * (the mock files one as Rust's meter keeps it) shows each category with its
 * tokens and its share of the window; while the next turn streams, the card
 * says the reading is the previous turn's; and a reading with no breakdown
 * is the count alone, saying why (CV-05).
 */

const rail = (panel: Locator) =>
  panel.getByRole('region', { name: 'Conversation details', exact: true });

test('the Context card reads no turn, then the breakdown, then the previous turn’s, then the count alone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  const panel = await openAssistantCanvas(page);

  // A fresh conversation welcomes, and the rail waits for the person to
  // open it: then Context has no turn to read.
  await panel.getByRole('button', { name: 'Conversation details', exact: true }).click();
  const context = rail(panel).getByTestId('rail-context');
  await expect(context).toHaveAttribute('data-state', 'empty');
  await expect(context).toContainText('No turns yet');
  await expect(context.getByTestId('rail-context-categories')).toHaveCount(0);

  // A turn files its session's reading, with Claude Code's breakdown: each
  // category with its tokens and its share of the window, a deferred row
  // not loaded, and the ring's own figure.
  await askAssistant(page, 'What is at risk right now?');
  await assistantSettled(page, 1);
  await expect(context).toHaveAttribute('data-state', 'ready');
  const categories = context.getByTestId('rail-context-categories');
  await expect(categories).toBeVisible();
  const rows = categories.locator('.cb-ai-context-legend-row');
  const share = /^\d+(\.\d)?K? · (\d+\.\d|<0\.1)%$/;
  for (const name of ['System prompt', 'System tools', 'Messages', 'Free space']) {
    const row = rows.filter({ hasText: name });
    await expect(row).toHaveCount(1);
    await expect(row.locator('dd')).toHaveText(share);
  }
  await expect(rows.filter({ hasText: 'MCP tools (deferred)' }).locator('dd')).toHaveText(
    'not loaded',
  );
  await expect(categories.locator('[data-slot="context-bar"]')).toBeAttached();
  const ring = await panel.getByTestId('context-use').textContent();
  await expect(context).toContainText(`${ring} used`);
  await expect(context.getByTestId('rail-context-figure')).toHaveText(/^[\d,]+ of 200,000 tokens$/);
  const freshness = context.getByTestId('rail-context-freshness');
  await expect(freshness).toContainText('Read when the last turn ended');

  // While the next turn streams, the reading is the last turn's, and says so.
  // The turn holds mid-tool until it is let go.
  await askAssistant(page, 'wait for me');
  const replies = panel.locator('[data-testid="chat-message"][data-role="assistant"]');
  await expect(replies.nth(1).getByTestId('action-card')).toBeVisible();
  await expect(freshness).toContainText('From the previous turn');
  await expect(context).toHaveAttribute('data-state', 'ready');
  await expect(categories).toBeVisible();
  await releaseHeldTurns(page, async () =>
    ((await replies.nth(1).textContent()) ?? '').includes('Done waiting.'),
  );
  await assistantSettled(page, 2);
  await expect(freshness).toContainText('Read when the last turn ended');

  // A reading with no breakdown: the count alone, and the card says why,
  // never a breakdown of nothing.
  await contextReadingsWithoutBreakdown(page);
  await askAssistant(page, 'Which of the risks has a date?');
  await assistantSettled(page, 3);
  await expect(context).toHaveAttribute('data-state', 'partial');
  await expect(context).toContainText('Breakdown not recorded for this turn');
  await expect(context.getByTestId('rail-context-categories')).toHaveCount(0);
  await expect(context.getByTestId('rail-context-figure')).toBeVisible();
  await expect(context).toContainText(
    `${await panel.getByTestId('context-use').textContent()} used`,
  );
});
