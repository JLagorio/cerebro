import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { Entry } from '@/engine/types';
import { CanvasViewport } from './CanvasViewport';
import { CodeOverlay } from './CodeOverlay';
import { DiagramToolbar } from './DiagramToolbar';
import type { NodePlacer } from './flowchart/StructuralEditor';
import { StructuralEditor } from './flowchart/StructuralEditor';
import { parseFlowchart } from './flowchart/model';
import { renderMermaid } from './render';
import { useInertDiagramLinks } from './svgLinks';
import { useThemeEpoch } from './useThemeEpoch';

/**
 * The shared full-screen editor (M29.26, spec D1): DiagramToolbar over a
 * CanvasViewport hosting either the structural editor (flowchart-capable) or
 * a read-only render (everything else — the CodeOverlay is the editor then),
 * with the overlay floating over the canvas when open.
 *
 * Mode is LATCHED at mount by the same rule as MermaidBlockView's entryMode:
 * visual iff the source parses as a flowchart. It never auto-promotes — the
 * "Edit visually" toolbar button is the only way up — and the demotion
 * safety net below is the one automatic flip, same as the block's and the
 * page's.
 *
 * This component owns NO persistence. DiagramPage keeps its keyed debounced
 * autosave (M29.23 — the key, the flush refs, and handleChange are load-
 * bearing); the block host commits through BlockNote's prop channel. Both
 * just pass onChangeCode.
 *
 * `embedded` and `overlay` are pinned by spec D1 for Stage H (whiteboard view):
 * this stage implements them as thin pass-throughs — embedded skips nothing yet
 * beyond sizing assumptions, and overlay is forwarded into CanvasViewport's
 * plane — but the props MUST exist and be forwarded from day one so Stage H
 * needs no signature change here.
 */
export function FullScreenDiagramEditor({
  code,
  onChangeCode,
  title,
  // Accepted and deliberately not read yet: `embedded` is the Stage-H forward
  // contract below, and this stage has no sizing branch to hang on it. The
  // `_` prefix is the repo's documented marker for an intentionally unused
  // binding (eslint.config.js) — the PROP keeps its real name for callers.
  embedded: _embedded = false,
  dots = false,
  history,
  placerRef: externalPlacerRef,
  overlay,
  entries,
  onOpenPath,
}: {
  code: string;
  onChangeCode: (code: string) => void;
  title?: string;
  /** Vault entries for the structural editor's link popover (M29.38); pure pass-through. */
  entries?: Entry[];
  /** What a link badge click does — hosts pass useOpenPath('in-place'); pure pass-through. */
  onOpenPath?: (path: string) => void;
  /** Stage-H forward contract (spec D1): fill the given container, assume no page chrome. */
  embedded?: boolean;
  /**
   * Paint the canvas dot grid (M29.52). Pure pass-through to CanvasViewport.
   * The whiteboard asks for it; a diagram FILE does not, because that surface
   * is a document you happen to be able to pan, not a board you arrange on.
   */
  dots?: boolean;
  /** Undo/redo from the host's own file history (M29.52); pure pass-through. */
  history?: { undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean };
  /** Share the editor's node placer, for a host with its own insert action (M29.52). */
  placerRef?: MutableRefObject<NodePlacer | null>;
  /** Spec D1: rendered INSIDE the CanvasViewport plane, so an overlay pans and zooms with
   *  the diagram and can measure in plane units (`useCanvasTransformRef`). The whiteboard's
   *  record chips are the one host using it (M29.47); pure pass-through here. */
  overlay?: React.ReactNode;
}) {
  const flowchartCapable = useMemo(() => parseFlowchart(code) !== null, [code]);
  // Latched from the memo, not re-parsed: both initializers run once, at mount,
  // and `flowchartCapable` is already the answer for the code they would parse.
  const [mode, setMode] = useState<'visual' | 'code'>(() => (flowchartCapable ? 'visual' : 'code'));
  // The overlay IS the editor when the canvas is read-only, so it opens itself there.
  const [showCode, setShowCode] = useState(() => !flowchartCapable);

  // Demotion safety net (parity with MermaidBlockView and DiagramPage):
  // source that stops parsing as a flowchart falls back to the read-only
  // canvas + overlay rather than leaving StructuralEditor holding a model it
  // cannot build. Never the other direction — that is the button's job.
  useEffect(() => {
    if (mode === 'visual' && !flowchartCapable) {
      setMode('code');
      setShowCode(true);
    }
  }, [mode, flowchartCapable]);

  // The read-only face, LivePreview-style: the last good svg stays up while a
  // mid-edit source is broken, and the error names its line in a floating
  // banner OUTSIDE the plane (a banner inside would scale with the zoom).
  const themeEpoch = useThemeEpoch();
  const [view, setView] = useState<{
    svg: string | null;
    error: { message: string; line: number | null } | null;
  }>({ svg: null, error: null });
  useEffect(() => {
    if (mode !== 'code') return;
    let stale = false;
    void renderMermaid(code).then((r) => {
      if (stale) return;
      if (r.ok) setView({ svg: r.svg, error: null });
      else setView((v) => ({ svg: v.svg, error: { message: r.message, line: r.line } }));
    });
    return () => {
      stale = true;
    };
  }, [code, mode, themeEpoch]);
  // A rendered diagram must not be able to navigate the app away (M29.38).
  // The read-only face is only mounted in code mode, so the ref is null the
  // rest of the time — StructuralEditor strips its own svg during binding.
  const readOnlyRef = useInertDiagramLinks<HTMLDivElement>(view.svg);
  /**
   * The toolbar mints nodes; only the editor beside it has measured the canvas
   * well enough to place one. This ref is the whole contract between them —
   * filled while manual mode is on, null otherwise (M29.42 review).
   */
  const ownPlacerRef = useRef<NodePlacer | null>(null);
  // A host that mints nodes of its own (the whiteboard's "Add record") needs
  // the same measured placement the toolbar gets, so it may supply the ref
  // and share one (M29.52). Nobody else passes one; the default is private.
  const placerRef = externalPlacerRef ?? ownPlacerRef;

  return (
    <div data-testid="fullscreen-diagram-editor" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <DiagramToolbar
        code={code}
        onChangeCode={onChangeCode}
        placerRef={placerRef}
        history={history}
        title={title}
        mode={mode}
        showCode={showCode}
        onToggleShowCode={() => setShowCode((s) => !s)}
        onEditVisually={flowchartCapable && mode === 'code' ? () => setMode('visual') : null}
      />
      <div className="relative min-h-0 flex-1">
        <CanvasViewport initialFit dots={dots}>
          {/*
            `&& flowchartCapable`, matching DiagramPage.tsx:232. Demotion below
            is a PASSIVE effect, so a source that stops parsing as a flowchart
            gets one committed, painted frame before it runs — and without this
            guard that frame shows StructuralEditor's "syntax the visual editor
            does not own" fallback inside the zoom plane, and fires a
            renderMermaid for a face about to be replaced. The effect still
            owns the mode flip and the showCode side effect; this just refuses
            to paint the doomed frame.
          */}
          {mode === 'visual' && flowchartCapable ? (
            <StructuralEditor
              code={code}
              onChangeCode={onChangeCode}
              toolbar={false}
              entries={entries}
              onOpenPath={onOpenPath}
              placerRef={placerRef}
            />
          ) : (
            <div
              ref={readOnlyRef}
              data-testid="fullscreen-readonly-diagram"
              // pointer-events-none on the injected svg: CanvasViewport's
              // NO_PAN list exempts g.node/g.edgePaths/g.edgeLabels because the
              // STRUCTURAL editor owns those gestures (drag-to-connect). This
              // face has no node interactions at all, so without this a drag
              // starting on any node — most of the canvas on a dense diagram —
              // would refuse to pan. Purely a hit-testing property: no layout
              // effect, so initialFit still measures the same box. It is NOT
              // what makes a linked node safe, either — pointer-events stops
              // a mouse and nothing else, and an SVG `<a href>` is keyboard
              // focusable; `useInertDiagramLinks` above is what removes the
              // target (M29.38).
              className="p-3 [&_svg]:pointer-events-none [&_svg]:h-auto [&_svg]:max-w-none"
              // Safe: strict-mode mermaid output, the same sanitized sink as
              // MermaidDiagram/MermaidLightbox/LivePreview.
              dangerouslySetInnerHTML={{ __html: view.svg ?? '' }}
            />
          )}
          {/* Stage-H forward contract (spec D1): host overlays live in the plane. */}
          {overlay}
        </CanvasViewport>
        {mode === 'code' && view.error !== null && (
          <div
            data-testid="fullscreen-render-error"
            className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-md bg-danger-50 px-2.5 py-1 text-xs text-danger-700 shadow-sm"
          >
            {view.error.line !== null ? `Line ${view.error.line}: ` : ''}
            {view.error.message.split('\n')[0]}
          </div>
        )}
        {showCode && (
          <CodeOverlay code={code} onChangeCode={onChangeCode} onClose={() => setShowCode(false)} />
        )}
      </div>
    </div>
  );
}
