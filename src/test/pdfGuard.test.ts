import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { openPdf } from '@/workspace/viewers/pdf/pdfjs';
import { checkPdfTrips, guardsPdf, PDF_GUARDED } from './pdfGuard';
it('guards all ordinary tests, including a swallowed PDF loader failure', async () => {
  expect(guardsPdf('PdfViewer.test.tsx')).toBe(true);
  expect(guardsPdf('document.pdf.test.ts')).toBe(false);
  expect(await openPdf(new Uint8Array())).toEqual({ ok: false, reason: 'engine' });
  expect(() => checkPdfTrips('PdfViewer.test.tsx')).toThrow(
    /Mock '@\/workspace\/viewers\/pdf\/pdfjs'/,
  );
  expect(() => checkPdfTrips('PdfViewer.test.tsx')).not.toThrow();
});
it('guards every runtime PDF import used by the loader', () => {
  const source = readFileSync('src/workspace/viewers/pdf/pdfjs.ts', 'utf8');
  const ids = [...source.matchAll(/import\('(pdfjs-dist[^']+)'\)/g)].map((match) => match[1]);
  expect(new Set(PDF_GUARDED)).toEqual(new Set(ids));
});
