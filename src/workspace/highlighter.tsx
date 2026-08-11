/**
 * One Shiki instance for the whole app.
 *
 * Both the code viewer and the doc viewer's fences render through this, so a
 * `rust` fence inside a README and `main.rs` in the tree look identical. Two
 * highlighters would guarantee they eventually diverge — and Cerebro already
 * ships Shiki transitively via `@blocknote/code-block`, so the direct
 * dependency is pinned to the same major to keep exactly one copy.
 *
 * ## One theme at a time, chosen by the app's theme
 *
 * Shiki can emit DUAL-theme output — every span carrying a `--shiki-dark`
 * custom property alongside its light colour — but that only renders if a
 * stylesheet maps those properties under a dark selector. Cerebro has no such
 * rule, so dual output painted light-theme code on a white card inside a dark
 * app. Highlighting with a single theme resolved from `data-theme` needs no
 * CSS contract at all: the colours Shiki emits are the colours you see.
 *
 * ## React nodes, not an HTML string
 *
 * `codeToHast` plus `hast-util-to-jsx-runtime` means no raw-HTML injection API
 * is used anywhere in the viewer, so a repository file cannot inject markup
 * even if Shiki's escaping were ever wrong. Every byte rendered here comes
 * from a file we did not write.
 *
 * Languages load on demand — bundling every grammar Shiki ships would dwarf
 * the rest of the app.
 */
import type { ReactNode } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import type { Highlighter } from 'shiki';
import type { ResolvedTheme } from '@/hooks/useTheme';

/**
 * The slice of hast this file walks. Narrower than `hast`'s own types on
 * purpose: everything below only reads `type`, `value` and `children`, and a
 * structural type says that without importing a tree of definitions to
 * describe properties nobody here touches.
 */
interface HastNode {
  type: string;
  value?: string;
  children?: HastNode[];
}

const EXTENSIONS: Record<string, string> = {
  rs: 'rust',
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'jsonc',
  toml: 'toml',
  yml: 'yaml',
  yaml: 'yaml',
  css: 'css',
  scss: 'scss',
  html: 'html',
  xml: 'xml',
  svg: 'xml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  md: 'markdown',
  markdown: 'markdown',
  vue: 'vue',
  svelte: 'svelte',
  lua: 'lua',
  r: 'r',
  diff: 'diff',
  patch: 'diff',
};

const FILENAMES: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'make',
  '.gitignore': 'ini',
  '.gitattributes': 'ini',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  '.prettierrc': 'json',
  '.eslintrc': 'json',
};

/** The Shiki theme for a resolved app theme. */
export function themeFor(theme: ResolvedTheme): string {
  return theme === 'dark' ? 'github-dark' : 'github-light';
}

/** The Shiki language id for a path, or null to render as plain text. */
export function languageFor(path: string): string | null {
  const filename = path.split('/').pop() ?? path;
  const lower = filename.toLowerCase();
  const byName = FILENAMES[lower];
  if (byName !== undefined) return byName;
  // A leading-dot file with no further dot (`.env`) has no extension to read.
  const cut = lower.lastIndexOf('.');
  if (cut <= 0) return null;
  return EXTENSIONS[lower.slice(cut + 1)] ?? null;
}

let instance: Promise<Highlighter> | null = null;
const loadedLangs = new Set<string>();
const loadedThemes = new Set<string>();

async function highlighter(): Promise<Highlighter> {
  if (instance === null) {
    instance = import('shiki').then((shiki) => shiki.createHighlighter({ themes: [], langs: [] }));
  }
  return instance;
}

/**
 * Unstyled fallback: the file's text, as text — but split into the same
 * `.line` spans Shiki emits, so a plain file numbers, wraps and highlights its
 * current row exactly like a recognised one. A viewer where `.txt` behaves
 * differently from `.ts` is a viewer with two layouts to maintain.
 */
function plain(code: string): ReactNode {
  const lines = code.split('\n');
  return (
    <pre className="shiki-plain m-0">
      <code>
        {/* Keyed by index because a line's identity IS its position — there is
            nothing else about it to key on, and the list is rebuilt whole
            whenever the file changes. */}
        {lines.map((line, i) => (
          <span key={i} className="line">
            {line}
          </span>
        ))}
      </code>
    </pre>
  );
}

/**
 * Shiki separates its line spans with literal "\n" TEXT NODES, which is
 * correct for `white-space: pre` inline lines and wrong for anything else. The
 * gutter needs each line to be a block box, and a block box plus a newline
 * renders every line double-spaced.
 *
 * Dropping those separators here — rather than fighting them in CSS — is what
 * lets `.line { display: block }` hold, which is in turn what lets line numbers
 * be a `::before` counter (never selected, never copied) instead of real
 * elements a copy would drag along.
 */
function unwrapLines<T extends HastNode>(tree: T): T {
  for (const pre of tree.children ?? []) {
    for (const code of pre.children ?? []) {
      if (code.children === undefined) continue;
      code.children = code.children.filter(
        (child) => !(child.type === 'text' && child.value === '\n'),
      );
    }
  }
  return tree;
}

/**
 * Highlight to React nodes. An unknown or unloadable language degrades to
 * unstyled text rather than failing — a viewer that shows nothing is worse
 * than one that shows plain code.
 */
export async function highlight(
  code: string,
  lang: string | null,
  theme: ResolvedTheme,
): Promise<ReactNode> {
  if (lang === null) return plain(code);
  const shikiTheme = themeFor(theme);
  try {
    const hl = await highlighter();
    if (!loadedThemes.has(shikiTheme)) {
      await hl.loadTheme(shikiTheme as Parameters<typeof hl.loadTheme>[0]);
      loadedThemes.add(shikiTheme);
    }
    if (!loadedLangs.has(lang)) {
      await hl.loadLanguage(lang as Parameters<typeof hl.loadLanguage>[0]);
      loadedLangs.add(lang);
    }
    const hast = unwrapLines(hl.codeToHast(code, { lang, theme: shikiTheme }));
    return toJsxRuntime(hast, { Fragment, jsx, jsxs });
  } catch {
    return plain(code);
  }
}
