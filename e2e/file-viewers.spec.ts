import { expect, test, type Page } from '@playwright/test';
import { boot, openDestination } from './boot';

async function files(page: Page) {
  await boot(page);
  await page.evaluate(() => {
    const roots = (
      window as unknown as {
        __cerebroMockRoots: {
          resetMockRoots(): void;
          seedRoot(seed: { path: string; label: string }): { id: string };
          seedFile(root: string, rel: string, text: string): void;
        };
      }
    ).__cerebroMockRoots;
    roots.resetMockRoots();
    window.__cerebroMockBytes.reset();
    const root = roots.seedRoot({ path: '/repos/media', label: 'media' });
    const canvas = document.createElement('canvas');
    canvas.width = 1600;
    canvas.height = 1200;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#394d70';
    ctx.fillRect(0, 0, 1600, 1200);
    ctx.fillStyle = '#dde8ff';
    ctx.font = '80px sans-serif';
    ctx.fillText('Contained image', 160, 600);
    window.__cerebroMockBytes.seedBytes(root.id, 'logo.png', {
      base64: canvas.toDataURL('image/png').split(',')[1],
    });
    canvas.width = 64;
    canvas.height = 32;
    ctx.fillStyle = '#394d70';
    ctx.fillRect(0, 0, 64, 32);
    window.__cerebroMockBytes.seedBytes(root.id, 'small.png', {
      base64: canvas.toDataURL('image/png').split(',')[1],
    });
    const wav = new Uint8Array(44 + 8000 * 2);
    const data = new DataView(wav.buffer);
    const word = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i++) wav[offset + i] = text.charCodeAt(i);
    };
    word(0, 'RIFF');
    data.setUint32(4, wav.length - 8, true);
    word(8, 'WAVE');
    word(12, 'fmt ');
    data.setUint32(16, 16, true);
    data.setUint16(20, 1, true);
    data.setUint16(22, 1, true);
    data.setUint32(24, 8000, true);
    data.setUint32(28, 16000, true);
    data.setUint16(32, 2, true);
    data.setUint16(34, 16, true);
    word(36, 'data');
    data.setUint32(40, wav.length - 44, true);
    window.__cerebroMockBytes.seedBytes(root.id, 'tone.wav', { bytes: [...wav] });
    window.__cerebroMockBytes.seedBytes(root.id, 'spec.docx', { bytes: [80, 75, 3, 4] });
    window.__cerebroMockBytes.seedBytes(root.id, 'tool', { bytes: [127, 69, 76, 70, 0] });
    roots.seedFile(
      '/repos/media',
      'books.csv',
      'Title,Notes\nDune,"desert\nplanet"\nFoundation,=SUM(A1)\nSolaris,Ocean',
    );
    roots.seedFile(
      '/repos/media',
      'books.tsv',
      'Title\tNotes\nDune\tdesert, planet\nSolaris\tOcean',
    );
    roots.seedFile(
      '/repos/media',
      'README.md',
      '# Media\n\n![Logo](./logo.png)\n\n![Missing](./gone.png)',
    );
  });
  await openDestination(page, 'Work');
  await page.getByTestId('root-tree').getByTestId('tree-row').filter({ hasText: 'media' }).click();
}
async function open(page: Page, path: string) {
  await page.getByTestId('root-tree').getByTestId('tree-row').filter({ hasText: path }).click();
}

test('images fit their frame, never upscale, and show actual size on request', async ({ page }) => {
  await files(page);
  await open(page, 'logo.png');
  const image = page.getByTestId('file-image');
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1600);
  await expect(page.getByTestId('image-viewer')).toHaveAttribute('data-fit', 'fit');
  const size = await image.evaluate((img) => {
    const frame = img.parentElement!.getBoundingClientRect();
    const rect = img.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      frameWidth: frame.width,
      frameHeight: frame.height,
    };
  });
  expect(size.width).toBeLessThanOrEqual(size.frameWidth);
  expect(size.height).toBeLessThanOrEqual(size.frameHeight);
  await page.screenshot({ path: '/private/tmp/cerebro-file-viewer-image.png' });
  await page.getByRole('button', { name: '100%', exact: true }).click();
  await expect(page.getByTestId('image-viewer')).toHaveAttribute('data-fit', 'actual');
  expect(await image.evaluate((img) => img.getBoundingClientRect().width)).toBe(1600);
  await open(page, 'small.png');
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(64);
  expect(await image.evaluate((img) => img.getBoundingClientRect().width)).toBe(64);
});
test('native audio controls start paused with metadata loaded', async ({ page }) => {
  await files(page);
  await open(page, 'tone.wav');
  const audio = page.getByTestId('media-viewer').locator('audio');
  await expect(audio).toHaveAttribute('controls', '');
  await expect(audio).toHaveAttribute('preload', 'metadata');
  await expect.poll(() => audio.evaluate((node: HTMLMediaElement) => node.duration)).toBe(1);
  expect(await audio.evaluate((node: HTMLMediaElement) => node.paused && !node.autoplay)).toBe(
    true,
  );
});
test('CSV and TSV are plain read-only tables with a source view', async ({ page }) => {
  await files(page);
  await open(page, 'books.csv');
  await expect(page.getByTestId('table-viewer').getByRole('row')).toHaveCount(4);
  await expect(page.getByRole('cell', { name: 'desert planet' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '=SUM(A1)' })).toBeVisible();
  await page.screenshot({ path: '/private/tmp/cerebro-file-viewer-table.png' });
  await page.getByRole('button', { name: 'View as text' }).click();
  await expect(page.getByTestId('code-viewer').locator('.line')).toHaveCount(5);
  await expect(page.getByTestId('code-viewer')).toContainText('Dune,"desert');
  await open(page, 'books.tsv');
  await expect(page.getByRole('cell', { name: 'desert, planet' })).toBeVisible();
  await expect(page.getByTestId('table-viewer').getByRole('columnheader')).toHaveCount(2);
});
test('unknown files explain their limits, executable files omit Open, and markdown images resolve', async ({
  page,
}) => {
  await files(page);
  await open(page, 'spec.docx');
  await expect(page.getByTestId('unknown-viewer')).toContainText(
    'No preview for this kind of file',
  );
  const actions = page.getByTestId('file-actions');
  await expect(actions.getByRole('button')).toHaveCount(4);
  for (const button of await actions.getByRole('button').all()) await expect(button).toBeDisabled();
  await expect(actions).toContainText('Desktop app only');
  await page.screenshot({ path: '/private/tmp/cerebro-file-viewer-unknown.png' });
  await open(page, 'tool');
  await expect(actions.getByRole('button', { name: /^Open/ })).toHaveCount(0);
  await expect(actions.getByRole('button', { name: 'Quick Look' })).toBeVisible();
  await open(page, 'README.md');
  const image = page.getByTestId('doc-image');
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1600);
  await expect(page.getByText('Image unavailable: gone.png')).toBeVisible();
});
