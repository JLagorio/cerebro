import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { writeTextFile } from '@/lib/ipc';
import { slugify } from '@/lib/slug';
import { useOpenPath } from '@/app/useOpenPath';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { detectDiagramType } from './detect';
import { claimedByHostEditor } from './keys';
import { StructuralEditor } from './flowchart/StructuralEditor';
import { parseFlowchart } from './flowchart/model';
import { FullScreenDiagramEditor } from './FullScreenDiagramEditor';
import { HighlightedTextarea } from './HighlightedTextarea';
import { MermaidDiagram } from './MermaidDiagram';
import { MermaidLightbox } from './MermaidLightbox';
import { renderMermaid, summarizeRenderError } from './render';
import { useLegibleWidth } from './legibleWidth';
import { useInertDiagramLinks } from './svgLinks';
import { TEMPLATES } from './templates';
import { useDebounced } from './useDebounced';

/** Whichever mode a diagram source would open in, if an edit session started right now. */
function entryMode(source: string): 'visual' | 'code' {
  return parseFlowchart(source) !== null ? 'visual' : 'code';
}

/**
 * Move a block's source out into a standalone `diagrams/<slug>.mmd` (M29.22).
 *
 * Auto-named from the detected diagram type — the backend dedupes with `-2`
 * and returns where it actually landed, and the toast says so; no prompt
 * dialog on purpose. Store-invariant style: catch, toast, never throw.
 */
async function saveAsFile(code: string): Promise<void> {
  const { vaultPath, rescan } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  if (vaultPath === null) return;
  try {
    const type = detectDiagramType(code);
    const slug = slugify(type === 'Mermaid' ? 'diagram' : type) || 'diagram';
    const path = await writeTextFile(vaultPath, `diagrams/${slug}.mmd`, code);
    await rescan();
    toast(`Saved to ${path}`);
  } catch (err) {
    toast(`Couldn't save diagram: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The mermaid block's body (M29.6) — moved out of editor/blocks.tsx so the
 * editor keeps only BlockNote glue. Rendering goes through the shared core;
 * this file owns block chrome and the edit lifecycle. Stage B (M29.9)
 * replaced the textarea-toggle-with-blur-commit with side-by-side live
 * editing; Stage C adds the structural editor. Both land here.
 */
export function MermaidBlockView({
  code,
  onChangeCode,
  onUndo,
  onRedo,
}: {
  code: string;
  onChangeCode: (code: string) => void;
  /**
   * The document's own history, reached explicitly (M29.53).
   *
   * The block never held a history of its own and never should — every visual
   * op flows through `onChangeCode` into BlockNote, which is the undo stack.
   * But BlockNote only answers ⌘Z while its editor has DOM focus, and this
   * block's chrome takes focus away from it: MEASURED, `+ Node` then ⌘Z left
   * the node in the file (activeElement was the button), a rename committed
   * with Enter left focus on BODY and ⌘Z did nothing there either, and even
   * pressing the block's own Done did not restore it. Clicking a paragraph
   * first worked — an undiscoverable extra step. So the block routes the key
   * itself while it is editing, exactly as `useDiagramFile` does for the
   * standalone .mmd canvas.
   */
  onUndo?: () => void;
  onRedo?: () => void;
}) {
  // M29.38 — the link popover's record search and what a link badge opens.
  // `in-place`, not `navigate`: this surface IS the backdrop, and yanking a
  // reader out of the doc they are reading to give a record one would throw
  // that doc away (M9.3).
  const entries = useVaultStore((s) => s.entries);
  const openPath = useOpenPath('in-place');
  /** This block's outermost element — see the key listener below. */
  const blockRef = useRef<HTMLDivElement | null>(null);
  const [editing, setEditing] = useState(false);
  // `draft` only matters in code mode: visual mode renders `code` directly
  // (see the visual pane below) and every op commits through onChangeCode as
  // it happens, so there is never anything uncommitted to hold in state.
  const [draft, setDraft] = useState(code);
  const [lightboxSvg, setLightboxSvg] = useState<string | null>(null);
  const [fullScreen, setFullScreen] = useState(false);
  // Stage C (M29.18): flowcharts get a visual/code toggle; every other
  // diagram type has no structural model to edit, so it never leaves code.
  // `editMode` is LATCHED at each entry point (Edit, template pick, error
  // click, Blank) from whatever source is about to be shown, then never
  // auto-promoted mid-session: code-mode text becoming flowchart-shaped
  // while the user is mid-keystroke must not yank the textarea out from
  // under them (M29.18.1 — the placeholder literally invites typing
  // `graph TD`). Only the explicit toggle button promotes code → visual; the
  // demotion effect below is the one direction this flips on its own, as a
  // safety net for source that stops parsing out from under a visual session.
  const [editMode, setEditMode] = useState<'visual' | 'code'>('visual');
  // The source actually on screen right now: `code` while the visual pane is
  // showing (it never reads `draft`), `draft` while the code pane is.
  const liveSource = editMode === 'visual' ? code : draft;
  const isVisualCapable = parseFlowchart(liveSource) !== null;

  // Safe demotion only: if the visual pane's source stops parsing as a
  // flowchart out from under it (an external edit — undo, another surface —
  // landing mid-session), fall back to code rather than let StructuralEditor
  // show its own "can't edit this as a diagram" placeholder inside what's
  // supposed to be a live editor. Never fires the other direction — that's
  // the toggle button's job, not an effect's.
  useEffect(() => {
    if (editing && editMode === 'visual' && !isVisualCapable) {
      setDraft(code);
      setEditMode('code');
    }
  }, [editing, editMode, isVisualCapable, code]);

  const commit = () => {
    setEditing(false);
    // Only code mode ever holds an uncommitted draft — visual ops already
    // landed through onChangeCode as they happened.
    if (editMode === 'code' && draft !== code) onChangeCode(draft);
  };

  const cancel = () => {
    setDraft(code);
    setEditing(false);
  };

  /**
   * An uncommitted code draft outlives the block, not the session (M29.53).
   *
   * MEASURED: typing a new diagram into the source box and then navigating away
   * — the rail, another doc — lost every byte of it, with no prompt, no dirty
   * chip and no undo entry, because `draft` was component state that only Done,
   * ⌘Enter or the Show-diagram toggle ever committed. The same keystrokes typed
   * into the .mmd page's code panel survive the identical navigation, because
   * that panel flushes on unmount; this was the one code surface with no flush.
   *
   * `useLayoutEffect`, and the distinction is data loss: React runs passive
   * cleanups parent-first, so a passive flush here would arrive after the
   * document page's own unmount save had already read an empty buffer.
   * CodeOverlay carries the same reasoning at greater length.
   */
  const flushRef = useRef({ code, draft, editing, editMode, onChangeCode });
  flushRef.current = { code, draft, editing, editMode, onChangeCode };
  useLayoutEffect(() => {
    return () => {
      const f = flushRef.current;
      if (f.editing && f.editMode === 'code' && f.draft !== f.code) f.onChangeCode(f.draft);
    };
  }, []);

  /**
   * The block's own keyboard while it is editing (M29.53).
   *
   * Escape is documented four lines below as "just exits", and it did not:
   * MEASURED, `document.activeElement` right after pressing Edit is BODY, and
   * after any click inside the pane it is ProseMirror's root — an ANCESTOR of
   * this block, so a React `onKeyDown` on a wrapper div was never on the
   * dispatch path. (Pressing Tab once put focus inside and the same handler
   * worked perfectly, which is how we know it was reachability and not logic.)
   * Code mode escaped correctly only because its textarea holds focus.
   *
   * Capture phase on `document`, one level in from the structural editor's
   * `window` listener, so a selection inside the diagram gets to answer Escape
   * first and this only sees the keystrokes it left alone.
   */
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const block = blockRef.current;
    if (block === null) return;
    const target = e.target instanceof Element ? e.target : null;
    // A text field owns its own keys — the source box (which cancels on
    // Escape itself), the rename box, a link target.
    if (target !== null && target.closest('input, textarea') !== null) return;
    // Another block of the same document can be open at the same time; a key
    // aimed into one of them is not aimed at this one.
    const inBlock = target?.closest('[data-testid="mermaid-block"]') ?? null;
    if (inBlock !== null && inBlock !== block) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (editMode === 'code') cancel();
      else setEditing(false);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) onRedo?.();
      else onUndo?.();
    }
  };
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [editing]);

  return (
    <div
      ref={blockRef}
      data-testid="mermaid-block"
      contentEditable={false}
      className="my-1 w-full rounded-lg border border-n-200 bg-n-0"
    >
      <div className="flex items-center gap-1.5 border-b border-n-100 px-2.5 py-1">
        <Icon name="waypoints" size={13} color="var(--n-500)" />
        <span className="text-xs font-medium uppercase tracking-[0.05em] text-n-500">
          {detectDiagramType(editing ? liveSource : code)}
        </span>
        {editing && isVisualCapable && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (editMode === 'visual') {
                // Entering code mode: seed the textarea from the current
                // source — visual ops commit straight through `code`, so
                // `draft` may be stale, or never touched this session.
                setDraft(code);
                setEditMode('code');
              } else {
                // Entering visual mode: commit whatever's typed so far — the
                // visual pane renders `code` directly, never `draft` — so
                // cmd+z from here on targets real history, not a session
                // with no external trace.
                if (draft !== code) onChangeCode(draft);
                setEditMode('visual');
              }
            }}
            className="rounded-md border-0 bg-transparent px-1.5 py-0.5 text-xs text-n-500 hover:bg-n-50 hover:text-n-800"
          >
            {editMode === 'visual' ? 'Show code' : 'Show diagram'}
          </button>
        )}
        <span className="flex-1" />
        {!editing && code.trim() !== '' && (
          <button
            type="button"
            onClick={() => setFullScreen(true)}
            className="rounded-md border-0 bg-transparent px-1.5 py-0.5 text-xs text-n-500 hover:bg-n-50 hover:text-n-800"
          >
            Open full screen
          </button>
        )}
        {!editing && code.trim() !== '' && (
          <button
            type="button"
            onClick={() => void saveAsFile(code)}
            className="rounded-md border-0 bg-transparent px-1.5 py-0.5 text-xs text-n-500 hover:bg-n-50 hover:text-n-800"
          >
            Save as file…
          </button>
        )}
        <button
          type="button"
          // Without this the textarea blurs FIRST, commit() flips `editing`
          // false, and the click then lands on the (now) "Edit" branch —
          // reopening the source box the button just closed.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (editing) commit();
            else {
              setDraft(code);
              setEditMode(entryMode(code));
              setEditing(true);
            }
          }}
          className="rounded-md border-0 bg-transparent px-1.5 py-0.5 text-xs text-n-500 hover:bg-n-50 hover:text-n-800"
        >
          {editing ? 'Done' : 'Edit'}
        </button>
      </div>

      {editing && editMode === 'visual' && isVisualCapable && (
        /* Escape is handled by the document listener above, not here: nothing
           inside this pane ever holds focus, so a React onKeyDown on this
           wrapper was on an element the keystroke never passed through
           (M29.53). Every visual op has already committed through onChangeCode
           as it happened, so exiting has nothing left to revert. */
        <div>
          {/* Renders the `code` prop directly, never `draft` (M29.18.1 fix):
              visual ops commit immediately through onChangeCode, so the prop
              IS the live state, and an external code change (undo, another
              surface) shows up here with no stale intermediary to fight. */}
          <StructuralEditor
            code={code}
            onChangeCode={onChangeCode}
            entries={entries}
            onOpenPath={openPath}
          />
        </div>
      )}

      {editing && (editMode === 'code' || !isVisualCapable) && (
        <div className="flex flex-wrap">
          <HighlightedTextarea
            autoFocus
            ariaLabel="Mermaid source"
            value={draft}
            placeholder={'graph TD\n  A[Idea] --> B[Shipped]'}
            onChange={setDraft}
            onKeyDown={(e) => {
              // BlockNote hotkeys must not fire while typing in the source box
              // — but the APP's must (⌘K, ⌘J, ⌘⇧L). A blanket stop killed both,
              // because React's synthetic stopPropagation also stops the native
              // event at the React root, where App.tsx's window listener never
              // sees it (MEASURED: document-capture saw ⌘K, window saw nothing).
              if (claimedByHostEditor(e)) e.stopPropagation();
              if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                commit();
              }
            }}
            rows={Math.max(6, draft.split('\n').length + 1)}
          />
          <LivePreview code={draft} />
        </div>
      )}

      {!editing && code.trim() !== '' && (
        /* Double-click is the universal "let me edit this" gesture and the
           block was the one content type in the document that ignored it — the
           only way in was a 34x22px grey text link at the far right of the
           header (M29.53). ProseMirror consumes the event as a node selection,
           so nothing is lost by claiming it. */
        <div
          className="px-3 py-2"
          onDoubleClick={() => {
            setDraft(code);
            setEditMode(entryMode(code));
            setEditing(true);
          }}
        >
          <MermaidDiagram
            code={code}
            onExpand={(svg) => setLightboxSvg(svg)}
            onErrorClick={() => {
              setDraft(code);
              // Forced, not entryMode(code): a broken render has nothing for
              // the visual pane to show even when the header still parses as
              // a flowchart (a bad line just goes opaque, per the model's own
              // rules) — StructuralEditor holds its last-good svg and would
              // open on a blank host (M29.18 defect 4).
              setEditMode('code');
              setEditing(true);
            }}
          />
        </div>
      )}

      {!editing && code.trim() === '' && (
        <div
          data-testid="mermaid-template-grid"
          className="grid grid-cols-2 gap-1.5 p-3 sm:grid-cols-3"
        >
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                const mode = entryMode(t.code);
                setDraft(t.code);
                setEditMode(mode);
                // Picking a template that opens visual IS the first visual
                // op: the pane renders `code`, not `draft` (M29.18.1), and
                // there is no established `code` yet for it to read — an
                // empty block always starts from "" — so commit here, same
                // as every other op committing the instant it happens rather
                // than waiting for Done.
                if (mode === 'visual') onChangeCode(t.code);
                setEditing(true);
              }}
              className="flex items-center gap-2 rounded-md border border-n-200 bg-n-0 px-2.5 py-2 text-left text-sm text-n-700 hover:border-n-300 hover:bg-n-25"
            >
              <Icon name={t.icon} size={14} color="var(--n-500)" />
              {t.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setDraft('');
              setEditMode(entryMode(''));
              setEditing(true);
            }}
            className="flex items-center gap-2 rounded-md border border-dashed border-n-200 bg-transparent px-2.5 py-2 text-left text-sm text-n-500 hover:border-n-300"
          >
            <Icon name="pencil" size={14} color="var(--n-400)" />
            Blank
          </button>
        </div>
      )}

      {lightboxSvg !== null && (
        <MermaidLightbox
          open
          svg={lightboxSvg}
          title="Diagram"
          onClose={() => setLightboxSvg(null)}
        />
      )}

      {fullScreen && (
        /* The block's own onChangeCode is the wire (spec D1): every edit made
           full-screen lands in BlockNote's prop channel, so history gives
           undo and the doc's autosave persists it — no new Selection kind,
           no file, no second save path. */
        <Dialog
          open
          fullscreen
          title={`${detectDiagramType(code)} — full screen`}
          onClose={() => setFullScreen(false)}
        >
          <FullScreenDiagramEditor
            code={code}
            onChangeCode={onChangeCode}
            entries={entries}
            onOpenPath={openPath}
          />
        </Dialog>
      )}
    </div>
  );
}

/**
 * The block's code-pane preview: renders the (debounced) draft, keeps the last
 * good svg when the draft breaks, and names the error's line. Module-private
 * again since M29.27 — DiagramPage was the one outside importer, and its body
 * is now the shared full-screen editor, which renders its own read-only face.
 *
 * The debounce lives HERE, not in the parent: LivePreview mounts fresh at
 * the start of every edit session, so `useDebounced`'s `useState(value)`
 * seed makes its first render current immediately. Hoisting the debounce
 * into MermaidBlockView (M29.9's first cut) let it survive Escape/Done —
 * the debounced value from the closed session was still settling when the
 * next edit session reopened, so the preview briefly showed a stale render
 * for a draft the textarea no longer had.
 */
function LivePreview({ code }: { code: string }) {
  const debounced = useDebounced(code, 250);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; line: number | null } | null>(null);
  // A rendered diagram must not be able to navigate the app away (M29.38).
  // This pane in particular holds the LAST GOOD svg across a broken draft,
  // so the strip has to key off the svg actually on screen rather than the
  // source being typed.
  const svgRef = useInertDiagramLinks<HTMLDivElement>(svg);
  // A wide diagram scrolls rather than shrinking into illegibility (M29.52).
  useLegibleWidth(svgRef, svg);

  useEffect(() => {
    if (debounced.trim() === '') {
      setSvg(null);
      setError(null);
      return;
    }
    let stale = false;
    void renderMermaid(debounced).then((r) => {
      if (stale) return;
      if (r.ok) {
        setSvg(r.svg);
        setError(null);
      } else {
        setError({ message: r.message, line: r.line });
        // svg intentionally untouched: the last good render stays visible.
      }
    });
    return () => {
      stale = true;
    };
  }, [debounced]);

  return (
    <div className="min-w-[260px] flex-1 basis-[280px] border-l border-n-100 px-3 py-2">
      {error !== null && (
        <div
          data-testid="mermaid-edit-error"
          className="mb-1.5 rounded-md bg-danger-50 px-2 py-1 text-xs text-danger-700"
        >
          {error.line !== null ? `Line ${error.line}: ` : ''}
          {summarizeRenderError(error.message, error.line)}
        </div>
      )}
      {svg !== null && (
        <div
          ref={svgRef}
          data-testid="mermaid-live-preview"
          className={`overflow-auto [&>svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full ${error !== null ? 'opacity-60' : ''}`}
          // Safe: strict-mode mermaid output, same as every other sink in
          // this module (MermaidDiagram, MermaidLightbox) — mermaid runs in
          // securityLevel: 'strict', so the svg it returns is sanitized.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      {svg === null && error === null && (
        <div className="py-4 text-center text-xs text-n-400">Preview appears as you type</div>
      )}
    </div>
  );
}
