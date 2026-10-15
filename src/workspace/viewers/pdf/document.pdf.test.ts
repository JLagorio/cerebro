// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { makePdf } from '@/test/makePdf';
import { hasTextLayer, openPdf } from './pdfjs';
import { toOutline } from './outline';

describe('the real bundled PDF document', () => {
  it('opens forty pages, resolves every outline destination and reads text', async () => {
    const opened = await openPdf(makePdf({ pages: 40, outline: true }));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      expect(opened.doc.numPages).toBe(40);
      expect(await toOutline(opened.doc)).toEqual([
        { title: 'Intro', page: 1, children: [] },
        { title: 'Methods', page: 10, children: [] },
        { title: 'Results', page: 20, children: [{ title: 'Table 3', page: 23, children: [] }] },
        { title: 'Appendix', page: 35, children: [] },
      ]);
      expect(await hasTextLayer(opened.doc)).toBe(true);
      const items = (await (await opened.doc.getPage(33)).getTextContent()).items;
      expect(items.some((item) => 'str' in item && item.str.includes('quartz'))).toBe(true);
    } finally {
      await opened.doc.destroy();
    }
  });
  it('distinguishes a page with no text from damaged bytes', async () => {
    const opened = await openPdf(makePdf({ pages: 3, text: false }));
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      try {
        expect(await hasTextLayer(opened.doc)).toBe(false);
      } finally {
        await opened.doc.destroy();
      }
    }
    expect(await openPdf(new TextEncoder().encode('not a pdf'))).toEqual({
      ok: false,
      reason: 'corrupt',
    });
    expect(await openPdf(makePdf().slice(0, 24))).toEqual({ ok: false, reason: 'corrupt' });
  });
});
