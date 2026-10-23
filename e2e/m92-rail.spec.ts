import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  askAssistant,
  assistantSettled,
  boot,
  holdClock,
  stepUntil,
  stepUntilSettled,
} from './boot';

/**
 * The conversation rail's frame (M92.1): in the canvas, a third grid area of
 * the panel's own aside. It docks beside the transcript where the canvas
 * frame holds 960px (a 1440 window beside the default sidebar), folds away
 * under that and opens as a drawer over the transcript when asked, and a
 * person's word on it outlives a reload. Moving the same conversation
 * between presentations keeps its input, its turn and the rail.
 *
 * Its cards (M92.4–M92.6, M92.17) act in the canvas: a row's first action
 * shows where in the conversation its thing happened, and its open floats
 * the conversation first, so the page it opens is on screen. A docked
 * rail's Plan card holds the plan, and the dock's steps aside.
 */

const RAIL_KEY = 'cerebro.chatRailOpen';

/** Open the assistant and expand it into the canvas, as chat-canvas does. */
async function openCanvas(page: Page): Promise<Locator> {
  await page
    .getByTestId('app-rail')
    .getByRole('button', { name: 'Assistant', exact: true })
    .click();
  const panel = page.getByTestId('ai-panel');
  if ((await panel.getAttribute('data-presentation')) === 'floating') {
    await panel.getByRole('button', { name: 'Conversation options', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Expand conversation', exact: true }).click();
  } else if ((await panel.getAttribute('data-presentation')) !== 'canvas') {
    await panel.getByRole('button', { name: 'Expand conversation', exact: true }).click();
  }
  await expect(panel).toHaveAttribute('data-presentation', 'canvas');
  return panel;
}

/** One finished turn, so the conversation no longer welcomes (Q7). */
async function askOnce(panel: Locator) {
  const input = panel.getByLabel('Message the assistant');
  await input.fill('What is at risk right now?');
  await input.press('Enter');
  await expect(
    panel.getByTestId('chat-message').filter({ hasText: 'Two risks are open' }),
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
}

const rail = (panel: Locator) =>
  panel.getByRole('region', { name: 'Conversation details', exact: true });
const toggle = (panel: Locator) =>
  panel.getByRole('button', { name: 'Conversation details', exact: true });

test('docks beside the transcript at 1440, the header across both', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  const panel = await openCanvas(page);
  // A fresh conversation in the canvas shows no rail: nothing speaks first.
  await expect(rail(panel)).toBeHidden();
  await expect(toggle(panel)).toHaveAttribute('aria-expanded', 'false');
  await askOnce(panel);
  await expect(rail(panel)).toBeVisible();
  await expect(toggle(panel)).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.getByTestId('conversation-rail')).not.toHaveAttribute('data-drawer');

  const box = (await panel.boundingBox())!;
  const docked = (await rail(panel).boundingBox())!;
  const header = (await panel.locator('.cb-chat-header').boundingBox())!;
  const transcript = (await panel.getByTestId('chat-scroll').boundingBox())!;
  const composer = (await panel.getByTestId('chat-composer').boundingBox())!;
  expect(docked.width).toBeCloseTo(300, 0);
  expect(docked.x + docked.width).toBeCloseTo(box.x + box.width, 0);
  expect(docked.y).toBeCloseTo(header.y + header.height, 0);
  expect(docked.y + docked.height).toBeCloseTo(box.y + box.height, 0);
  expect(header.width).toBeCloseTo(box.width, 0);
  // Beside the transcript, never over it: the composer narrows with it.
  expect(transcript.x + transcript.width).toBeLessThanOrEqual(docked.x + 1);
  expect(composer.x + composer.width).toBeLessThanOrEqual(docked.x);
  expect(
    Math.abs(composer.x + composer.width / 2 - (transcript.x + transcript.width / 2)),
  ).toBeLessThan(2);
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test('folds away at 1100 and opens there as a drawer that writes nothing', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await boot(page);
  const panel = await openCanvas(page);
  await askOnce(panel);
  // On by the preference, and folded: the canvas has no room to dock it.
  await expect(rail(panel)).toBeHidden();
  await expect(toggle(panel)).toHaveAttribute('aria-expanded', 'false');
  const transcript = (await panel.getByTestId('chat-scroll').boundingBox())!;
  const box = (await panel.boundingBox())!;
  expect(transcript.width).toBeCloseTo(box.width, 0);

  await toggle(panel).click();
  await expect(rail(panel)).toBeVisible();
  await expect(panel.getByTestId('conversation-rail')).toHaveAttribute('data-drawer', 'true');
  await expect(toggle(panel)).toHaveAttribute('aria-expanded', 'true');
  await expect(
    panel.getByRole('heading', { level: 2, name: 'Conversation details', exact: true }),
  ).toBeFocused();
  const drawer = (await rail(panel).boundingBox())!;
  const header = (await panel.locator('.cb-chat-header').boundingBox())!;
  expect(drawer.width).toBeCloseTo(300, 0);
  expect(drawer.x + drawer.width).toBeCloseTo(box.x + box.width, 0);
  expect(drawer.y).toBeCloseTo(header.y + header.height, 0);
  // Over the transcript, which keeps its whole width beneath it.
  expect((await panel.getByTestId('chat-scroll').boundingBox())!.width).toBeCloseTo(
    transcript.width,
    0,
  );

  await page.keyboard.press('Escape');
  await expect(rail(panel)).toBeHidden();
  await expect(toggle(panel)).toBeFocused();
  expect(await page.evaluate((key) => localStorage.getItem(key), RAIL_KEY)).toBeNull();
  await expect(panel).toHaveAttribute('data-presentation', 'canvas');
});

test('a person’s word on the rail outlives a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  let panel = await openCanvas(page);
  await askOnce(panel);
  await expect(rail(panel)).toBeVisible();
  await toggle(panel).click();
  await expect(rail(panel)).toBeHidden();
  expect(await page.evaluate((key) => localStorage.getItem(key), RAIL_KEY)).toBe('false');

  await boot(page);
  panel = await openCanvas(page);
  await expect(panel.getByTestId('chat-message').first()).toBeVisible();
  await expect(rail(panel)).toBeHidden();
  await expect(toggle(panel)).toHaveAttribute('aria-expanded', 'false');
  await toggle(panel).click();
  await expect(rail(panel)).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), RAIL_KEY)).toBe('true');

  await boot(page);
  panel = await openCanvas(page);
  await expect(panel.getByTestId('chat-message').first()).toBeVisible();
  await expect(rail(panel)).toBeVisible();
  await expect(toggle(panel)).toHaveAttribute('aria-expanded', 'true');
});

test('canvas, floating and canvas again mid-turn keep the input, the turn and the rail', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  const panel = await openCanvas(page);
  const input = panel.getByLabel('Message the assistant');
  const original = await input.elementHandle();
  await input.fill('wait for me');
  await input.press('Enter');
  await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(rail(panel)).toBeVisible();
  await input.fill('Keep this draft');

  await panel.getByRole('button', { name: 'Float conversation', exact: true }).click();
  await expect(panel).toHaveAttribute('data-presentation', 'floating');
  await expect(panel.getByTestId('conversation-rail')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true);

  await panel.getByRole('button', { name: 'Conversation options', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Expand with conversation details', exact: true })
    .click();
  await expect(panel).toHaveAttribute('data-presentation', 'canvas');
  await expect(rail(panel)).toBeVisible();
  await expect(
    panel.getByRole('heading', { level: 2, name: 'Conversation details', exact: true }),
  ).toBeFocused();
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
  await expect(input).toHaveValue('Keep this draft');
  await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();

  await page.evaluate(() =>
    (window as unknown as { __cerebroReleaseMockRuns: () => void }).__cerebroReleaseMockRuns(),
  );
  const replies = panel.locator('[data-testid="chat-message"][data-role="assistant"]');
  await expect(replies).toHaveCount(1);
  await expect(replies).toContainText('Done waiting.');
  await expect(panel.locator('[data-testid="chat-message"][data-role="user"]')).toHaveCount(1);
  await expect(input).toHaveValue('Keep this draft');
  await expect(rail(panel)).toBeVisible();
});

test('a subagent row jumps to its line in the canvas, and a source opens its page outside it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  const panel = await openCanvas(page);
  await askAssistant(page, 'research the open risks with subagents');
  await assistantSettled(page, 1);
  const details = rail(panel);
  await expect(details).toBeVisible();
  const rows = details.getByTestId('rail-subagent');
  await expect(rows).toHaveCount(2);
  await expect(details.getByTestId('rail-subagents')).toHaveAttribute('data-state', 'ready');

  // Each researcher folds to its line once done; the row opens it there.
  const id = await rows.first().getAttribute('data-tool-id');
  const line = panel.getByTestId('chat-scroll').locator(`[data-tool-id="${id}"]`);
  const fold = line.getByRole('button', { name: /^Done: Read the open risks/ });
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await rows.first().click();
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  await expect(fold).toBeFocused();
  await expect(fold).toBeInViewport();
  await expect(panel).toHaveAttribute('data-presentation', 'canvas');
  await expect(details).toBeVisible();

  // What the researchers read, under the reply that used it. Opening a
  // record floats the conversation first: the peek it opens in is drawn,
  // and the page under it is live.
  const scanner = details.getByTestId('rail-source').filter({ hasText: 'Scanner' });
  await expect(scanner).toHaveCount(1);
  await scanner.getByTestId('rail-source-open').click();
  await expect(panel).toHaveAttribute('data-presentation', 'floating');
  const peek = page.getByTestId('detail-panel');
  await expect(peek).toBeVisible();
  await expect(peek).toContainText('Scanner');
  await expect(page.locator('#main')).not.toHaveAttribute('inert');
});

test('a Changes row shows its change in the canvas, and its open leaves the page on screen', async ({
  page,
}) => {
  const path = 'delivery/how-we-schedule.md';
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  const panel = await openCanvas(page);
  await askAssistant(page, `append "- call the vendor" to ${path}`);
  await assistantSettled(page, 1);
  const changes = rail(panel).getByTestId('rail-changes');
  await expect(changes).toHaveAttribute('data-state', 'ready');
  const row = changes.locator(`[data-testid="rail-change"][data-path="${path}"]`);

  // Its first action: the file's row in the turn's changeset, in the canvas.
  await row.getByRole('button', { name: /^Jump to where how-we-schedule\.md changed/ }).click();
  const file = panel
    .getByTestId('chat-scroll')
    .locator(`[data-slot="file-tree-file"][data-path="${path}"]`);
  await expect.poll(() => file.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await expect(panel).toHaveAttribute('data-presentation', 'canvas');

  // Its second: the page, which the canvas would hide, so it floats first.
  await row.getByRole('button', { name: 'Open how-we-schedule.md (leaves full screen)' }).click();
  await expect(panel).toHaveAttribute('data-presentation', 'floating');
  const doc = page.getByTestId('doc-page');
  await expect(doc).toBeVisible();
  await expect(doc).toContainText('call the vendor');
  await expect(page.locator('#main')).not.toHaveAttribute('inert');
});

test('in the canvas, a docked rail holds the plan, and the dock’s shows only without it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  const panel = await openCanvas(page);
  await holdClock(page);
  await askAssistant(page, 'make a todo list of the open risks');
  const plan = rail(panel).getByTestId('rail-plan');
  const items = plan.locator('[data-section="todo"] [data-slot="queue-item"]');
  await stepUntil(page, async () => (await items.count()) === 3, 'the rail’s plan');
  // One list on screen: the rail's card, the dock's kept hidden.
  const dock = panel.getByTestId('live-plan');
  await expect(dock).toHaveCount(1);
  await expect(dock).toBeHidden();
  await expect(panel.getByRole('region', { name: 'Plan', exact: true })).toHaveCount(0);

  // The rail turned off takes its card with it: the dock's shows the list.
  await toggle(panel).click();
  await expect(rail(panel)).toBeHidden();
  await expect(dock).toBeVisible();
  await expect(dock.locator('[data-section="todo"] [data-slot="queue-item"]')).toHaveCount(3);
  await toggle(panel).click();
  await expect(plan).toBeVisible();
  await expect(dock).toBeHidden();

  // The turn ends: the dock's plan goes, and the rail keeps the list.
  await stepUntilSettled(page, 1);
  await expect(panel.getByTestId('live-plan')).toHaveCount(0);
  await expect(plan).toHaveAttribute('data-state', 'ready');
  await expect(plan).toContainText('3 of 3 done');
});
