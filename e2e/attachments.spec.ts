import { expect, test, type Page } from '@playwright/test';
import { boot, seedFileBeforeBoot, readMockFile } from './boot';

const TYPE = `---
type: Type
name: Asset
fields:
  artwork: {kind: files}
views:
  - id: gallery
    name: Gallery
    presentation:
      type: gallery
      columns: [{field: title}, {field: artwork}]
      gallery: {cover: artwork, fit: true}
---
# Asset
`;
const RECORD =
  '---\ntype: Asset\nartwork: [attachments/poster.png, attachments/brief.pdf]\ncover: attachments/poster.png\nicon: attachments/poster.png\n---\n# Launch poster\n\nKeep these original bytes.\n';
async function start(page: Page) {
  await seedFileBeforeBoot(page, 'types/asset.md', TYPE);
  await seedFileBeforeBoot(page, 'assets/launch-poster.md', RECORD);
  await boot(page);
  await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 400;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#254d42';
    ctx.fillRect(0, 0, 800, 400);
    ctx.fillStyle = '#fff8d6';
    ctx.font = '64px sans-serif';
    ctx.fillText('Launch poster', 190, 220);
    window.__cerebroMockBytes.seedBytes('0', 'attachments/poster.png', {
      base64: canvas.toDataURL('image/png').split(',')[1],
    });
    window.__cerebroMockBytes.seedBytes('0', 'attachments/brief.pdf', { text: '%PDF-1.7\n' });
  });
}
async function search(page: Page, title: string) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('quick-open-input').fill(title);
  await page.getByTestId('quick-open-result').filter({ hasText: title }).first().click();
}
test('gallery and page images load, image chips open a lightbox and other attachments open as pages', async ({
  page,
}) => {
  await start(page);
  await page.getByTestId('sidebar-type').filter({ hasText: 'Asset' }).click();
  const cover = page.getByTestId('gallery-cover');
  await expect(cover).toHaveAttribute('data-fit', 'contain');
  await expect
    .poll(() => cover.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(800);
  await page.screenshot({
    path: '/private/tmp/cerebro-attachments-gallery.png',
    animations: 'disabled',
  });
  await search(page, 'Launch poster');
  // Typed records open in the detail panel; its title opens their full page.
  await page.getByTestId('detail-panel').getByRole('button', { name: 'Open in full page' }).click();
  await expect(page.getByTestId('doc-title')).toContainText('Launch poster');
  await expect
    .poll(() =>
      page
        .getByTestId('page-cover')
        .locator('img')
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(800);
  await page.getByRole('button', { name: 'Open poster.png' }).click();
  await expect(page.getByRole('dialog')).toContainText('1 of 1');
  await expect
    .poll(() =>
      page
        .getByTestId('file-lightbox')
        .locator('img')
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(800);
  await page.screenshot({
    path: '/private/tmp/cerebro-attachments-lightbox.png',
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open brief.pdf' }).click();
  await expect(
    page.getByTestId('file-page').getByRole('heading', { name: 'brief.pdf', level: 1 }),
  ).toBeVisible();
  await expect(page).toHaveTitle('brief.pdf — Cerebro');
  await page.screenshot({
    path: '/private/tmp/cerebro-attachments-file-page.png',
    animations: 'disabled',
  });
  await page.keyboard.press('ControlOrMeta+[');
  await expect(page.getByTestId('doc-title')).toContainText('Launch poster');
  expect(await readMockFile(page, 'assets/launch-poster.md')).toBe(RECORD);
  expect(
    await page.evaluate(() =>
      window.__cerebroMockWrites.filter((row) => row.path === 'assets/launch-poster.md'),
    ),
  ).toEqual([]);
});
