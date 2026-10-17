import { expect, test, type Page } from '@playwright/test';
import { boot, readMockFile, openAssistantPanel } from './boot';

/**
 * An agent sets a record's fields through set_fields (M60.4), checked
 * against its database: an option's label is stored as its id, a link to a
 * record of another database is refused naming the one the field expects,
 * and a computed field is refused. A refusal writes nothing.
 *
 * Through the mock agent's set script (`set <field> to "<value>" on
 * <note>.md`) and the mock backend's `agentSetFields`, the TS twin of Rust's
 * planner. The demo vault's Objective type declares `quarter` (a select of
 * 2026 Q3 and 2026 Q4), `key_results` (a relation to Key result records) and
 * `progress` (a rollup).
 */

const PAGE = 'records/objectives/obj-launch-pipeline.md';
const TITLE = 'Launch campaign drives qualified pipeline';

/** The objective, found by its title, opened as a page; then the assistant. */
async function openObjective(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill(TITLE.toLowerCase());
  await page.getByTestId('quick-open-result').filter({ hasText: TITLE }).first().click();
  await page.getByRole('button', { name: 'Open in full page' }).click();
  await expect(page.getByTestId('doc-page')).toBeVisible();
  await openAssistantPanel(page);
  await expect(page.getByTestId('ai-panel')).toBeVisible();
}

/** Send `ask` and wait for the reply that holds `reply`. */
async function ask(page: Page, message: string, reply: string): Promise<void> {
  const panel = page.getByTestId('ai-panel');
  await panel.getByLabel('Message the assistant').fill(message);
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.getByTestId('chat-message').filter({ hasText: reply })).toHaveCount(1, {
    timeout: 10_000,
  });
}

test('an option label is stored as its id, and the page shows its label', async ({ page }) => {
  await openObjective(page);
  const doc = page.getByTestId('doc-page');
  await expect(doc.getByText('2026 Q3').first()).toBeVisible();
  await ask(page, `set quarter to "2026 Q4" on ${PAGE}`, `I set quarter on ${PAGE}.`);
  const saved = await readMockFile(page, PAGE);
  expect(saved).toContain('quarter: 2026-q4\n');
  expect(saved).not.toContain('2026 Q4');
  await expect(doc.getByText('2026 Q4').first()).toBeVisible();
});

test('a link to a record of another database is refused naming the one expected', async ({
  page,
}) => {
  await openObjective(page);
  const before = await readMockFile(page, PAGE);
  await ask(
    page,
    `set key_results to "obj-field-app-readiness" on ${PAGE}`,
    `I could not set key_results on ${PAGE}: schema_invalid: nothing was written to ${PAGE}.`,
  );
  await expect(
    page
      .getByTestId('ai-panel')
      .getByTestId('chat-message')
      .filter({ hasText: 'key_results takes Key result records' }),
  ).toHaveCount(1);
  expect(await readMockFile(page, PAGE)).toBe(before);
});

test('a computed field is refused, and nothing changes', async ({ page }) => {
  await openObjective(page);
  const before = await readMockFile(page, PAGE);
  await ask(page, `set progress to "50" on ${PAGE}`, 'progress is computed');
  expect(await readMockFile(page, PAGE)).toBe(before);
});
