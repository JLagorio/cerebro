/**
 * The design-system bundle's `shiki` (M100.1): the API `src/workspace/highlighter.tsx`
 * calls, over a curated set of grammars on the JavaScript regex engine. The
 * bundle inlines every dynamic import, and every grammar would put it past the
 * artifact's 6 MB cap. A language not listed rejects, and the highlighter then
 * draws plain text, its own fallback.
 */
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

type LangInput = Parameters<HighlighterCore['loadLanguage']>[0];
type ThemeInput = Parameters<HighlighterCore['loadTheme']>[0];

const LANGS: Record<string, LangInput> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  shell: () => import('shiki/langs/shellscript.mjs'),
  bash: () => import('shiki/langs/shellscript.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
};
const THEMES: Record<string, ThemeInput> = {
  'github-light': () => import('shiki/themes/github-light.mjs'),
  'github-dark': () => import('shiki/themes/github-dark.mjs'),
};

export async function createHighlighter() {
  const core = await createHighlighterCore({
    themes: [],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
  return {
    loadTheme: (name: string) =>
      THEMES[name]
        ? core.loadTheme(THEMES[name])
        : Promise.reject(new Error(`theme ${name} is not in the design-system bundle`)),
    loadLanguage: (name: string) =>
      LANGS[name]
        ? core.loadLanguage(LANGS[name])
        : Promise.reject(new Error(`language ${name} is not in the design-system bundle`)),
    codeToHast: core.codeToHast.bind(core),
  };
}
