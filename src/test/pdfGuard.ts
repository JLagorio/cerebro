import { afterEach, vi } from 'vitest';

/** Every runtime specifier used by the isolated loader, including its lazy CSS/worker. */
export const PDF_GUARDED = [
  'pdfjs-dist/legacy/build/pdf.mjs',
  'pdfjs-dist/legacy/build/pdf.worker.mjs',
  'pdfjs-dist/legacy/build/pdf.worker.mjs?url',
  'pdfjs-dist/legacy/web/pdf_viewer.mjs',
  'pdfjs-dist/legacy/web/pdf_viewer.css',
] as const;
const tripped: string[] = [];
export const guardsPdf = (testPath: string): boolean => !testPath.endsWith('.pdf.test.ts');
export function installPdfGuard(testPath: string): void {
  if (!guardsPdf(testPath)) return;
  for (const id of PDF_GUARDED)
    vi.doMock(id, () => {
      tripped.push(id);
      throw new Error(`the PDF guard refused ${id}`);
    });
  afterEach(() => checkPdfTrips(testPath));
}
/** A caught loader failure must still fail the test, as the mermaid guard does. */
export function checkPdfTrips(testPath: string): void {
  if (!tripped.length) return;
  const ids = [...new Set(tripped.splice(0))];
  throw new Error(
    `${testPath} reached the real PDF engine (${ids.join(', ')}). Mock '@/workspace/viewers/pdf/pdfjs' in component tests, or measure the engine in a *.pdf.test.ts file (AGENTS.md CV-14).`,
  );
}
