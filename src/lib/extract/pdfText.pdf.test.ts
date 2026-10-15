// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { makePdf } from '@/test/makePdf';
import { extractPdfText } from './pdfText';
describe('real bundled PDF text extraction', () => {
  it('reads two text pages through the upstream loader', async () => {
    const result = await extractPdfText(makePdf({ pages: 2 }));
    expect(result.state).toBe('extracted');
    if (result.state === 'extracted') {
      expect(result.markdown).toContain('## Page 1');
      expect(result.markdown).toContain('## Page 2');
      expect(result.markdown).toBe('## Page 1\n\nPage 1\n\n## Page 2\n\nPage 2');
    }
  });
  it('distinguishes a scanned page from garbage', async () => {
    expect(await extractPdfText(makePdf({ pages: 1, text: false }))).toEqual({
      state: 'no_text_layer',
    });
    expect(await extractPdfText(new TextEncoder().encode('not a PDF'))).toMatchObject({
      state: 'corrupt',
    });
  });
});
