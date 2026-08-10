/**
 * One Shiki instance for the whole app.
 *
 * Both the code viewer and the doc viewer's fences render through this, so a
 * `rust` fence inside a README and `main.rs` in the tree look identical. Two
 * highlighters would guarantee they eventually diverge — and Cerebro already
 * ships Shiki transitively via `@blocknote/code-block`, so the direct
 * dependency is pinned to the same major to keep exactly one copy.
 *
 * Output is REACT NODES, not an HTML string. `codeToHast` plus
 * `hast-util-to-jsx-runtime` means no raw-HTML injection API is used anywhere
 * in the viewer, so a repository file cannot inject markup into the app even
 * if Shiki's escaping were ever wrong. That is worth the extra hop: every byte
 * rendered here comes from a file we did not write.
 *
 * Languages load on demand — bundling every grammar Shiki ships would dwarf
 * the rest of the app.
 */
import type { ReactNode } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import type { Highlighter } from 'shiki';

const EXTENSIONS: Record<string, string> = {
  rs: 'rust',
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  json: 'json',
  toml: 'toml',
  yml: 'yaml',
  yaml: 'yaml',
  css: 'css',
  html: 'html',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  py: 'python',
  sql: 'sql',
  md: 'markdown',
  markdown: 'markdown',
};

const FILENAMES: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'make',
};

/** The Shiki language id for a path, or null to render as plain text. */
export function languageFor(path: string): string | null {
  const filename = path.split('/').pop() ?? path;
  const byName = FILENAMES[filename.toLowerCase()];
  if (byName !== undefined) return byName;
  // A leading-dot file like `.env.example` has no meaningful extension.
  if (filename.startsWith('.')) return null;
  const ext = filename.includes('.') ? filename.split('.').pop() : undefined;
  return ext === undefined ? null : (EXTENSIONS[ext.toLowerCase()] ?? null);
}

let instance: Promise<Highlighter> | null = null;
const loaded = new Set<string>();

async function highlighter(): Promise<Highlighter> {
  if (instance === null) {
    instance = import('shiki').then((shiki) =>
      shiki.createHighlighter({ themes: ['github-light', 'github-dark'], langs: [] }),
    );
  }
  return instance;
}

/** Unstyled fallback: the file's text, as text. */
function plain(code: string): ReactNode {
  return (
    <pre className="shiki-plain m-0">
      <code>{code}</code>
    </pre>
  );
}

/**
 * Highlight to React nodes. An unknown or unloadable language degrades to
 * unstyled text rather than failing — a viewer that shows nothing is worse
 * than one that shows plain code.
 */
export async function highlight(code: string, lang: string | null): Promise<ReactNode> {
  if (lang === null) return plain(code);
  try {
    const hl = await highlighter();
    if (!loaded.has(lang)) {
      await hl.loadLanguage(lang as Parameters<typeof hl.loadLanguage>[0]);
      loaded.add(lang);
    }
    const hast = hl.codeToHast(code, {
      lang,
      themes: { light: 'github-light', dark: 'github-dark' },
    });
    return toJsxRuntime(hast, { Fragment, jsx, jsxs });
  } catch {
    return plain(code);
  }
}
