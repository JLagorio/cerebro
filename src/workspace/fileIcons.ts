/**
 * What a file looks like in the tree (M30.22).
 *
 * VS Code's explorer is legible at a glance because shape and colour carry the
 * file's KIND before you read its name. This is the same idea on Cerebro's
 * terms: lucide glyphs the app already bundles, and DS colour tokens rather
 * than a second palette smuggled in through an icon theme.
 *
 * Files are drawn from `shared/files/kinds.v1.json` (M66.1) through
 * `fileLook`: a filename override, then the extension's row, then the unknown
 * row. Folders stay here, because a folder glyph is not a file kind.
 */

import { fileLook, type KindColor } from '@/engine/fileKinds';

export interface FileLook {
  /** lucide icon name, resolved through `components/ui/Icon`. */
  icon: string;
  /** A DS colour token reference, or null to inherit the row's colour. */
  color: string | null;
}

const FOLDER_OPEN: FileLook = { icon: 'folder-open', color: 'var(--opt-yellow)' };
const FOLDER_CLOSED: FileLook = { icon: 'folder', color: 'var(--opt-yellow)' };

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

  const look = fileLook(name);
  return { icon: look.icon, color: tokenVar(look.color) };
}

/** A table colour as its DS token: `blue` is `var(--opt-blue)`, `n-500` is `var(--n-500)`. */
function tokenVar(color: KindColor | null): string | null {
  if (color === null) return null;
  return color.startsWith('n-') ? `var(--${color})` : `var(--opt-${color})`;
}
