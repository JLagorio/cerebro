import { expect, test, type Locator, type Page } from '@playwright/test';
import { boot } from './boot';

/**
 * The conversation rail's frame (M92.1): in the canvas, a third grid area of
 * the panel's own aside. It docks beside the transcript where the canvas
 * frame holds 960px (a 1440 window beside the default sidebar), folds away
 * under that and opens as a drawer over the transcript when asked, and a
 * person's word on it outlives a reload. Moving the same conversation
 * between presentations keeps its input, its turn and the rail.
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
