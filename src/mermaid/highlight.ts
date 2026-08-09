/**
 * Mermaid source highlighting (M29.10) — best effort, never required.
 * Shiki is lazy (its wasm + grammar are a real chunk), memoized, and every
 * failure path resolves to null: the editor then shows plain mono, which is
 * exactly what it showed before this file existed.
 */
export type Highlighter = (code: string) => string;

let promise: Promise<Highlighter | null> | null = null;

export function loadMermaidHighlighter(): Promise<Highlighter | null> {
  promise ??= (async () => {
    try {
      const { createHighlighter } = await import('shiki');
      const h = await createHighlighter({
        themes: ['github-light', 'github-dark'],
        langs: ['mermaid'],
      });
      return (code: string) => {
        const dark = document.documentElement.getAttribute('data-theme') === 'dark';
        return h.codeToHtml(code, {
          lang: 'mermaid',
          theme: dark ? 'github-dark' : 'github-light',
        });
      };
    } catch {
      return null;
    }
  })();
  return promise;
}
