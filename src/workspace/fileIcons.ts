/**
 * What a file looks like in the tree (M30.22).
 *
 * VS Code's explorer is legible at a glance because shape and colour carry the
 * file's KIND before you read its name. This is the same idea on Cerebro's
 * terms: lucide glyphs the app already bundles, and DS colour tokens rather
 * than a second palette smuggled in through an icon theme.
 *
 * Pure and data-driven so the mapping is testable without rendering, and so
 * adding a language is one row rather than a branch.
 */

export interface FileLook {
  /** lucide icon name, resolved through `components/ui/Icon`. */
  icon: string;
  /** A DS colour token reference, or null to inherit the row's colour. */
  color: string | null;
}

const FOLDER_OPEN: FileLook = { icon: 'folder-open', color: 'var(--opt-yellow)' };
const FOLDER_CLOSED: FileLook = { icon: 'folder', color: 'var(--opt-yellow)' };
const PLAIN_FILE: FileLook = { icon: 'file', color: null };

/**
 * Folders whose name means something specific enough to earn its own glyph.
 * Keyed on the exact directory name, lowercased.
 */
const FOLDERS: Record<string, FileLook> = {
  '.github': { icon: 'github', color: 'var(--n-500)' },
  '.git': { icon: 'git-branch', color: 'var(--opt-orange)' },
  '.vscode': { icon: 'code', color: 'var(--opt-blue)' },
  '.husky': { icon: 'dog', color: 'var(--opt-yellow)' },
  node_modules: { icon: 'package', color: 'var(--n-400)' },
  src: { icon: 'folder-code', color: 'var(--opt-blue)' },
  components: { icon: 'component', color: 'var(--opt-green)' },
  hooks: { icon: 'fish', color: 'var(--opt-green)' },
  scripts: { icon: 'terminal', color: 'var(--opt-green)' },
  test: { icon: 'flask-conical', color: 'var(--opt-purple)' },
  tests: { icon: 'flask-conical', color: 'var(--opt-purple)' },
  __tests__: { icon: 'flask-conical', color: 'var(--opt-purple)' },
  e2e: { icon: 'flask-conical', color: 'var(--opt-purple)' },
  docs: { icon: 'book-open', color: 'var(--opt-blue)' },
  assets: { icon: 'image', color: 'var(--opt-pink)' },
  public: { icon: 'globe', color: 'var(--opt-green)' },
  dist: { icon: 'package', color: 'var(--n-400)' },
  build: { icon: 'package', color: 'var(--n-400)' },
  target: { icon: 'package', color: 'var(--n-400)' },
  app: { icon: 'layout-grid', color: 'var(--opt-blue)' },
  lib: { icon: 'library', color: 'var(--opt-blue)' },
  data: { icon: 'database', color: 'var(--opt-yellow)' },
  state: { icon: 'workflow', color: 'var(--opt-purple)' },
  constants: { icon: 'hash', color: 'var(--n-500)' },
};

/** Exact filenames that are more informative than their extension. */
const FILENAMES: Record<string, FileLook> = {
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

/** Extension → look. The long tail; keyed lowercase, no leading dot. */
const EXTENSIONS: Record<string, FileLook> = {
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

/**
 * How to draw one tree row.
 *
 * `plain: true` is the configurable "off" state: one neutral glyph per kind,
 * which is what you want when colour is noise rather than signal.
 */
export function lookFor(
  name: string,
  isDir: boolean,
  options: { expanded?: boolean; plain?: boolean } = {},
): FileLook {
  const { expanded = false, plain = false } = options;

  if (plain) {
    if (isDir) return { icon: expanded ? 'chevron-down' : 'chevron-right', color: null };
    return { icon: 'file-text', color: null };
  }

  const lower = name.toLowerCase();

  if (isDir) {
    const known = FOLDERS[lower];
    if (known !== undefined) return known;
    return expanded ? FOLDER_OPEN : FOLDER_CLOSED;
  }

  const byName = FILENAMES[lower];
  if (byName !== undefined) return byName;

  // A dotfile with no second dot (`.env`) has no extension to read; one with
  // a second dot (`.env.example`) does, and its tail is the useful part.
  const cut = lower.lastIndexOf('.');
  if (cut <= 0) return PLAIN_FILE;
  return EXTENSIONS[lower.slice(cut + 1)] ?? PLAIN_FILE;
}
