import { expect, test, type Page } from '@playwright/test';
import { boot } from './boot';

/**
 * A turn outlives its panel (M57.6). Closing the assistant, switching
 * threads or starting a new one detaches a running turn; reopening re-attaches
 * through the run's journal, from the cursor its reply carries, so each event
 * shows once. The mock agent's `wait for me` script holds mid-tool until
 * `window.__cerebroReleaseMockRuns()` lets it go.
 */

const panel = (page: Page) => page.getByTestId('ai-panel');
const assistants = (page: Page) =>
  panel(page).locator('[data-testid="chat-message"][data-role="assistant"]');
const users = (page: Page) => panel(page).locator('[data-testid="chat-message"][data-role="user"]');

async function openPanel(page: Page) {
  await page.getByTestId('sidebar').getByRole('button', { name: 'Assistant' }).click();
  await expect(panel(page)).toBeVisible();
}

async function closePanel(page: Page) {
  await panel(page).getByRole('button', { name: 'Close AI panel' }).click();
  await expect(panel(page)).toHaveCount(0);
}

async function enter(page: Page, text: string) {
  const composer = panel(page).getByLabel('Message the assistant');
  await composer.fill(text);
  await composer.press('Enter');
}

/** Start the held turn and wait until it is mid-tool. */
async function holdATurn(page: Page) {
  await enter(page, 'wait for me');
  await expect(panel(page).getByTestId('action-card').first()).toBeVisible({ timeout: 10_000 });
}

async function release(page: Page) {
  await page.evaluate(() =>
    (window as unknown as { __cerebroReleaseMockRuns: () => void }).__cerebroReleaseMockRuns(),
  );
}

/** Open the conversation switcher and pick the thread titled `title`. */
async function openThread(page: Page, title: string) {
  await panel(page).getByTestId('conversation-switcher').click();
  await page.getByTestId('conversation-row').filter({ hasText: title }).first().click();
}

async function newConversation(page: Page) {
  await panel(page).getByLabel('New conversation', { exact: true }).click();
}

/** The status bar says nothing is running: idle, or quiet altogether. */
async function expectIdle(page: Page) {
  await expect(page.getByTestId('status-agent').filter({ hasText: /working|running/ })).toHaveCount(
    0,
    { timeout: 10_000 },
  );
}

/** The one reply reads exactly the script's answer, once. */
async function expectOneReply(page: Page) {
  await expect(users(page)).toHaveCount(1);
  await expect(users(page).first()).toContainText('wait for me');
  await expect(assistants(page)).toHaveCount(1);
  await expect(assistants(page).first()).toContainText('Done waiting.', { timeout: 10_000 });
  const text = await assistants(page).first().innerText();
  expect(text.split('Done waiting.')).toHaveLength(2);
  await expect(assistants(page).first().getByTestId('action-card')).toHaveCount(1);
}

test('agent: closing the panel mid-turn and reopening it re-attaches without duplicate rows', async ({
  page,
}) => {
  await boot(page);
  await openPanel(page);
  await holdATurn(page);

  await closePanel(page);
  // The run goes on with nobody watching, and ends.
  await expect(page.getByTestId('status-agent')).toHaveText('Assistant working');
  await release(page);
  await expectIdle(page);

  await openPanel(page);
  await expectOneReply(page);
});

test('agent: a thread switch mid-turn keeps the turn running', async ({ page }) => {
  await boot(page);
  await openPanel(page);
  await holdATurn(page);

  await newConversation(page);
  await expect(users(page)).toHaveCount(0);
  await expect(page.getByTestId('status-agent')).toHaveText('Assistant working');

  await openThread(page, 'wait for me');
  await expect(panel(page).getByTestId('action-card')).toHaveCount(1);
  await release(page);
  await expectOneReply(page);
  await expectIdle(page);
});

test('agent: the composer draft survives closing the panel, per thread', async ({ page }) => {
  await boot(page);
  await openPanel(page);
  await enter(page, 'What is at risk right now?');
  await expect(assistants(page).first()).toContainText('Two risks are open', { timeout: 10_000 });
  const composer = panel(page).getByLabel('Message the assistant');
  await composer.fill('half a thought for the risks thread');

  await closePanel(page);
  await openPanel(page);
  await expect(panel(page).getByLabel('Message the assistant')).toHaveValue(
    'half a thought for the risks thread',
  );

  await newConversation(page);
  await expect(panel(page).getByLabel('Message the assistant')).toHaveValue('');
  await panel(page).getByLabel('Message the assistant').fill('another thread, another draft');

  await openThread(page, 'What is at risk right now?');
  await expect(panel(page).getByLabel('Message the assistant')).toHaveValue(
    'half a thought for the risks thread',
  );
});

test('agent: the run list opens the thread a detached run belongs to', async ({ page }) => {
  await boot(page);
  await openPanel(page);
  await holdATurn(page);
  await newConversation(page);
  await closePanel(page);

  await page.getByTestId('status-agent').click();
  await page
    .getByTestId('run-row')
    .filter({ hasText: 'wait for me' })
    .getByRole('button')
    .first()
    .click();
  await expect(panel(page)).toBeVisible();
  await expect(users(page).first()).toContainText('wait for me');
  await expect(panel(page).getByTestId('action-card')).toHaveCount(1);
  await release(page);
  await expectOneReply(page);
});

test('agent: a card left open across a close still waits, and Allow ends the turn in one reply', async ({
  page,
}) => {
  const PAGE = 'delivery/how-we-schedule.md';
  const BODY = ['# How we schedule', '', 'We ship on Thursdays, after the freeze.', ''].join('\n');
  await boot(page);
  await page.evaluate(([path, md]) => window.__cerebroMockFs.set(path, md), [PAGE, BODY]);
  await page.evaluate(() => {
    (window as unknown as { __cerebroMockAsk?: string[] }).__cerebroMockAsk = ['append_to_note'];
  });
  await openPanel(page);
  await enter(page, `append "- call the vendor" to ${PAGE}`);
  await expect(panel(page).getByTestId('interaction-card')).toBeVisible({ timeout: 10_000 });

  await closePanel(page);
  await openPanel(page);
  const card = panel(page).getByTestId('interaction-card');
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.getByTestId('interaction-allow').click();
  await expect(card).toBeHidden();
  await expect(
    panel(page)
      .getByTestId('chat-message')
      .filter({ hasText: `I appended that to ${PAGE}.` }),
  ).toHaveCount(1, { timeout: 10_000 });
  await expect(assistants(page)).toHaveCount(1);
});
