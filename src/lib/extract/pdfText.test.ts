import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractPdfText,
  PDF_TEXT_LIMITS,
  textOfItems,
  type OpenTextPdf,
  type TextDocument,
} from './pdfText';
const bytes = new Uint8Array([1, 2, 3]);
const limits = { ...PDF_TEXT_LIMITS, pageMs: 20, totalMs: 100 };
function fake(pages: Array<string | Error>): { doc: TextDocument; open: OpenTextPdf } {
  const doc = {
    numPages: pages.length,
    getPage: vi.fn(async (page: number) => ({
      getTextContent: async () => {
        const value = pages[page - 1];
        if (value instanceof Error) throw value;
        return { items: [{ str: value, transform: [1, 0, 0, 12, 0, 100] }] };
      },
    })),
    destroy: vi.fn(async () => undefined),
  };
  return { doc, open: async () => ({ ok: true, doc }) };
}
afterEach(() => vi.useRealTimers());
describe('bounded PDF text captures', () => {
  it('makes one section per page, inerts text, and always destroys', async () => {
    const { doc, open } = fake(['Goals', '[[agent]] :::ai <script>']);
    const result = await extractPdfText(bytes, open);
    expect(result).toMatchObject({ state: 'extracted', truncated: false, not_carried: [] });
    if (result.state !== 'extracted') return;
    expect(result.markdown).toBe(
      '## Page 1\n\nGoals\n\n## Page 2\n\n\\[\\[agent\\]\\] &#58;&#58;&#58;ai &lt;script&gt;',
    );
    expect(doc.destroy).toHaveBeenCalledOnce();
  });
  it('calls all-empty pages no_text_layer, but never calls a failure empty', async () => {
    expect(await extractPdfText(bytes, fake(['', '']).open)).toEqual({ state: 'no_text_layer' });
    expect(await extractPdfText(bytes, fake([new Error('bad')]).open)).toEqual({
      state: 'corrupt',
      detail: 'No page could be read.',
    });
    const result = await extractPdfText(bytes, fake(['', new Error('broken'), 'Words']).open);
    expect(result).toMatchObject({ state: 'extracted', pages_not_extracted: 1 });
    if (result.state !== 'extracted') return;
    expect(result.markdown).toContain('Page 1: no text on this page.');
    expect(result.markdown).toContain('Page 2: text not extracted (broken).');
    expect(result.markdown).toContain('## Page 3');
  });
  it('names passwords, invalid bytes and an unavailable engine', async () => {
    expect(await extractPdfText(bytes, async () => ({ ok: false, reason: 'encrypted' }))).toEqual({
      state: 'encrypted',
    });
    expect(
      await extractPdfText(bytes, async () => ({ ok: false, reason: 'corrupt' })),
    ).toMatchObject({ state: 'corrupt' });
    expect(
      await extractPdfText(bytes, async () => ({ ok: false, reason: 'engine' })),
    ).toMatchObject({ state: 'unsupported' });
    expect(
      await extractPdfText(bytes, async () => {
        const error = new Error('password');
        error.name = 'PasswordException';
        throw error;
      }),
    ).toEqual({ state: 'encrypted' });
  });
  it('keeps lines and separates paragraphs using vertical gaps', () => {
    const item = (str: string, x: number, y: number) => ({
      str,
      transform: [1, 0, 0, 10, x, y],
      width: 10,
      height: 10,
    });
    expect(
      textOfItems([
        item('One', 0, 100),
        item('two', 20, 100),
        item('line', 0, 88),
        item('paragraph', 0, 60),
      ]),
    ).toBe('One two\nline\n\nparagraph');
  });
  it('caps both constructed text and final UTF-8 output', async () => {
    expect(
      textOfItems(
        Array.from({ length: 100 }, () => ({ str: '' })),
        8,
      ).length,
    ).toBeLessThanOrEqual(8);
    const result = await extractPdfText(bytes, fake(['é'.repeat(1000)]).open, {
      ...limits,
      bytes: 100,
    });
    expect(result).toMatchObject({ state: 'extracted', truncated: true });
    if (result.state === 'extracted')
      expect(new TextEncoder().encode(result.markdown).byteLength).toBeLessThanOrEqual(100);
  });
  it('reads at most 300 pages and names omitted pages', async () => {
    const { doc, open } = fake(Array.from({ length: 301 }, () => 'x'));
    const result = await extractPdfText(bytes, open);
    expect(doc.getPage).toHaveBeenCalledTimes(300);
    expect(result).toMatchObject({ state: 'extracted', pages_not_extracted: 1 });
    if (result.state === 'extracted')
      expect(result.markdown).toContain('Pages 301–301 are not extracted here');
  });
  it('never splits a surrogate at its source-text cap', () => {
    expect(textOfItems([{ str: 'a😀b' }], 2)).toBe('a');
    expect(textOfItems([{ str: 'a😀b' }], 3)).toBe('a😀');
  });
  it('counts a failed page omitted by the byte cap only once', async () => {
    const result = await extractPdfText(bytes, fake(['Words', new Error('broken')]).open, {
      ...limits,
      bytes: 20,
    });
    expect(result).toMatchObject({ state: 'extracted', truncated: true, pages_not_extracted: 1 });
  });
  it('times out a page, records it, and continues within the total deadline', async () => {
    vi.useFakeTimers();
    const { doc, open } = fake(['x', 'y']);
    vi.mocked(doc.getPage).mockImplementationOnce(async () => ({
      getTextContent: () => new Promise(() => undefined),
    }));
    const promise = extractPdfText(bytes, open, limits);
    await vi.advanceTimersByTimeAsync(21);
    const result = await promise;
    expect(result).toMatchObject({ state: 'extracted', pages_not_extracted: 1 });
    if (result.state === 'extracted') expect(result.markdown).toContain('the reader took too long');
    expect(doc.destroy).toHaveBeenCalledOnce();
  });
  it('stops at the total deadline, including an open that answers late', async () => {
    vi.useFakeTimers();
    const { doc } = fake(['x']);
    let resolve!: (value: { ok: true; doc: TextDocument }) => void;
    const promise = extractPdfText(
      bytes,
      () =>
        new Promise((done) => {
          resolve = done;
        }),
      limits,
    );
    await vi.advanceTimersByTimeAsync(101);
    expect(await promise).toMatchObject({ state: 'corrupt', detail: 'the reader took too long' });
    resolve({ ok: true, doc });
    await Promise.resolve();
    expect(doc.destroy).toHaveBeenCalledOnce();
  });
  it('contains a cleanup rejection', async () => {
    const { doc, open } = fake(['x']);
    vi.mocked(doc.destroy).mockRejectedValue(new Error('worker gone'));
    expect(await extractPdfText(bytes, open)).toMatchObject({ state: 'extracted' });
  });
});
