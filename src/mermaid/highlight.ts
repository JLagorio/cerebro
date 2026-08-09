/**
 * Mermaid source highlighting (M29.10) — best effort, never required.
 * Shiki is lazy (its grammar is a real chunk), memoized, and every failure
 * path resolves to null: the editor then shows plain mono, which is exactly
 * what it showed before this file existed.
 *
 * Fine-grained bundle: `createHighlighterCore` + the JS regex engine, not
 * the default `createHighlighter`, which drags in shiki's ~622KB oniguruma
 * wasm engine to tokenize a single grammar. The JS engine is pure JS —
 * heavier to run than wasm on huge files, irrelevant here (one small
 * mermaid block), and it collapses the bundle instead of growing it.
 */
export type Highlighter = (code: string) => string;

let promise: Promise<Highlighter | null> | null = null;

export function loadMermaidHighlighter(): Promise<Highlighter | null> {
  promise ??= (async () => {
    try {
      const [
        { createHighlighterCore },
        { createJavaScriptRegexEngine },
        mermaidLang,
        lightTheme,
        darkTheme,
      ] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
        import('@shikijs/langs/mermaid'),
        import('@shikijs/themes/github-light'),
        import('@shikijs/themes/github-dark'),
      ]);
      const h = await createHighlighterCore({
        themes: [lightTheme, darkTheme],
        langs: [mermaidLang],
        engine: createJavaScriptRegexEngine(),
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
