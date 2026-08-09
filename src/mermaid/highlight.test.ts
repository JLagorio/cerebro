import { describe, expect, it, vi } from 'vitest';

describe('loadMermaidHighlighter', () => {
  it('returns null when shiki (or its mermaid grammar) is unavailable', async () => {
    vi.resetModules();
    vi.doMock('shiki', () => {
      throw new Error('not installed');
    });
    const { loadMermaidHighlighter } = await import('./highlight');
    expect(await loadMermaidHighlighter()).toBeNull();
    vi.doUnmock('shiki');
  });

  it('returns a highlighter that emits html when shiki loads', async () => {
    vi.resetModules();
    vi.doMock('shiki', () => ({
      createHighlighter: vi.fn().mockResolvedValue({
        codeToHtml: (code: string) => `<pre class="shiki">${code}</pre>`,
      }),
    }));
    const { loadMermaidHighlighter } = await import('./highlight');
    const highlight = await loadMermaidHighlighter();
    expect(highlight).not.toBeNull();
    expect(highlight?.('graph TD')).toContain('shiki');
    vi.doUnmock('shiki');
  });
});
