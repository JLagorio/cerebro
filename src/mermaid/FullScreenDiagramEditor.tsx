import { useEffect, useMemo, useState } from 'react';
import { CanvasViewport } from './CanvasViewport';
import { CodeOverlay } from './CodeOverlay';
import { DiagramToolbar } from './DiagramToolbar';
import { StructuralEditor } from './flowchart/StructuralEditor';
import { parseFlowchart } from './flowchart/model';
import { renderMermaid } from './render';
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
  overlay,
}: {
  code: string;
  onChangeCode: (code: string) => void;
  title?: string;
  /** Stage-H forward contract (spec D1): fill the given container, assume no page chrome. */
  embedded?: boolean;
  /** Stage-H forward contract (spec D1): rendered INSIDE the CanvasViewport plane, so hosts
   *  can position overlays against useCanvasTransform. Pass-through this stage. */
  overlay?: React.ReactNode;
}) {
  const flowchartCapable = useMemo(() => parseFlowchart(code) !== null, [code]);
  const [mode, setMode] = useState<'visual' | 'code'>(() =>
    parseFlowchart(code) !== null ? 'visual' : 'code',
  );
  // The overlay IS the editor when the canvas is read-only, so it opens itself there.
  const [showCode, setShowCode] = useState(() => parseFlowchart(code) === null);

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

  return (
    <div data-testid="fullscreen-diagram-editor" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <DiagramToolbar
        code={code}
        onChangeCode={onChangeCode}
        title={title}
        mode={mode}
        showCode={showCode}
        onToggleShowCode={() => setShowCode((s) => !s)}
        onEditVisually={flowchartCapable && mode === 'code' ? () => setMode('visual') : null}
      />
      <div className="relative min-h-0 flex-1">
        <CanvasViewport initialFit>
          {mode === 'visual' ? (
            <StructuralEditor code={code} onChangeCode={onChangeCode} toolbar={false} />
          ) : (
            <div
              data-testid="fullscreen-readonly-diagram"
              className="p-3 [&_svg]:h-auto [&_svg]:max-w-none"
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
