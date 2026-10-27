import { expect, test, type Page } from '@playwright/test';
import { boot, holdClock, readMockFile, seedFileBeforeBoot } from './boot';
const path = 'notes/deleted-draft-browser.md';
async function open(page: Page, host: 'full page' | 'record peek') {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Recovery browser');
  await page
    .getByTestId('quick-open-result')
    .filter({ hasText: 'Recovery browser' })
    .first()
    .click();
  if (host === 'full page')
    await page.getByRole('button', { name: 'Open in full page', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Source', exact: true })).toBeEnabled({
    timeout: 20_000,
  });
}
for (const host of ['full page', 'record peek'] as const)
  test(`deleted source in ${host} offers exact body-only Save as and explicit discard without recreating the original`, async ({
    page,
  }, info) => {
    const raw =
      '\ufeff---\r\ntype: Doc\r\n--- \t\r\n\r\n# Recovery browser\r\n\r\n<div>before😀</div>\r\n';
    await seedFileBeforeBoot(page, path, raw);
    await boot(page);
    await open(page, host);
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    await holdClock(page);
    const body = '\n# Recovery browser\n\n<div>retained😀</div>\n';
    await page.getByRole('textbox', { name: 'Page source' }).fill(body);
    await page.evaluate(async (path) => {
      window.__cerebroMockFs.delete(path);
      const module = '/src/stores/vaultStore.ts';
      const { useVaultStore } = await import(module);
      await useVaultStore.getState().rescan();
    }, path);
    const recovery = page.getByTestId('deleted-draft-recovery');
    await expect(recovery).toContainText('The original file is missing');
    await expect(recovery.getByRole('textbox', { name: /retained text/ })).toHaveValue(body);
    await recovery.getByRole('button', { name: 'Save as…' }).click();
    await page
      .getByRole('textbox', { name: 'New recovery page path' })
      .fill('notes/recovered-browser.md');
    await page.getByRole('button', { name: 'Create new page', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText(
      'Created notes/recovered-browser.md. Your original draft is still kept.',
    );
    expect(await readMockFile(page, 'notes/recovered-browser.md')).toBe(
      body.replace(/\n/g, '\r\n'),
    );
    expect(await page.evaluate((path) => window.__cerebroMockFs.has(path), path)).toBe(false);
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(recovery).toBeVisible();
    await page.screenshot({
      path: info.outputPath('deleted-source-retained.png'),
      animations: 'disabled',
    });
    await recovery.getByRole('button', { name: 'Discard this draft' }).click();
    const confirmation = page.getByRole('dialog', { name: 'Discard retained draft?' });
    await expect(confirmation.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    await confirmation.getByRole('button', { name: 'Discard permanently' }).click();
    await expect(recovery).toHaveCount(0);
    await page.clock.runFor(1_000);
    expect(await page.evaluate((path) => window.__cerebroMockFs.has(path), path)).toBe(false);
    expect(await readMockFile(page, 'notes/recovered-browser.md')).toBe(
      body.replace(/\n/g, '\r\n'),
    );
  });
for (const host of ['full page', 'record peek'] as const)
  test(`restored source in ${host} keeps its explicit recovery release action`, async ({
    page,
  }, info) => {
    const raw = '---\r\ntype: Doc\r\n---\r\n\r\n# Recovery browser\r\n\r\nBefore.\r\n';
    await seedFileBeforeBoot(page, path, raw);
    await boot(page);
    await open(page, host);
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    await holdClock(page);
    await page
      .getByRole('textbox', { name: 'Page source' })
      .fill('\n# Recovery browser\n\nLocal retained.\n');
    await page.evaluate(async (path) => {
      window.__cerebroMockFs.delete(path);
      const module = '/src/stores/vaultStore.ts';
      const { useVaultStore } = await import(module);
      await useVaultStore.getState().rescan();
    }, path);
    const face = page.getByTestId('deleted-draft-recovery');
    await expect(face).toContainText('The original file is missing');
    const outside = raw.replace('Before.', 'Outside restored.');
    await page.evaluate(
      async ({ path, outside }) => {
        window.__cerebroMockFs.set(path, outside);
        const module = '/src/stores/vaultStore.ts';
        const { useVaultStore } = await import(module);
        await useVaultStore.getState().rescan();
      },
      { path, outside },
    );
    await expect(face).toBeVisible();
    await expect(face.getByRole('button', { name: 'Reload restored page' })).toBeEnabled();
    expect(await readMockFile(page, path)).toBe(outside);
    await page.screenshot({
      path: info.outputPath('restored-source-held.png'),
      animations: 'disabled',
    });
    await page.evaluate(async () => {
      const module = '/src/lib/mockFaults.ts';
      const { failNext } = await import(module);
      failNext('read_note_source');
    });
    await face.getByRole('button', { name: 'Reload restored page' }).click();
    await expect(face).toContainText("This page couldn't be loaded. Your draft is kept.");
    await expect(face.getByRole('button', { name: 'Copy body' })).toBeEnabled();
    await expect(face.getByRole('button', { name: 'Discard this draft' })).toBeEnabled();
    // DOM textarea values normalize CRLF; inspect the retained payload separately.
    await expect(face.getByRole('textbox', { name: /retained text/ })).toHaveValue(
      '\n# Recovery browser\n\nLocal retained.\n',
    );
    const retained = await page.evaluate(async (path) => {
      const recoveryModule = '/src/editor/deletedDraftRecovery.ts';
      const vaultModule = '/src/stores/vaultStore.ts';
      const { recoveryDrafts } = await import(recoveryModule);
      const { useVaultStore } = await import(vaultModule);
      return recoveryDrafts({ vaultId: useVaultStore.getState().vaultPath, path })[0].payload.body
        .text;
    }, path);
    expect(retained).toBe('\r\n# Recovery browser\r\n\r\nLocal retained.\r\n');
    expect(await readMockFile(page, path)).toBe(outside);
    await page.screenshot({
      path: info.outputPath('restored-source-read-failure-held.png'),
      animations: 'disabled',
    });
    await page.evaluate(async () => {
      const module = '/src/lib/mockFaults.ts';
      const { resetFaults } = await import(module);
      resetFaults();
    });
    await face.getByRole('button', { name: 'Reload restored page' }).click();
    await expect(page.getByRole('textbox', { name: 'Page source' })).toBeVisible();
    await expect(face).toHaveCount(0);
    await page.clock.runFor(1_000);
    expect(await readMockFile(page, path)).toBe(outside);
  });
test('discarded missing diagram stays a tombstone and a restored diagram requires an explicit version choice', async ({
  page,
}, info) => {
  const path = 'diagrams/recovery-diagram.mmd',
    raw = 'graph TD\n A-->B\n',
    outside = 'graph TD\n Outside-->Restored\n';
  await seedFileBeforeBoot(page, path, raw);
  await boot(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Recovery diagram');
  await page
    .getByTestId('quick-open-result')
    .filter({ hasText: 'Recovery diagram' })
    .first()
    .click();
  await expect(page.getByTestId('diagram-page')).toBeVisible();
  await page.getByRole('button', { name: 'Show code', exact: true }).click();
  await page.getByText('Auto-update', { exact: true }).click();
  await holdClock(page);
  await page.getByRole('textbox', { name: 'Mermaid source' }).fill('graph TD\n [retained invalid');
  await page.evaluate(async (path) => {
    window.__cerebroMockFs.delete(path);
    const module = '/src/stores/vaultStore.ts';
    const { useVaultStore } = await import(module);
    await useVaultStore.getState().rescan();
  }, path);
  const face = page.getByTestId('deleted-draft-recovery');
  await expect(face).toContainText('The original file is missing');
  await page.evaluate(
    async ({ path, outside }) => {
      window.__cerebroMockFs.set(path, outside);
      const module = '/src/stores/vaultStore.ts';
      const { useVaultStore } = await import(module);
      await useVaultStore.getState().rescan();
    },
    { path, outside },
  );
  await expect(face).toBeVisible();
  await face.getByRole('button', { name: 'Reload restored page' }).click();
  await expect(face.getByRole('button', { name: 'Use my draft' })).toBeEnabled();
  await expect(face.getByRole('button', { name: 'Use restored file' })).toBeEnabled();
  expect(await readMockFile(page, path)).toBe(outside);
  await page.screenshot({
    path: info.outputPath('restored-diagram-choice.png'),
    animations: 'disabled',
  });
  // Remove the actual restored file again, then discard only the retained instance.
  await page.evaluate(async (path) => {
    window.__cerebroMockFs.delete(path);
    const module = '/src/stores/vaultStore.ts';
    const { useVaultStore } = await import(module);
    await useVaultStore.getState().rescan();
  }, path);
  await face.getByRole('button', { name: 'Discard this draft' }).click();
  await page
    .getByRole('dialog', { name: 'Discard retained draft?' })
    .getByRole('button', { name: 'Discard permanently' })
    .click();
  await expect(face).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Mermaid source' })).toHaveCount(0);
  await expect(page.getByText('Diagram unavailable', { exact: true })).toBeVisible();
  await page.clock.runFor(1_000);
  expect(await page.evaluate((path) => window.__cerebroMockFs.has(path), path)).toBe(false);
});
