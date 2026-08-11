import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { Switch } from '@/components/ui/Switch';
import { HighlightedTextarea } from './HighlightedTextarea';
import { claimedByHostEditor } from './keys';
import { useDebounced } from './useDebounced';

/**
 * The floating code panel (M29.25, spec D1). Auto-Update ON (default): edits
 * flow out through onChangeCode 250ms behind the keystroke — the same cadence
 * LivePreview renders at, so the canvas follows typing without a re-layout per
 * key. OFF: edits buffer locally, a dirty dot appears, and only Apply commits.
 *
 * The panel positions ITSELF as a top-left card and expects to be rendered
 * inside a `relative` box — hosts choose the box, not the offsets.
 *
 * It defends against REACT-level event capture: keydown stops here (the
 * canvas's Delete-deletes-node and BlockNote's hotkeys must not fire while
 * typing source), pointerdown stops here (dragging across the textarea is a
 * selection, not a pan), and data-no-pan covers hosts that check the marker.
 * That defense does NOT reach wheel: CanvasViewport zooms from a NATIVE
 * non-passive wheel listener that calls preventDefault() unconditionally and
 * never consults data-no-pan (CanvasViewport.tsx:131-138), and React's
 * root-delegated handlers run after an element's own native listener. So this
 * panel must be a SIBLING of the viewport, never a descendant — otherwise
 * scrolling this body (or dragging the textarea's resize grip) zooms the
 * canvas instead. Task D3 wires it that way.
 *
 * It owns NO persistence and NO parse opinion — code in, code out.
 */
export function CodeOverlay({
  code,
  onChangeCode,
  onClose,
}: {
  code: string;
  onChangeCode: (code: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(code);
  const [autoUpdate, setAutoUpdate] = useState(true);
  const debounced = useDebounced(draft, 250);
  const dirty = draft !== code;

  // Latest-refs: the commit effect and the unmount flush read through these so
  // neither re-arms per keystroke or per parent render.
  const codeRef = useRef(code);
  codeRef.current = code;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const autoRef = useRef(autoUpdate);
  autoRef.current = autoUpdate;
  const changeRef = useRef(onChangeCode);
  changeRef.current = onChangeCode;

  // An outside edit (a visual op on the canvas, undo, another surface)
  // refreshes an IDLE draft — one equal to the code the panel last saw. A
  // draft holding unsent keystrokes wins until it flows out itself; with
  // Auto-Update on that is at most 250ms later, and the echo of that commit
  // lands here as `code === draft`, clearing dirtiness without a rewrite.
  const lastCode = useRef(code);
  useEffect(() => {
    // Read the previous value into a local BEFORE advancing the ref: an
    // updater that reads lastCode.current is only correct while React's eager
    // fast path runs it inside setDraft. When the fiber has pending lanes it
    // runs at render time instead, by which point the ref would already say
    // `code` and the idle refresh would silently never happen.
    const seen = lastCode.current;
    lastCode.current = code;
    setDraft((d) => (d === seen ? code : d));
  }, [code]);

  // Auto-Update: the settled draft flows out. Also fires when the switch
  // flips ON over a buffered draft — turning Auto-Update on IS consenting to
  // the pending edits.
  useEffect(() => {
    if (autoUpdate && debounced !== codeRef.current) changeRef.current(debounced);
    // codeRef/changeRef are latest-refs, so exhaustive-deps asks for neither
    // and no suppression is needed here. Their point is the dep that ISN'T:
    // `code`. Depping it would re-run this on an EXTERNAL edit while
    // `debounced` still held the older settled draft, re-committing that stale
    // text over the change that just arrived. (The echo of our own commit is
    // harmless either way — `debounced !== codeRef.current` sees them equal
    // and stays quiet.)
  }, [debounced, autoUpdate]);

  // A pending debounce must not die with the panel — DiagramPage's M29.23
  // discipline extended one level down. Keystrokes younger than 250ms at
  // close/navigation time flow out here; the host's own unmount flush (or
  // BlockNote's history) takes it from there. Auto-Update OFF keeps its
  // contract: only Apply commits, closing discards.
  //
  // useLayoutEffect, NOT useEffect, and the distinction is data loss. React
  // runs passive cleanups PARENT-FIRST (measured: parent-layout, child-layout,
  // parent-passive, child-passive). DiagramPage's unmount save is a passive
  // cleanup gated on its own debounce timer being armed (DiagramPage.tsx:152-
  // 157), so with a keystroke younger than 250ms it would read an empty buffer
  // and write nothing — and this flush, arriving after, would call handleChange
  // and arm a fresh 500ms timeout on an already-unmounted component, leaving
  // the user's last bytes owned by an orphan timer that a window close or a
  // torn-down context simply loses. Layout cleanups run in the mutation phase,
  // so child-layout precedes parent-passive and the host still has the bytes
  // when it looks. Pinned by "the flush beats a host's passive-cleanup save".
  useLayoutEffect(() => {
    return () => {
      if (autoRef.current && draftRef.current !== codeRef.current) {
        changeRef.current(draftRef.current);
      }
    };
  }, []);

  return (
    <div
      data-testid="code-overlay"
      data-no-pan
      className="absolute left-3 top-3 z-20 flex max-h-[calc(100%-24px)] w-[340px] flex-col overflow-hidden rounded-lg border border-n-200 bg-n-0 shadow-[var(--shadow-lg)]"
      // Only the keys the surrounding editor would claim (M29.53). The blanket
      // stop this used to be also killed the app's own window-level shortcuts —
      // MEASURED: ⌘K and ⌘J were dead in this panel on the .mmd canvas, where
      // BlockNote is not even mounted, so the guard's stated reason could not
      // apply. React's synthetic stopPropagation stops the native event too.
      onKeyDown={(e) => {
        if (claimedByHostEditor(e)) e.stopPropagation();
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex flex-none items-center gap-2 border-b border-n-100 px-2.5 py-1.5">
        <span className="text-xs font-medium uppercase tracking-[0.05em] text-n-500">Code</span>
        {dirty && !autoUpdate && (
          <span
            data-testid="code-overlay-dirty"
            title="Unapplied edits"
            className="h-1.5 w-1.5 flex-none rounded-full bg-synapse-500"
          />
        )}
        <span className="flex-1" />
        <Switch
          checked={autoUpdate}
          onChange={setAutoUpdate}
          ariaLabel="Auto-update"
          label={<span className="text-xs text-n-500">Auto-update</span>}
        />
        {!autoUpdate && (
          <button
            type="button"
            disabled={!dirty}
            onClick={() => {
              if (dirty) onChangeCode(draft);
            }}
            className="rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-xs text-n-600 hover:bg-n-50 disabled:opacity-45"
          >
            Apply
          </button>
        )}
        <IconButton icon="x" label="Hide code" size="sm" onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <HighlightedTextarea
          ariaLabel="Mermaid source"
          value={draft}
          placeholder={'graph TD\n  A[Idea] --> B[Shipped]'}
          onChange={setDraft}
          rows={Math.max(10, draft.split('\n').length + 1)}
        />
      </div>
    </div>
  );
}
