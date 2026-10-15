import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile } from './boot';

/**
 * A run can stop and wait for the person (M57.1), against the browser's ask
 * seam (src/agent/mockInteractions.ts): `window.__cerebroMockAsk` names the
 * tools the mock gate asks for, as `CEREBRO_ASK_TOOLS` does in a debug
 * build, and the mock agent's append script holds its `append_to_note` call
 * until the card is answered.
 */

const PAGE = 'delivery/how-we-schedule.md';
const BODY = ['# How we schedule', '', 'We ship on Thursdays, after the freeze.', ''].join('\n');
const ASK = `append "- call the vendor" to ${PAGE}`;

async function openPanel(page: Page) {
  await boot(page);
  await page.evaluate(([path, md]) => window.__cerebroMockFs.set(path, md), [PAGE, BODY]);
  await page.evaluate(() => {
    (window as unknown as { __cerebroMockAsk?: string[] }).__cerebroMockAsk = ['append_to_note'];
  });
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

test('agent: a held call waits on a card; Allow once runs it and the next one asks again', async ({
  page,
}) => {
  const panel = await openPanel(page);
  await send(page, ASK);

  const card = panel.getByTestId('interaction-card');
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText('Waiting for your OK');
  await expect(card.getByTestId('interaction-tool')).toHaveText('append to note');
  await expect(card.getByTestId('interaction-summary')).toContainText(PAGE);
  await expect(panel.getByTestId('composer-status')).toHaveText('Waiting for your answer');
  const row = panel.getByTestId('action-card').filter({ hasText: PAGE });
  await expect(row).toHaveAttribute('data-status', 'waiting');
  // Nothing is written while it waits.
  expect(await readMockFile(page, PAGE)).toBe(BODY);

  await card.getByTestId('interaction-allow').click();
  await expect(card).toBeHidden();
  const replies = panel
    .getByTestId('chat-message')
    .filter({ hasText: `I appended that to ${PAGE}.` });
  await expect(replies).toHaveCount(1, { timeout: 10_000 });
  // The resume went on in the same bubble.
  await expect(panel.locator('[data-testid="chat-message"][data-role="assistant"]')).toHaveCount(1);
  await expect(row).toHaveAttribute('data-status', 'done');
  expect(await readMockFile(page, PAGE)).toContain('- call the vendor');

  // Allow once is once: the same request asks again.
  await send(page, ASK);
  await expect(panel.getByTestId('interaction-card')).toBeVisible({ timeout: 10_000 });
});

test('agent: Deny with a message leaves the note alone and the row says why', async ({ page }) => {
  const panel = await openPanel(page);
  await send(page, ASK);
  const card = panel.getByTestId('interaction-card');
  await expect(card).toBeVisible({ timeout: 10_000 });

  await card.getByTestId('interaction-deny-message').fill('not this week');
  await card.getByTestId('interaction-deny').click();
  await expect(card).toBeHidden();
  await expect(
    panel.getByTestId('chat-message').filter({ hasText: 'you declined it' }),
  ).toBeVisible({ timeout: 10_000 });
  expect(await readMockFile(page, PAGE)).toBe(BODY);

  const row = panel.getByTestId('action-card').filter({ hasText: PAGE });
  await expect(row).toHaveAttribute('data-status', 'failed');
  await row.getByRole('button', { name: new RegExp(PAGE.replace(/[.]/g, '\\.')) }).click();
  await expect(row.getByTestId('action-output')).toContainText('They said: not this week');
});

test('agent: Stop with a card open cancels it, the row reads cancelled, and the next send works', async ({
  page,
}) => {
  const panel = await openPanel(page);
  await send(page, ASK);
  const card = panel.getByTestId('interaction-card');
  await expect(card).toBeVisible({ timeout: 10_000 });

  await panel.getByRole('button', { name: 'Stop' }).click();
  await expect(card).toBeHidden();
  const row = panel.getByTestId('action-card').filter({ hasText: PAGE });
  await expect(row).toHaveAttribute('data-status', 'cancelled');
  await expect(row.getByTestId('action-deferred')).toHaveText('Cancelled: it did not run');
  expect(await readMockFile(page, PAGE)).toBe(BODY);

  await send(page, 'read five notes');
  await expect(
    panel.getByTestId('chat-message').filter({ hasText: 'I read the five open risks.' }),
  ).toBeVisible({ timeout: 10_000 });
});
