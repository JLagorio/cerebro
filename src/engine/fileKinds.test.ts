/**
 * The file-kind table, TS side (M66.1): byte identity with Rust, the shared
 * cases and refusals, and the migration from the four maps it replaced.
 *
 * @see src-tauri/src/files/kinds.rs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveIcon } from '@/components/ui/Icon';
import { sha256Hex } from '@/lib/sha256';
import { lookFor } from '@/workspace/fileIcons';
import { languageFor } from '@/workspace/highlighter';
import CASES from '../../src-tauri/fixtures/file-kind-cases.json';
import {
  CAPTURE_MAX_BYTES,
  captureExtensions,
  extOf,
  fileLook,
  isCapturable,
  kindFor,
  KINDS,
  KINDS_DIGEST_PATH,
  KINDS_PATH,
  parseKinds,
  shikiFor,
} from './fileKinds';
import { isMarkdownPath } from './roots';

const REPO = join(__dirname, '../..');
const RAW = readFileSync(join(REPO, KINDS_PATH), 'utf8');

interface Look {
  icon: string;
  color: string | null;
}

describe('the shared table is one artifact', () => {
  it('hashes to the digest the Rust reader also asserts', () => {
    // The cross-language anchor: Rust hashes what `include_str!` compiled in
    // against this same file. Regenerate it deliberately after an edit with
    // `cargo test --lib files::kinds::tests::write_kinds_digest -- --ignored`.
    const committed = readFileSync(join(REPO, KINDS_DIGEST_PATH), 'utf8').trim();
    expect(sha256Hex(RAW)).toBe(committed);
  });

  it('is the same object vite imported', () => {
    expect(JSON.parse(RAW)).toEqual(KINDS);
  });

  it('replays the shared kind cases', () => {
    expect(CASES.kinds.length).toBeGreaterThan(0);
    for (const c of CASES.kinds) {
      const row = kindFor(c.name);
      const look = fileLook(c.name);
      expect(
        {
          ext: extOf(c.name),
          kind: row.kind,
          mime: row.mime,
          viewer: row.viewer,
          bytes: row.bytes,
          open: row.open,
          shiki: shikiFor(c.name),
          icon: look.icon,
          color: look.color,
          capture: isCapturable(c.name),
        },
        c.name,
      ).toEqual({ ...c, name: undefined });
    }
  });

  it('every icon is a lucide icon', () => {
    const icons = [
      KINDS.unknown.icon,
      ...KINDS.kinds.map((row) => row.icon),
      ...KINDS.names.flatMap((row) => (row.icon === undefined ? [] : [row.icon])),
    ];
    for (const icon of icons) expect(resolveIcon(icon).Comp, icon).not.toBeNull();
  });
});

describe('refuses malformed tables in the words Rust uses', () => {
  type Node = Record<string, unknown> | unknown[];
  const pick = (rows: unknown[], key: string): number => {
    const i = rows.findIndex((r) => {
      const row = r as { ext?: unknown; name?: unknown } | null;
      return typeof row === 'object' && row !== null && (row.ext === key || row.name === key);
    });
    if (i === -1) throw new Error(`no row ${key}`);
    return i;
  };
  // Apply one refusal case's edit to the shipped table, as kinds.rs does.
  const edited = (c: (typeof CASES.refusals)[number]): unknown => {
    const table = JSON.parse(RAW) as Node;
    const at = [...c.at];
    const last = at.pop() as string;
    let here: Node = table;
    for (const seg of at) {
      here = (Array.isArray(here) ? here[pick(here, seg)] : here[seg]) as Node;
    }
    const remove = 'delete' in c && c.delete === true;
    if (Array.isArray(here)) {
      const i = pick(here, last);
      if (remove) here.splice(i, 1);
      else here[i] = (c as { set?: unknown }).set;
    } else if (remove) {
      delete here[last];
    } else {
      here[last] = (c as { set?: unknown }).set;
    }
    return table;
  };

  it.each(CASES.refusals.map((c) => [c.rule, c.error, c] as const))('%s: %s', (_r, error, c) => {
    expect(() => parseKinds(edited(c))).toThrow(new Error(error));
  });
});

describe('the derived readers', () => {
  it('captures exactly the six text kinds, sorted, under the table cap', () => {
    expect(captureExtensions()).toEqual(['markdown', 'md', 'srt', 'text', 'txt', 'vtt']);
    expect(CAPTURE_MAX_BYTES).toBe(KINDS.limits.capture_max_bytes);
  });

  it('lowercases ASCII only, as Rust does', () => {
    // A full Unicode lowercase would read the Kelvin sign as `k` and call this
    // a video; both readers leave it alone.
    expect(extOf('clip.mKv')).toBe('mKv');
    expect(kindFor('clip.mKv').kind).toBe('unknown');
    expect(extOf('CLIP.MKV')).toBe('mkv');
  });
});

/*
 * RETIRED: the four maps this table replaced, copied once when M66.1 deleted
 * them, so the migration is checked against what they actually said. A
 * deliberate change to an icon, colour or language edits the row here too.
 */
const RETIRED_ICON_NAMES: Record<string, Look> = {
  'package.json': { icon: 'package', color: 'var(--opt-green)' },
  'pnpm-lock.yaml': { icon: 'lock', color: 'var(--opt-yellow)' },
  'package-lock.json': { icon: 'lock', color: 'var(--opt-yellow)' },
  'cargo.toml': { icon: 'package', color: 'var(--opt-orange)' },
  'cargo.lock': { icon: 'lock', color: 'var(--opt-yellow)' },
  'readme.md': { icon: 'book-open', color: 'var(--opt-blue)' },
  license: { icon: 'scale', color: 'var(--opt-yellow)' },
  'license.md': { icon: 'scale', color: 'var(--opt-yellow)' },
  'security.md': { icon: 'shield', color: 'var(--opt-red)' },
  'contributing.md': { icon: 'users', color: 'var(--opt-green)' },
  'claude.md': { icon: 'sparkles', color: 'var(--opt-purple)' },
  'agents.md': { icon: 'sparkles', color: 'var(--opt-purple)' },
  dockerfile: { icon: 'container', color: 'var(--opt-blue)' },
  makefile: { icon: 'terminal', color: 'var(--opt-green)' },
  '.gitignore': { icon: 'git-branch', color: 'var(--opt-orange)' },
  '.gitattributes': { icon: 'git-branch', color: 'var(--opt-orange)' },
  '.editorconfig': { icon: 'settings', color: 'var(--n-500)' },
  '.prettierrc': { icon: 'wand-sparkles', color: 'var(--opt-pink)' },
  '.prettierrc.json': { icon: 'wand-sparkles', color: 'var(--opt-pink)' },
  '.prettierignore': { icon: 'wand-sparkles', color: 'var(--opt-pink)' },
  '.npmrc': { icon: 'settings', color: 'var(--n-500)' },
  '.env': { icon: 'key-round', color: 'var(--opt-yellow)' },
  '.env.example': { icon: 'key-round', color: 'var(--opt-yellow)' },
};
const RETIRED_ICON_EXTENSIONS: Record<string, Look> = {
  ts: { icon: 'file-code', color: 'var(--opt-blue)' },
  tsx: { icon: 'file-code', color: 'var(--opt-blue)' },
  mts: { icon: 'file-code', color: 'var(--opt-blue)' },
  cts: { icon: 'file-code', color: 'var(--opt-blue)' },
  js: { icon: 'file-code', color: 'var(--opt-yellow)' },
  mjs: { icon: 'file-code', color: 'var(--opt-yellow)' },
  cjs: { icon: 'file-code', color: 'var(--opt-yellow)' },
  jsx: { icon: 'file-code', color: 'var(--opt-yellow)' },
  rs: { icon: 'file-code', color: 'var(--opt-orange)' },
  py: { icon: 'file-code', color: 'var(--opt-green)' },
  go: { icon: 'file-code', color: 'var(--opt-green)' },
  rb: { icon: 'file-code', color: 'var(--opt-red)' },
  java: { icon: 'file-code', color: 'var(--opt-orange)' },
  kt: { icon: 'file-code', color: 'var(--opt-purple)' },
  swift: { icon: 'file-code', color: 'var(--opt-orange)' },
  c: { icon: 'file-code', color: 'var(--opt-blue)' },
  h: { icon: 'file-code', color: 'var(--opt-blue)' },
  cpp: { icon: 'file-code', color: 'var(--opt-blue)' },
  hpp: { icon: 'file-code', color: 'var(--opt-blue)' },
  cs: { icon: 'file-code', color: 'var(--opt-purple)' },
  php: { icon: 'file-code', color: 'var(--opt-purple)' },
  lua: { icon: 'file-code', color: 'var(--opt-blue)' },
  sql: { icon: 'database', color: 'var(--opt-yellow)' },
  graphql: { icon: 'share-2', color: 'var(--opt-pink)' },
  gql: { icon: 'share-2', color: 'var(--opt-pink)' },
  json: { icon: 'braces', color: 'var(--opt-yellow)' },
  jsonc: { icon: 'braces', color: 'var(--opt-yellow)' },
  yml: { icon: 'settings', color: 'var(--opt-purple)' },
  yaml: { icon: 'settings', color: 'var(--opt-purple)' },
  toml: { icon: 'settings', color: 'var(--opt-orange)' },
  xml: { icon: 'code', color: 'var(--opt-green)' },
  ini: { icon: 'settings', color: 'var(--n-500)' },
  md: { icon: 'file-text', color: 'var(--opt-blue)' },
  markdown: { icon: 'file-text', color: 'var(--opt-blue)' },
  txt: { icon: 'file-text', color: 'var(--n-500)' },
  pdf: { icon: 'file-type', color: 'var(--opt-red)' },
  css: { icon: 'palette', color: 'var(--opt-blue)' },
  scss: { icon: 'palette', color: 'var(--opt-pink)' },
  html: { icon: 'code', color: 'var(--opt-orange)' },
  vue: { icon: 'file-code', color: 'var(--opt-green)' },
  svelte: { icon: 'file-code', color: 'var(--opt-orange)' },
  sh: { icon: 'terminal', color: 'var(--opt-green)' },
  bash: { icon: 'terminal', color: 'var(--opt-green)' },
  zsh: { icon: 'terminal', color: 'var(--opt-green)' },
  fish: { icon: 'terminal', color: 'var(--opt-green)' },
  png: { icon: 'image', color: 'var(--opt-pink)' },
  jpg: { icon: 'image', color: 'var(--opt-pink)' },
  jpeg: { icon: 'image', color: 'var(--opt-pink)' },
  gif: { icon: 'image', color: 'var(--opt-pink)' },
  svg: { icon: 'image', color: 'var(--opt-green)' },
  webp: { icon: 'image', color: 'var(--opt-pink)' },
  ico: { icon: 'image', color: 'var(--opt-pink)' },
  lock: { icon: 'lock', color: 'var(--opt-yellow)' },
  zip: { icon: 'file-archive', color: 'var(--n-500)' },
  wasm: { icon: 'cpu', color: 'var(--opt-purple)' },
};
const RETIRED_SHIKI_EXTENSIONS: Record<string, string> = {
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
const RETIRED_SHIKI_NAMES: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'make',
  '.gitignore': 'ini',
  '.gitattributes': 'ini',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  '.prettierrc': 'json',
  '.eslintrc': 'json',
};
const RETIRED_CAPTURE = ['md', 'markdown', 'txt', 'text', 'vtt', 'srt'];
const RETIRED_PLAIN: Look = { icon: 'file', color: null };

function retiredLook(name: string): Look {
  const lower = name.toLowerCase();
  const byName = RETIRED_ICON_NAMES[lower];
  if (byName !== undefined) return byName;
  const cut = lower.lastIndexOf('.');
  if (cut <= 0) return RETIRED_PLAIN;
  return RETIRED_ICON_EXTENSIONS[lower.slice(cut + 1)] ?? RETIRED_PLAIN;
}

function retiredLanguage(path: string): string | null {
  const lower = (path.split('/').pop() ?? path).toLowerCase();
  const byName = RETIRED_SHIKI_NAMES[lower];
  if (byName !== undefined) return byName;
  const cut = lower.lastIndexOf('.');
  if (cut <= 0) return null;
  return RETIRED_SHIKI_EXTENSIONS[lower.slice(cut + 1)] ?? null;
}

function retiredCapturable(filename: string): boolean {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return false;
  return RETIRED_CAPTURE.includes(filename.slice(dot + 1).toLowerCase());
}

function retiredMarkdown(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

describe('answers every key the four retired maps answered, the same way', () => {
  const exts = [
    ...new Set([
      ...Object.keys(RETIRED_ICON_EXTENSIONS),
      ...Object.keys(RETIRED_SHIKI_EXTENSIONS),
      ...RETIRED_CAPTURE,
    ]),
  ];
  const names = [
    ...new Set([...Object.keys(RETIRED_ICON_NAMES), ...Object.keys(RETIRED_SHIKI_NAMES)]),
  ];
  // Every key as written, in capitals and under a folder, plus the edges the
  // old code had rules for. A bare `.md` is left out on purpose: the old
  // markdown and capture checks read it as an extension, and extOf, like
  // Rust's ext_of, reads a leading dot as no extension.
  const corpus = [
    ...exts.flatMap((e) => [`x.${e}`, `X.${e.toUpperCase()}`, `dir.d/y.${e}`]),
    ...names.flatMap((n) => [n, n.toUpperCase(), `sub/${n}`]),
    'notes.',
    'no-extension',
    '.unknownrc',
    'notes.xyz',
    'a.rs/b.md',
    'Dockerfile.dev',
  ];

  it('in the tree, the breadcrumb and the tabs (lookFor)', () => {
    // txt was the icon map's only capture kind; text, vtt and srt draw as text
    // and captions now, by design, so the icon check leaves them out.
    const drawn = corpus.filter((name) => !/\.(text|vtt|srt)$/i.test(name));
    for (const name of drawn) {
      const base = name.split('/').pop() as string;
      expect(lookFor(base, false), name).toEqual(retiredLook(base));
    }
  });

  it('in the code viewer (languageFor)', () => {
    for (const name of corpus) expect(languageFor(name), name).toBe(retiredLanguage(name));
  });

  it('in the Inbox and the file viewer', () => {
    for (const name of corpus) {
      const base = name.split('/').pop() as string;
      expect(isCapturable(base), name).toBe(retiredCapturable(base));
      expect(isMarkdownPath(name), name).toBe(retiredMarkdown(name));
    }
  });
});
