import { expect, test, type Page } from '@playwright/test';
import { boot, seedFileBeforeBoot, readMockFile, openDestination } from './boot';
const NOTE = 'notes/attachment-page.md';
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6WQAAAAASUVORK5CYII=';
async function open(page: Page, body = '# Attachment page\n\nFirst\n\nSecond\n') {
  await seedFileBeforeBoot(page, NOTE, body);
  await boot(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill('Attachment page');
  await page
    .getByTestId('quick-open-result')
    .filter({ hasText: 'Attachment page' })
    .first()
    .click();
  await expect(page.getByTestId('markdown-editor')).toBeVisible();
}
async function pasteImage(page: Page) {
  await page
    .getByTestId('markdown-editor')
    .locator('.bn-inline-content')
    .filter({ hasText: /^First$/ })
    .click();
  await page.evaluate((base64) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], 'image.png', {
        type: 'image/png',
      }),
    );
    document
      .querySelector('.bn-editor')!
      .dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
  }, PNG);
}
test('paste reuses bytes, renders the image, undoes one batch, and survives reopen and later edits', async ({
  page,
}) => {
  await open(page);
  await pasteImage(page);
  await expect(page.getByTestId('toast-host')).toContainText('Added 1 file to attachments/');
  const images = page.getByTestId('markdown-editor').locator('img');
  await expect(images).toHaveCount(1);
  await expect
    .poll(() => images.first().evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(1);
  await expect
    .poll(() => readMockFile(page, NOTE))
    .toContain('First\n\n![](/attachments/image.png)\n\nSecond');
  expect(
    await page.evaluate(
      () =>
        window.__cerebroMockWrites.filter(
          (write) => write.kind === 'vault.create' && write.path === 'attachments/image.png',
        ).length,
    ),
  ).toBe(1);
  await pasteImage(page);
  await expect(images).toHaveCount(2);
  await expect(page.getByTestId('toast-host')).toContainText(
    'Reused 1 file already in attachments/',
  );
  expect(
    await page.evaluate(
      () =>
        [...window.__cerebroMockFs.keys()].filter((path) => path.startsWith('attachments/image'))
          .length,
    ),
  ).toBe(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(images).toHaveCount(1);
  await openDestination(page, 'Home');
  await page.keyboard.press('ControlOrMeta+[');
  await expect(images).toHaveCount(1);
  await page
    .getByTestId('markdown-editor')
    .locator('.bn-inline-content')
    .filter({ hasText: /^Second$/ })
    .click();
  await page.keyboard.press('End');
  await page.keyboard.type(' changed');
  await expect.poll(() => readMockFile(page, NOTE)).toContain('Second changed');
  expect(await readMockFile(page, NOTE)).toContain('![](/attachments/image.png)');
  await page.screenshot({
    path: '/private/tmp/cerebro-page-attachments.png',
    animations: 'disabled',
  });
});
test('OS and HTML5 drops name skips once and copy a PDF into a durable file block', async ({
  page,
}) => {
  await open(page);
  const editor = page.getByTestId('markdown-editor');
  const box = await editor.boundingBox();
  if (box === null) throw new Error('No editor');
  await page.evaluate(
    ({ at, png }) =>
      window.__cerebroMockDrop({
        at,
        files: [
          { path: '/outside/shot.png', base64: png },
          { path: '/outside/.env', content: 'secret' },
          { path: '/outside/big.mov', size: 50000001 },
          { path: '/outside/folder', folder: true },
        ],
      }),
    { at: { x: box.x + 100, y: box.y + box.height - 10 }, png: PNG },
  );
  await expect(page.getByTestId('toast-host')).toContainText(
    'Added 1 file to attachments/ — skipped: .env is hidden; big.mov is over 50 MB; folder is a folder',
  );
  await editor.evaluate((host) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['%PDF-1.7\n'], 'report.pdf', { type: 'application/pdf' }));
    const rect = host.getBoundingClientRect();
    host.querySelector('.bn-editor')!.dispatchEvent(
      new DragEvent('drop', {
        dataTransfer: transfer,
        clientX: rect.x + 100,
        clientY: rect.y + rect.height - 10,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect
    .poll(() => readMockFile(page, NOTE))
    .toContain('![report.pdf](/attachments/report.pdf)');
  await expect(editor.locator('[data-content-type="file"]')).toHaveCount(1);
});
test('/image Upload states the cap and copies the selected file', async ({ page }) => {
  await open(page);
  const editor = page.getByTestId('markdown-editor');
  await editor.locator('.bn-inline-content').last().click();
  await page.keyboard.type('/image');
  await page.getByRole('option', { name: /^Image/ }).click();
  await expect(page.getByText('Copied into attachments/ · up to 50 MB')).toBeVisible();
  await page.screenshot({
    path: '/private/tmp/cerebro-attachment-upload.png',
    animations: 'disabled',
  });
  await page.getByTestId('attachment-upload-input').setInputFiles({
    name: 'upload.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG, 'base64'),
  });
  await expect.poll(() => readMockFile(page, NOTE)).toContain('![](/attachments/upload.png)');
});

test('a locked page refuses an OS attachment before any copy', async ({ page }) => {
  const body = '# Attachment page\n\n<div align="center">raw html island</div>\n';
  await open(page, body);
  await expect(page.getByTestId('lossy-import-banner')).toBeVisible();
  const editor = page.getByTestId('markdown-editor');
  const box = await editor.boundingBox();
  if (box === null) throw new Error('No editor');
  const before = await page.evaluate(() => window.__cerebroMockWrites.length);
  await page.evaluate(
    ({ at, png }) =>
      window.__cerebroMockDrop({ at, files: [{ path: '/outside/readonly.png', base64: png }] }),
    { at: { x: box.x + 100, y: box.y + box.height - 10 }, png: PNG },
  );
  await expect(page.getByTestId('toast-host')).toContainText(
    'This page is read-only — nothing was added',
  );
  expect(await page.evaluate(() => window.__cerebroMockWrites.length)).toBe(before);
  expect(await page.evaluate(() => window.__cerebroMockFs.has('attachments/readonly.png'))).toBe(
    false,
  );
  expect(await readMockFile(page, NOTE)).toBe(body);
});
