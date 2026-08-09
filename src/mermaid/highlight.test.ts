import { describe, expect, it, vi } from 'vitest';

const unmockAll = () => {
  vi.doUnmock('shiki/core');
  vi.doUnmock('shiki/engine/javascript');
  vi.doUnmock('@shikijs/langs/mermaid');
  vi.doUnmock('@shikijs/themes/github-light');
  vi.doUnmock('@shikijs/themes/github-dark');
};

describe('loadMermaidHighlighter', () => {
  it('returns null when shiki (or its mermaid grammar) is unavailable', async () => {
    vi.resetModules();
    vi.doMock('shiki/core', () => {
      throw new Error('not installed');
    });
    const { loadMermaidHighlighter } = await import('./highlight');
    expect(await loadMermaidHighlighter()).toBeNull();
    unmockAll();
  });

  it('returns a highlighter that emits html when shiki loads', async () => {
    vi.resetModules();
    vi.doMock('shiki/core', () => ({
      createHighlighterCore: vi.fn().mockResolvedValue({
        codeToHtml: (code: string) => `<pre class="shiki">${code}</pre>`,
      }),
    }));
    vi.doMock('shiki/engine/javascript', () => ({
      createJavaScriptRegexEngine: vi.fn().mockReturnValue({}),
    }));
    vi.doMock('@shikijs/langs/mermaid', () => ({ default: [] }));
    vi.doMock('@shikijs/themes/github-light', () => ({ default: {} }));
    vi.doMock('@shikijs/themes/github-dark', () => ({ default: {} }));
    const { loadMermaidHighlighter } = await import('./highlight');
    const highlight = await loadMermaidHighlighter();
    expect(highlight).not.toBeNull();
    expect(highlight?.('graph TD')).toContain('shiki');
    unmockAll();
  });
});
