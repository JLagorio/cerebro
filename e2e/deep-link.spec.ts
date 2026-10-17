import { expect, test } from '@playwright/test';
import { boot, openDestination } from './boot';
const PATH = 'projects/phoenix-warehouse-rollout/cutover-prd.md';
test('a cold link wins over last place and opens exactly once', async ({ page }) => {
  await page.addInitScript((path) => {
    window.__cerebroPendingDeepLink = { kind: 'open', path, vault: null };
    localStorage.setItem(
      'cerebro.lastPlace',
      JSON.stringify({ '/demo-vault': { kind: 'settings' } }),
    );
  }, PATH);
  await boot(page);
  await expect(page.getByTestId('doc-title')).toBeVisible();
  await expect(page.getByTestId('doc-title')).toContainText('Phoenix cutover — go-live PRD');
  await openDestination(page, 'Home');
  await page.waitForTimeout(500);
  await expect(page.getByRole('listbox', { name: 'Home lanes' })).toBeVisible();
  await page.keyboard.press('Meta+[');
  await expect(page.getByTestId('doc-title')).toContainText('Phoenix cutover — go-live PRD');
  await page.keyboard.press('Meta+[');
  await expect(page.getByTestId('doc-title')).toContainText('Phoenix cutover — go-live PRD');
});
test('a missing page says so and creates nothing', async ({ page }) => {
  await page.addInitScript(() => {
    window.__cerebroPendingDeepLink = { kind: 'open', path: 'missing-deep-link.md', vault: null };
  });
  await boot(page);
  await expect(
    page.getByText("This link points to missing-deep-link.md, which isn't in this vault."),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__cerebroMockFs.has('missing-deep-link.md'))).toBe(false);
});
test('another registered vault asks before opening and Stay here drops it', async ({
  page,
}, testInfo) => {
  await page.addInitScript((path) => {
    window.__cerebroPendingDeepLink = {
      kind: 'open',
      path,
      vault: { id: '0'.repeat(32), lookup: { kind: 'found', path: '/other-vault' } },
    };
  }, PATH);
  await boot(page);
  const dialog = page.getByRole('dialog', { name: 'Open another vault?' });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('deep-link-confirm')).toContainText('other-vault');
  await page.screenshot({ path: testInfo.outputPath('deep-link-confirm.png') });
  await dialog.getByRole('button', { name: 'Stay here' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('listbox', { name: 'Home lanes' })).toBeVisible();
});
test('a live go opens History and refused payloads show their reason without writes', async ({
  page,
}) => {
  await boot(page);
  const before = await page.evaluate(() => window.__cerebroMockWrites.length);
  await page.evaluate(() =>
    window.__cerebroDeepLink?.({
      kind: 'go',
      to: 'history',
      database: null,
      view: null,
      vault: null,
    }),
  );
  await expect(page.getByTestId('history-heatmap')).toBeVisible();
  await page.evaluate(() =>
    window.__cerebroDeepLink?.({ kind: 'refused', reason: 'it names no page' }),
  );
  await expect(page.getByText("This link couldn't be opened: it names no page.")).toBeVisible();
  expect(await page.evaluate(() => window.__cerebroMockWrites.length)).toBe(before);
});
