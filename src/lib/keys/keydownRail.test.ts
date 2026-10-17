import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * App shortcuts go through the keymap (M65.1): one capture-phase listener in
 * `src/lib/keys/root.ts`, dispatching rows of `src/app/commands/`. Every
 * other keydown listener on `window` or `document` is listed here with its
 * count and its reason, so a new shortcut cannot slip in as a raw listener
 * that the palette, the keycaps and Settings never hear about.
 *
 * A new listener that is not a shortcut — an Escape layer, a focus trap, a
 * gesture, an editor's own keys — joins this list with its reason.
 */
const ALLOWED: Record<string, { count: number; reason: string }> = {
  'src/components/ui/Popover.tsx': {
    count: 2,
    reason: 'Escape layer (layers.ts ownsEscape), and the focus trap Tab',
  },
  'src/components/ui/Dialog.tsx': {
    count: 2,
    reason: 'Escape layer, and the focus trap Tab',
  },
  'src/components/ui/DrawerScrim.tsx': {
    count: 1,
    reason: 'Escape layer: the sidebar drawer closes on Escape',
  },
  'src/detail/FieldPopover.tsx': {
    count: 1,
    reason: 'Escape layer: one keystroke dismisses this overlay and nothing behind it',
  },
  'src/detail/DetailPanel.tsx': {
    count: 1,
    reason: "Escape layer: the record peek's own Escape (modal: false)",
  },
  'src/hooks/useDragGesture.ts': {
    count: 1,
    reason: 'gesture: Escape abandons a drag in flight',
  },
  'src/views/CalendarTimeGrid.tsx': {
    count: 1,
    reason: 'Escape layer: cancels the new time-slot draft only while that layer owns Escape',
  },
  'src/components/ui/HoverCard.tsx': {
    count: 1,
    reason: "M59.7: any key that is not the card's own dismisses the hover card",
  },
  'src/mermaid/MermaidBlockView.tsx': {
    count: 1,
    reason:
      "editor-internal: an editing block's Escape, and the ⌘Z its editor claim holds back " +
      'from the keymap when focus sits inside the block or on ProseMirror',
  },
  'src/mermaid/MermaidLightbox.tsx': {
    count: 1,
    reason: 'editor-internal: a modal viewer swallows the keys the editor beneath would act on',
  },
  'src/mermaid/flowchart/StructuralEditor.tsx': {
    count: 1,
    reason: "editor-internal: the canvas selection's Delete and Escape",
  },

  'src/detail/RecordTabs.tsx': {
    count: 2,
    reason: 'raw Escape cancels a tab being added or edited; awaits a layers part (M65 Q2)',
  },
  'src/views/ViewTabs.tsx': {
    count: 1,
    reason: 'raw Escape cancels a view being added; awaits a layers part (M65 Q2)',
  },
  'src/git/InlineDiff.tsx': {
    count: 1,
    reason: 'raw Escape returns from the diff lens; awaits a layers part (M65 Q2)',
  },
};

const LISTENER = /\b(?:window|document)\s*\.\s*addEventListener\(\s*['"]keydown['"]/g;

/** Source with comments blanked, so a docblock that names a listener is not one. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe('the keydown rail (M65.1)', () => {
  it('every keydown listener outside the keymap is listed with a reason', () => {
    const REPO = join(__dirname, '../../..');
    const found: Record<string, number> = {};
    for (const path of sources(join(REPO, 'src'))) {
      const rel = relative(REPO, path).split(sep).join('/');
      if (rel.startsWith('src/lib/keys/')) continue;
      const count = code(readFileSync(path, 'utf8')).match(LISTENER)?.length ?? 0;
      if (count > 0) found[rel] = count;
    }
    const listed = Object.fromEntries(Object.entries(ALLOWED).map(([f, v]) => [f, v.count]));
    expect(found).toEqual(listed);
    for (const { reason } of Object.values(ALLOWED)) expect(reason.length).toBeGreaterThan(10);
  });

  it('the keymap itself owns exactly one', () => {
    const root = code(readFileSync(join(__dirname, 'root.ts'), 'utf8'));
    expect(root.match(LISTENER)).toHaveLength(1);
    expect(root).toContain("window.addEventListener('keydown', onKeyDown, true)");
  });
});

/** No AST can contain a glyph absent from both raw text and Unicode escapes. */
function shortcutLabels(path: string, source: string): number[] {
  if (!/[⌘⇧⌥⌃]|\\u/.test(source)) return [];
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: number[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteralLike(node) ||
        ts.isJsxText(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      /[⌘⇧⌥⌃]/.test(node.text)
    ) {
      found.push(file.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

it('the glyph rail finds literal and Unicode-escaped labels, but not comments', () => {
  expect(shortcutLabels('control.tsx', '<span>⌘K</span>')).toEqual([1]);
  expect(shortcutLabels('control.ts', "const label = '\\u2318K'")).toEqual([1]);
  expect(shortcutLabels('control.ts', "const label = '\\u{2318}K'")).toEqual([1]);
  expect(shortcutLabels('control.ts', '// ⌘K\nconst label = "Search"')).toEqual([]);
  expect(shortcutLabels('control.ts', 'const label = "Search"')).toEqual([]);
});

it('shortcut glyphs in labels come from Keycaps, never a hard-coded string', () => {
  const REPO = join(__dirname, '../../..');
  const found: string[] = [];
  for (const path of sources(join(REPO, 'src'))) {
    const rel = relative(REPO, path).split(sep).join('/');
    if (rel.startsWith('src/lib/keys/') || rel === 'src/components/ui/Keycaps.tsx') continue;
    found.push(...shortcutLabels(path, readFileSync(path, 'utf8')).map((line) => `${rel}:${line}`));
  }
  expect(found).toEqual([]);
});
