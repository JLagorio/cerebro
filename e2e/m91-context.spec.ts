import { expect, test } from '@playwright/test';
import { askAssistant, assistantSettled, boot, openAssistantPanel } from './boot';

/**
 * Context use (M91.15): the composer's Context element reads how full the
 * conversation's context is, pulled from `agent_context_usage` when a turn
 * ends (M91.5). Its name is the reading itself: not recorded before the
 * conversation has a session, a share of the window once a turn reported
 * one, and unavailable when the read fails — never not recorded, and never
 * a figure (CV-05). The browser's book files a reading at each mock turn's
 * end; `__cerebroFailNext` fails the next read.
 */

test('context: not recorded before a turn, a share of the window after one, unavailable when the read fails', async ({
  page,
}) => {
  await boot(page);
  await openAssistantPanel(page);
  const panel = page.getByTestId('ai-panel');
  const reading = panel.getByTestId('context-use');

  // A conversation with no session has nothing to read: words, no figure.
  await expect(reading).toHaveAttribute('aria-label', 'Context use not recorded');
  await expect(reading).toHaveAttribute('data-state', 'not_recorded');
  await expect(reading).toHaveText('');
  // It sits in the composer's toolbar, beside Model and effort.
  const tools = panel.getByTestId('run-options').locator('xpath=..');
  await expect(tools.getByTestId('context-use')).toBeVisible();

  // A turn ends: the share of the window, its figure beside the ring, and
  // the detail on hover, which describes it while it is open.
  await askAssistant(page, 'hello');
  await assistantSettled(page, 1);
  await expect(reading).toHaveAttribute('aria-label', /^\d+% of context used$/);
  await expect(reading).toHaveAttribute('data-state', 'recorded');
  await expect(reading).toHaveText(/^\d+%$/);
  await reading.hover();
  const card = page.getByRole('group', { name: 'Context use', exact: true });
  await expect(card).toContainText(/of 200,000 tokens/);
  await expect(card).toContainText('mock-default');
  await expect(reading).toHaveAttribute('aria-describedby', (await card.getAttribute('id')) ?? '');
  await page.mouse.move(0, 0);
  await expect(card).toHaveCount(0);

  // The next turn's read fails: unavailable, its ring marked as a failed read.
  await page.evaluate(() => window.__cerebroFailNext('agent_context_usage'));
  await askAssistant(page, 'hello again');
  await assistantSettled(page, 2);
  await expect(reading).toHaveAttribute('aria-label', 'Context use unavailable');
  await expect(reading).toHaveAttribute('data-state', 'unavailable');
  await expect(reading).toHaveText('');
  await expect(reading.getByTestId('section-unavailable')).toHaveCount(1);

  // The read after it reads again.
  await askAssistant(page, 'and once more');
  await assistantSettled(page, 3);
  await expect(reading).toHaveAttribute('aria-label', /^\d+% of context used$/);
  await expect(reading.getByTestId('section-unavailable')).toHaveCount(0);
});
