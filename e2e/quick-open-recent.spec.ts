import { test, expect, type Page } from '@playwright/test';
import { boot } from './boot';

/**
 * M59.3 — ⌘K opens on Recent and ranks by your own opens.
 *
 * The clock is frozen (boot pins it), so every open shares one timestamp:
 * these assert the log's order, never its times.
 */

const results = (page: Page) => page.getByTestId('quick-open-result');

async function openPalette(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByTestId('quick-open-input')).toBeVisible();
}

/** Open a page through ⌘K by typing its title and clicking its row. */
async function openByName(page: Page, title: string) {
  await openPalette(page);
  await page.getByTestId('quick-open-input').fill(title.toLowerCase());
  await results(page).filter({ hasText: title }).first().click();
  await expect(page.getByTestId('quick-open-input')).toBeHidden();
}

/** The labels of the rows a query lists, ask row excluded. */
async function rowLabels(page: Page, query: string): Promise<string[]> {
  await page.getByTestId('quick-open-input').fill(query);
  await expect(page.getByTestId('quick-open-ask')).toBeVisible();
  return results(page).evaluateAll((rows) =>
    rows.map((r) => r.querySelector('span.flex-1')?.textContent ?? ''),
  );
}

test('an empty ⌘K lists Recent, newest first, and Settings can clear it', async ({ page }) => {
  await boot(page);
  await openByName(page, 'Phoenix cutover standup');
  await openByName(page, 'Phoenix warehouse rollout');

  await openPalette(page);
  const recent = page.locator('[data-section="recent"]');
  await expect(recent.getByTestId('quick-open-result')).toHaveCount(2);
  await expect(recent.getByTestId('quick-open-result').nth(0)).toContainText(
    'Phoenix warehouse rollout',
  );
  await expect(recent.getByTestId('quick-open-result').nth(1)).toContainText(
    'Phoenix cutover standup',
  );
  // Recent sits above Go to.
  await expect(results(page).first()).toContainText('Phoenix warehouse rollout');

  // Settings shows both, in the log's order, and Clear empties it.
  await page.getByTestId('quick-open-input').fill('settings');
  await page.keyboard.press('Enter');
  const section = page.getByTestId('settings-recently-opened');
  await expect(section.getByTestId('open-log-row')).toHaveCount(2);
  await expect(section.getByTestId('open-log-row').nth(0)).toContainText(
    'Phoenix warehouse rollout',
  );
  await section.getByTestId('open-log-clear').click();
  await expect(section.getByText('Nothing opened yet.')).toBeVisible();

  await openPalette(page);
  await expect(page.locator('[data-section="recent"]')).toHaveCount(0);
  await expect(page.locator('[data-section="go"]')).toBeVisible();
});

test('opening the second of two equal matches makes it lead next time', async ({ page }) => {
  await boot(page);
  await openPalette(page);
  const before = await rowLabels(page, 'phoenix warehouse');
  expect(before.length).toBeGreaterThan(1);
  const second = before[1];

  await results(page).nth(1).click();
  await expect(page.getByTestId('quick-open-input')).toBeHidden();

  await openPalette(page);
  const after = await rowLabels(page, 'phoenix warehouse');
  expect(after[0]).toBe(second);
  expect(after[1]).toBe(before[0]);
});

test('two words apart find the project by name', async ({ page }) => {
  await boot(page);
  await openPalette(page);
  const labels = await rowLabels(page, 'phoenix rollout');
  expect(labels).toContain('Phoenix warehouse rollout');
  await expect(
    results(page).filter({ hasText: 'Phoenix warehouse rollout' }).first(),
  ).toContainText('Project');
});
