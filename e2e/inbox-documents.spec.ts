import { expect, test, type Page } from '@playwright/test';
import { makePdf } from '../src/test/makePdf';
import { boot, readMockFile } from './boot';

async function drop(page: Page, name: string, bytes: Uint8Array) {
  await page
    .getByTestId('nav-surfaces')
    .getByRole('button', { name: /^Inbox/ })
    .click();
  const box = await page.getByTestId('inbox-page').boundingBox();
  if (!box) throw new Error('Inbox has no bounds');
  // The header is inside the Inbox drop zone and outside its editor's zone.
  await page.evaluate(
    ({ name, base64, at }) =>
      window.__cerebroMockDrop({
        at,
        files: [{ path: `/outside/${name}`, base64 }],
      }),
    { name, base64: Buffer.from(bytes).toString('base64'), at: { x: box.x + 80, y: box.y + 20 } },
  );
}
const captures = (page: Page) =>
  page.evaluate(() =>
    [...window.__cerebroMockFs].filter(
      ([path, text]) => path.startsWith('inbox/') && /^source_system: file$/m.test(text),
    ),
  );

test('an Office drop keeps its original, files an editable capture and deduplicates a repeat', async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => {
    (
      window as unknown as { __cerebroSeedExtractions: (rows: unknown) => void }
    ).__cerebroSeedExtractions({
      'attachments/Plan.docx': {
        state: 'extracted',
        markdown:
          '## Goals\n\n4. Keep the plan\n\n| Task | Owner |\n| --- | --- |\n| Review | Alex |',
        not_carried: [],
        truncated: false,
      },
    });
  });
  const bytes = new TextEncoder().encode('office fixture bytes');
  await drop(page, 'Plan.docx', bytes);
  await expect.poll(async () => (await captures(page)).length).toBe(1);
  const [[path, content]] = await captures(page);
  for (const words of [
    'source_file: Plan.docx',
    'source_attachment: attachments/Plan.docx',
    'source_record_id:',
    'source_sha256:',
    'extraction: extracted',
    '## Goals',
    '![Plan.docx](/attachments/Plan.docx)',
  ])
    expect(content).toContain(words);
  await expect(page.getByTestId('markdown-editor')).toContainText('Goals');
  await expect(page.getByText('(untitled capture)', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('lossy-import-banner')).toHaveCount(0);
  await expect(
    page.getByTestId('markdown-editor').locator('[contenteditable="true"]').first(),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        window.__cerebroMockWrites.filter(
          (row) => row.kind === 'vault.create' && row.path === 'attachments/Plan.docx',
        ).length,
    ),
  ).toBe(1);
  await page.screenshot({
    path: '/private/tmp/cerebro-inbox-document.png',
    animations: 'disabled',
  });
  await drop(page, 'Plan.docx', bytes);
  await expect(page.getByTestId('toast-host')).toContainText('already filed as Plan');
  expect(await captures(page)).toHaveLength(1);
  expect(await readMockFile(page, path)).toBe(content);
  expect(
    await page.evaluate(
      () =>
        window.__cerebroMockWrites.filter(
          (row) => row.kind === 'vault.create' && row.path === 'attachments/Plan.docx',
        ).length,
    ),
  ).toBe(1);
});

test('a PDF with no text layer keeps its original and explains the outcome', async ({ page }) => {
  await boot(page);
  await drop(page, 'Scan.pdf', makePdf({ text: false }));
  await expect.poll(async () => (await captures(page)).length).toBe(1);
  const [[, content]] = await captures(page);
  expect(content).toContain('extraction: no_text_layer');
  expect(content).toContain('![Scan.pdf](/attachments/Scan.pdf)');
  await expect(page.getByTestId('markdown-editor')).toContainText('No text layer:');
  await expect(page.getByTestId('toast-host')).toContainText('Scan.pdf: no text layer');
});

test('a real text PDF files one editable section per page', async ({ page }) => {
  await boot(page);
  await drop(page, 'Report.pdf', makePdf({ pages: 2 }));
  await expect.poll(async () => (await captures(page)).length).toBe(1);
  const [[, content]] = await captures(page);
  expect(content).toContain('## Page 1\n\nPage 1');
  expect(content).toContain('## Page 2\n\nPage 2');
  await expect(page.getByTestId('markdown-editor')).toContainText('Page 2');
  await expect(page.getByTestId('lossy-import-banner')).toHaveCount(0);
});
