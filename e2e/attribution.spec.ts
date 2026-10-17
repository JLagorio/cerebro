import { expect, test, type Page } from '@playwright/test';
import { boot, openAgents, readMockFile, openAssistantPanel, openDestination } from './boot';

/**
 * A page says who last changed it, and run detail names the pages a run
 * wrote (M58.1b).
 *
 * Against the mock backend, whose write log (M58.1) stands in for runtime.db's
 * `vault_writes`: every door logs its write with its stamp and the hash of
 * what it wrote, and `pageAttribution` holds that hash against the page as it
 * is now. An edit made straight to `__cerebroMockFs` logs nothing, which is
 * what another editor's save looks like to Cerebro.
 */

const PAGE = 'delivery/how-we-schedule.md';
// No "inbox", "organize" or "risk" on the page or in the asks: the mock agent
// picks its script by keyword.
const BODY = ['# How we schedule', '', 'We ship on Thursdays, after the freeze.', ''].join('\n');

async function openSchedule(page: Page): Promise<void> {
  const node = page.getByTestId('collection-node-doc').filter({ hasText: 'How we schedule' });
  if (!(await node.isVisible()))
    await page.getByRole('button', { name: 'Expand Delivery' }).click();
  await node.getByRole('button', { name: 'How we schedule' }).click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible({ timeout: 10_000 });
}

async function showInfo(page: Page): Promise<void> {
  if (!(await page.getByTestId('doc-side-panel').isVisible())) {
    await page.getByRole('button', { name: 'Show panel' }).click();
  }
  await page.getByTestId('doc-side-panel').getByTestId('doc-panel-tab-info').click();
}

/** Send `text` to the mock assistant and wait for a reply holding `reply`. */
async function ask(page: Page, text: string, reply: string): Promise<void> {
  const panel = page.getByTestId('ai-panel');
  await panel.getByLabel('Message the assistant').fill(text);
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.getByTestId('chat-message').filter({ hasText: reply }).last()).toBeVisible({
    timeout: 10_000,
  });
}

test("a page's Info says who last changed it: you, outside Cerebro, the Assistant", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await boot(page);
  await page.evaluate(([path, md]) => window.__cerebroMockFs.set(path, md), [PAGE, BODY]);
  await openSchedule(page);
  await showInfo(page);
  const line = page.getByTestId('doc-side-panel').getByTestId('last-change-line');
  await expect(line).toHaveText('Who changed this page was not recorded');

  // Typing saves through the editor's door: it reads as you.
  await page.getByTestId('markdown-editor').getByText('We ship on Thursdays').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Typed by me.');
  await expect.poll(() => readMockFile(page, PAGE)).toContain('Typed by me.');
  await expect(line).toHaveText(/^Last changed by You · /, { timeout: 10_000 });

  // Another editor changes the file while the page is closed, so no save of
  // the editor's lands over it; the page, opened again, reads the new bytes.
  await openDestination(page, 'Home');
  await expect(page.getByTestId('markdown-editor')).toHaveCount(0);
  await page.evaluate(
    ([path]) =>
      window.__cerebroMockFs.set(path, `${window.__cerebroMockFs.get(path)}\nFrom elsewhere.\n`),
    [PAGE],
  );
  await openSchedule(page);
  await showInfo(page);
  await expect(line).toHaveText(/^Changed outside Cerebro since You wrote it .+ — unattributed$/, {
    timeout: 10_000,
  });

  // The Assistant's append goes through its own door, stamped as it.
  await openAssistantPanel(page);
  await expect(page.getByTestId('ai-panel')).toBeVisible();
  await ask(page, `append "Agent line." to ${PAGE}`, `I appended that to ${PAGE}.`);
  await showInfo(page);
  await expect(line).toHaveText(/^Last changed by Assistant · /, { timeout: 10_000 });
});

test('run detail names the pages a run wrote, or says it was not recorded', async ({ page }) => {
  await boot(page);
  await openAgents(page);
  await page.locator('[data-testid="fleet-row"][data-run="run-scout-1"]').click();
  const detail = page.getByTestId('run-detail');
  await expect(detail).toHaveAttribute('data-run', 'run-scout-1');
  const pages = detail.getByTestId('run-detail-page');
  await expect(pages).toHaveCount(1);
  await expect(pages).toHaveAttribute('data-path', 'records/risks/risk-scanner-delivery.md');
  await expect(pages).toContainText('changed');

  await page.getByTestId('run-detail-close').click();
  await page.locator('[data-testid="fleet-row"][data-run="run-legacy-1"]').click();
  await expect(page.getByTestId('run-detail')).toHaveAttribute('data-run', 'run-legacy-1');
  await expect(page.getByTestId('run-detail-pages')).toHaveText('Pages written: not recorded');
});
