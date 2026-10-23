import { expect, test, type Locator, type Page } from '@playwright/test';
import { boot, showDatabases, openDestination } from './boot';
import type { DroppedSeed } from '../src/lib/mockDropped';

async function drop(page: Page, zone: Locator, files: DroppedSeed[], hold = false) {
  await zone.scrollIntoViewIfNeeded();
  const box = await zone.boundingBox();
  if (box === null) throw new Error('Drop zone has no bounds');
  // Target visible content; the router still resolves the innermost child.
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.evaluate((input) => window.__cerebroMockDrop(input), { at, files, hold });
}
test('OS paths show hover, capture text, name skipped folders, and refuse unsupported targets', async ({
  page,
}) => {
  await boot(page);
  await openDestination(page, 'Inbox');
  const inbox = page.getByTestId('inbox-page');
  const files = [
    { path: '/outside/Native capture.md', content: 'A note dropped from Finder.' },
    { path: '/outside/folder', folder: true },
  ];
  await drop(page, inbox, files, true);
  await expect(page.getByTestId('inbox-dropzone')).toBeVisible();
  await page.evaluate(() => window.__cerebroMockDragLeave());
  await expect(page.getByTestId('inbox-dropzone')).toHaveCount(0);
  await drop(page, inbox, files);
  const row = page.locator('[data-testid="inbox-row"][data-path="inbox/native-capture.md"]');
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('toast-host')).toContainText('folder (a folder)');
  const saved = await page.evaluate(() => window.__cerebroMockFs.get('inbox/native-capture.md'));
  expect(saved).toContain('source_file: Native capture.md');
  expect(saved).not.toContain('/outside/');
  await page.screenshot({ path: '/private/tmp/cerebro-os-drop-inbox.png', animations: 'disabled' });
  const before = await page.evaluate(() => window.__cerebroMockWrites.length);
  await drop(page, page.getByTestId('app-rail'), [
    { path: '/outside/no-zone.txt', content: 'No write' },
  ]);
  await expect(page.getByTestId('toast-host')).toContainText(
    'Drop files on the Inbox, a Files property, or a page.',
  );
  expect(await page.evaluate(() => window.__cerebroMockWrites.length)).toBe(before);
});
test('a Files property copies dropped bytes into attachments and keeps the relative reference', async ({
  page,
}) => {
  await boot(page);
  await showDatabases(page);
  await page.getByTestId('sidebar-type').filter({ hasText: 'Work item' }).first().click();
  await page.getByTestId('add-column').click();
  const panel = page.getByTestId('add-property-panel');
  await panel.getByLabel('Property name').fill('Attachments');
  await panel.getByTestId('property-kind-files').click();
  const field = page.locator('[data-os-drop="files-field"]').first();
  await expect(field).toBeVisible();
  await drop(page, field, [{ path: '/outside/Drop brief.pdf', base64: 'JVBERi0xLjcK' }]);
  await expect(field.getByRole('button', { name: 'Open Drop brief.pdf' })).toBeVisible();
  expect(await page.evaluate(() => window.__cerebroMockFs.has('attachments/Drop brief.pdf'))).toBe(
    true,
  );
  expect(
    await page.evaluate(() =>
      [...window.__cerebroMockFs.values()].some((text) =>
        text.includes('attachments/Drop brief.pdf'),
      ),
    ),
  ).toBe(true);
  await page.screenshot({ path: '/private/tmp/cerebro-os-drop-files.png', animations: 'disabled' });
});
