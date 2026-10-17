import { expect, test, type Page } from '@playwright/test';
import { boot, openDestination } from './boot';
import { makePdf } from '../src/test/makePdf';

async function openPdf(page: Page, name: 'report.pdf' | 'scan.pdf') {
  await boot(page);
  await page.evaluate(
    ({ report, scan }) => {
      const roots = (
        window as unknown as {
          __cerebroMockRoots: {
            resetMockRoots(): void;
            seedRoot(seed: { path: string; label: string }): { id: string };
          };
        }
      ).__cerebroMockRoots;
      roots.resetMockRoots();
      window.__cerebroMockBytes.reset();
      const root = roots.seedRoot({ path: '/repos/pdf-proof', label: 'PDF proof' });
      window.__cerebroMockBytes.seedBytes(root.id, 'report.pdf', { bytes: report });
      window.__cerebroMockBytes.seedBytes(root.id, 'scan.pdf', { bytes: scan });
    },
    {
      report: [...makePdf({ pages: 40, outline: true })],
      scan: [...makePdf({ pages: 3, text: false })],
    },
  );
  await openDestination(page, 'Work');
  await page
    .getByTestId('root-tree')
    .getByTestId('tree-row')
    .filter({ hasText: 'PDF proof' })
    .click();
  await page.getByTestId('root-tree').getByTestId('tree-row').filter({ hasText: name }).click();
  await expect(page.getByRole('textbox', { name: 'PDF page' })).toBeVisible();
  await expect(page.locator('.pdfViewer canvas').first()).toBeVisible();
}

test('a forty-page PDF renders nearby pages and supports outline, find, page input and zoom', async ({
  page,
}) => {
  await openPdf(page, 'report.pdf');
  const viewer = page.getByTestId('pdf-viewer');
  await expect(viewer.getByText('/ 40', { exact: true })).toBeVisible();
  await expect.poll(() => page.locator('.pdfViewer canvas').count()).toBeGreaterThan(0);
  expect(await page.locator('.pdfViewer canvas').count()).toBeLessThan(12);
  await viewer.getByRole('button', { name: 'Outline', exact: true }).click();
  const outline = viewer.getByRole('navigation', { name: 'PDF outline' });
  await expect(outline.getByRole('button')).toHaveCount(5);
  await outline.getByRole('button', { name: 'Results', exact: true }).click();
  const input = viewer.getByRole('textbox', { name: 'PDF page' });
  await expect(input).toHaveValue('20');
  await page.getByLabel('PDF pages', { exact: true }).focus();
  const modifier = await page.evaluate(() =>
    /Mac/i.test(navigator.platform) ? 'Meta' : 'Control',
  );
  await page.keyboard.press(`${modifier}+f`);
  const search = viewer.getByRole('textbox', { name: 'Find in PDF' });
  await search.fill('quartz');
  await expect(viewer.getByText('1 of 1', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('33');
  await search.fill('Page');
  await expect(viewer.getByText('1 of 40', { exact: true })).toBeVisible();
  await search.press('Enter');
  await expect(viewer.getByText('2 of 40', { exact: true })).toBeVisible();
  await search.press('Shift+Enter');
  await expect(viewer.getByText('1 of 40', { exact: true })).toBeVisible();
  await search.press('Escape');
  await expect(viewer.getByRole('search')).toHaveCount(0);
  await input.fill('12');
  await input.press('Enter');
  await expect(input).toHaveValue('12');
  await input.fill('99');
  await input.blur();
  await expect(input).toHaveValue('40');
  const zoom = viewer.getByLabel('PDF zoom', { exact: true });
  const before = await zoom.textContent();
  await viewer.getByRole('button', { name: 'Zoom in' }).click();
  await expect(zoom).not.toHaveText(before!);
  await page.getByLabel('PDF pages', { exact: true }).focus();
  await page.keyboard.press(`${modifier}+0`);
  await expect(zoom).toHaveText('100%');
  await expect(viewer.getByRole('button', { name: 'Print…' })).toBeDisabled();
  await page.screenshot({ path: `/private/tmp/cerebro-pdf-${test.info().project.name}.png` });
});

test('a scanned PDF explains its missing text layer and disables search and browser print', async ({
  page,
}) => {
  await openPdf(page, 'scan.pdf');
  const viewer = page.getByTestId('pdf-viewer');
  await expect(viewer.getByText(/has no text layer/)).toBeVisible();
  await viewer.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(viewer.getByText('No text to search')).toBeVisible();
  await expect(viewer.getByRole('textbox', { name: 'Find in PDF' })).toBeDisabled();
  await expect(viewer.getByRole('button', { name: 'Print…' })).toBeDisabled();
});

test('the upstream legacy engine restores missing early-WebKit APIs and still renders', async ({
  page,
}) => {
  await page.addInitScript(() => {
    for (const [object, names] of [
      [Promise, ['withResolvers', 'try']],
      [AbortSignal, ['any']],
      [Uint8Array, ['fromBase64']],
      [Uint8Array.prototype, ['toHex']],
      [Set.prototype, ['intersection']],
      [Math, ['sumPrecise']],
    ] as const) {
      for (const name of names) Reflect.deleteProperty(object, name);
    }
  });
  await openPdf(page, 'report.pdf');
  await expect(page.getByRole('textbox', { name: 'PDF page' })).toHaveValue('1');
  expect(await page.evaluate(() => typeof Reflect.get(Promise, 'withResolvers'))).toBe('function');
  expect(await page.evaluate(() => typeof AbortSignal.any)).toBe('function');
});
