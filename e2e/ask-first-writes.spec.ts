import { expect, test, type Page } from '@playwright/test';
import { boot, openKnowledgeTab } from './boot';

/**
 * An ask-first agent's page writes wait for the person (M57.4), against the
 * browser's backend: the agent page's Asks first row writes `ask-first:`,
 * the mock agent's create script asks for its `create_note` under the
 * tool-approval table's confirmable row, and `agentCreate` writes the page
 * through tool_create_note's refusals once the person allows it. The person
 * may edit the draft before Allow (M57.4b), and the page holds their version.
 * A run nobody watches cannot ask, so its write waits in Review's Waiting on
 * you, once and nowhere on disk, until the person allows or rejects it
 * (M57.4c).
 */

const SCOUT = 'records/agents/release-scout.md';
const CREATED = 'records/risks/vendor-delay.md';
const ASK = '@release-scout create "Vendor delay" in records/risks';

const fileAt = (page: Page, path: string) =>
  page.evaluate((p) => window.__cerebroMockFs.get(p as string) ?? null, path);

/** Release scout's page, from the Library's agent shelf (M55.12). */
async function openScout(page: Page) {
  await page.getByTestId('nav-surfaces').getByRole('button', { name: 'Library' }).click();
  await page.getByTestId('library-tab-agent').click();
  await page.getByTestId('library-card').filter({ hasText: 'Release scout' }).click();
  await expect(page.getByTestId('agent-properties')).toBeVisible();
}

/** Asks first → On → Done on release-scout's page. */
async function askFirst(page: Page) {
  await openScout(page);
  const row = page.getByTestId('agent-prop-ask-first');
  await expect(row).toContainText('Writes without asking');
  await row.getByTestId('agent-prop-open').click();
  const editor = page.getByTestId('agent-editor-ask-first');
  await editor.getByRole('radio', { name: 'Asks before every page write' }).check();
  await editor.getByRole('button', { name: 'Done' }).click();
  await expect.poll(() => fileAt(page, SCOUT)).toContain('ask-first: true');
  await expect(row).toContainText('Asks before every page write');
}

async function send(page: Page, text: string) {
  await page.getByTestId('sidebar').getByRole('button', { name: 'Assistant' }).click();
  const panel = page.getByTestId('ai-panel');
  await expect(panel).toBeVisible();
  await panel.getByLabel('Message the assistant').fill(text);
  await panel.getByRole('button', { name: 'Send' }).click();
  return panel;
}

test('ask-first: a page write waits on a card and lands only on Allow', async ({ page }) => {
  await boot(page);
  await askFirst(page);
  const panel = await send(page, ASK);

  const card = panel.getByTestId('write-approval');
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card.getByTestId('write-approval-title')).toHaveText('Create a note');
  await expect(card).toHaveAttribute('data-target', 'records/risks');
  await expect(card.getByTestId('write-approval-byline')).toHaveText(
    'Release scout asks before writing',
  );
  await expect(card).not.toContainText('This conversation');
  expect(await fileAt(page, CREATED)).toBeNull();

  await card.getByTestId('write-approval-allow').click();
  await expect(card).toBeHidden();
  await expect.poll(() => fileAt(page, CREATED), { timeout: 10_000 }).toBe('# Vendor delay\n');
});

test('ask-first: Deny with a reason writes nothing and the reply says why', async ({ page }) => {
  await boot(page);
  await askFirst(page);
  const panel = await send(page, ASK);
  const card = panel.getByTestId('write-approval');
  await expect(card).toBeVisible({ timeout: 10_000 });

  await card.getByTestId('write-approval-reason').fill('not yet');
  await card.getByTestId('write-approval-deny').click();
  await expect(card).toBeHidden();
  await expect(
    panel
      .getByTestId('chat-message')
      .filter({ hasText: 'The person declined this write, so nothing was written.' }),
  ).toBeVisible({ timeout: 10_000 });
  expect(await fileAt(page, CREATED)).toBeNull();
});

test('ask-first: with it off, the same create writes with no card', async ({ page }) => {
  await boot(page);
  const panel = await send(page, ASK);
  await expect.poll(() => fileAt(page, CREATED), { timeout: 10_000 }).toBe('# Vendor delay\n');
  await expect(panel.getByTestId('write-approval')).toHaveCount(0);
});

test('ask-first: the person edits the title before Allow, and the file holds their version', async ({
  page,
}) => {
  await boot(page);
  await askFirst(page);
  const panel = await send(page, ASK);
  const card = panel.getByTestId('write-approval');
  await expect(card).toBeVisible({ timeout: 10_000 });

  // M57.4b: the draft is a form projected from create_note's schema.
  const body = card.getByTestId('write-draft-field-body');
  await expect(body).toHaveValue('# Vendor delay\n');
  await body.fill('# Vendor delay risk\n');
  expect(await fileAt(page, CREATED)).toBeNull();

  await card.getByTestId('write-approval-allow').click();
  await expect(card).toBeHidden();
  await expect.poll(() => fileAt(page, CREATED), { timeout: 10_000 }).toBe('# Vendor delay risk\n');
  await expect(
    panel
      .getByTestId('chat-message')
      .filter({ hasText: `I created ${CREATED} with your changes to body.` }),
  ).toBeVisible({ timeout: 10_000 });
});

test('ask-first: Stop with a write card open cancels it and writes nothing', async ({ page }) => {
  await boot(page);
  await askFirst(page);
  const panel = await send(page, ASK);
  const card = panel.getByTestId('write-approval');
  await expect(card).toBeVisible({ timeout: 10_000 });

  await panel.getByRole('button', { name: 'Stop' }).click();
  await expect(card).toBeHidden();
  const row = panel.getByTestId('action-card').filter({ hasText: 'vendor-delay' });
  await expect(row).toHaveAttribute('data-status', 'cancelled');
  await expect(row.getByTestId('action-deferred')).toHaveText('Cancelled: it did not run');
  expect(await fileAt(page, CREATED)).toBeNull();
});

/** An unattended run of release-scout, asking first, as a schedule starts
 * one: its create waits in Review. Resolves once the run is done. */
const runUnattended = (page: Page) =>
  page.evaluate(
    (message) =>
      window.__cerebroRunUnattended('/demo-vault', {
        message,
        actor: 'process:release-scout',
        scope: ['records/risks'],
        askFirst: true,
      }),
    'create "Vendor delay" in records/risks',
  );

async function waitingOnYou(page: Page) {
  await openKnowledgeTab(page, 'review');
  return page.locator('[data-section="needs-review"]');
}

test('ask-first: an unattended write waits in Review once, and Allow writes the edited page', async ({
  page,
}) => {
  await boot(page);
  await runUnattended(page);
  await runUnattended(page);
  const section = await waitingOnYou(page);
  const card = section.getByTestId('pending-write-card');
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('pending-write-title')).toHaveText('Create a note');
  await expect(card.getByTestId('pending-write-target')).toHaveText(CREATED);
  expect(await fileAt(page, CREATED)).toBeNull();

  await card.getByTestId('write-draft-field-body').fill('# Vendor delay risk\n');
  await card.getByTestId('pending-write-allow').click();
  await expect(card).toHaveCount(0);
  await expect.poll(() => fileAt(page, CREATED), { timeout: 10_000 }).toBe('# Vendor delay risk\n');
});

test('ask-first: Reject waits for a reason, and Send removes the card with nothing written', async ({
  page,
}) => {
  await boot(page);
  await runUnattended(page);
  const section = await waitingOnYou(page);
  const card = section.getByTestId('pending-write-card');
  await expect(card).toHaveCount(1);

  await card.getByTestId('pending-write-reject').click();
  const send = card.getByTestId('pending-write-send');
  await expect(send).toBeDisabled();
  await card.getByTestId('pending-write-reason').fill('not yet');
  await expect(send).toBeEnabled();
  await send.click();
  await expect(card).toHaveCount(0);
  expect(await fileAt(page, CREATED)).toBeNull();
});
