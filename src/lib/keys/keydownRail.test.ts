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
  'src/app/CreateMenu.tsx': {
    count: 1,
    reason: 'raw Escape and arrow keys of the New menu; goes with M65.5 (M65 Q2)',
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
  'src/editor/NoteBodyEditor.tsx': {
    count: 1,
    reason: '⌘S flushes the save debounce; joins the keymap as page.save in M65.1b',
  },
  'src/editor/FindBar.tsx': {
    count: 1,
    reason: 'M59.6 ⌘F, ⌥⌘F and ⌘G; join the keymap as the find rows in M65.1b',
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
