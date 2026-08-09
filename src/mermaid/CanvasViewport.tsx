import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { IconButton } from '@/components/ui/IconButton';

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 4;

export interface CanvasTransform {
  scale: number;
  offset: { x: number; y: number };
}

/**
 * Identity by default, so overlays hosted OUTSIDE a viewport (the block's
 * inline structural editor) measure in plain screen pixels and a divide by
 * scale is a no-op. No provider-required throw on purpose: the same overlay
 * code runs on both kinds of host.
 */
const CanvasTransformContext = createContext<CanvasTransform>({
  scale: 1,
  offset: { x: 0, y: 0 },
});

/**
 * The same transform, published through a STABLE ref (M29.26).
 *
 * The value context above hands out a fresh object on every `setT`, which is
 * exactly right for an overlay that renders against the live transform (Stage
 * H's record chips) and exactly wrong for a consumer that only reads the scale
 * inside an event handler: subscribing re-rendered it once per pan frame for a
 * value it never read at render time. This ref's identity never changes, so
 * reading it costs nothing per frame.
 *
 * Identity default, same contract as the value context: a consumer outside any
 * viewport reads scale 1 and its divide is a no-op.
 */
const IDENTITY_TRANSFORM_REF: React.RefObject<CanvasTransform> = {
  current: { scale: 1, offset: { x: 0, y: 0 } },
};
const CanvasTransformRefContext =
  createContext<React.RefObject<CanvasTransform>>(IDENTITY_TRANSFORM_REF);

/** The viewport's current transform — for overlays positioning in plane coordinates. */
export function useCanvasTransform(): CanvasTransform {
  return useContext(CanvasTransformContext);
}

/**
 * The viewport's current transform, read on demand and WITHOUT subscribing to
 * it — for consumers that need the scale inside an event handler rather than
 * at render time. Prefer this one; reach for `useCanvasTransform` only when a
 * render genuinely depends on the live value.
 */
export function useCanvasTransformRef(): React.RefObject<CanvasTransform> {
  return useContext(CanvasTransformRefContext);
}

/**
 * Where a pan must never start: diagram nodes and edges (drag-to-connect and
 * click-to-select own those gestures), form controls, and anything that marks
 * itself `data-no-pan` (the zoom cluster; the code overlay defends itself too).
 */
const NO_PAN =
  'g.node, g.edgePaths *, g.edgeLabels *, button, input, textarea, select, [data-no-pan]';

function startsPan(target: EventTarget | null): boolean {
  return !(target instanceof Element) || target.closest(NO_PAN) === null;
}

/**
 * The pan/zoom plane every canvas surface shares (M29.24, spec D2). Dumb on
 * purpose: it knows nothing about mermaid or editing — children render inside
 * ONE transformed div (`canvas-plane`, translate+scale, origin 0 0), pan is a
 * background pointer-drag, zoom is a native wheel listener plus the floating
 * cluster, and the live transform is published through context.
 *
 * MermaidLightbox deliberately does NOT migrate here (spec D2) — it is a
 * read-only viewer with its own settled behavior.
 */
export function CanvasViewport({
  children,
  initialFit = false,
}: {
  children: React.ReactNode;
  initialFit?: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const planeRef = useRef<HTMLDivElement | null>(null);
  const [t, setT] = useState<CanvasTransform>({ scale: 1, offset: { x: 0, y: 0 } });
  // The ref context's value. Assigned during render, not in an effect: a
  // handler that fires between a pan frame's commit and a passive effect must
  // still read the transform that is already on screen.
  const tRef = useRef<CanvasTransform>(t);
  tRef.current = t;
  const drag = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(
    null,
  );

  const clamp = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

  /** Zoom keeping the client point (cx, cy) stationary — cursor-anchored wheel zoom. */
  const zoomAt = (cx: number, cy: number, factor: number) => {
    const box = viewportRef.current?.getBoundingClientRect();
    setT((prev) => {
      const scale = clamp(prev.scale * factor);
      if (scale === prev.scale) return prev;
      const px = cx - (box?.left ?? 0);
      const py = cy - (box?.top ?? 0);
      const k = scale / prev.scale;
      return {
        scale,
        offset: { x: px - (px - prev.offset.x) * k, y: py - (py - prev.offset.y) * k },
      };
    });
  };
  // The wheel listener attaches once (below) but must see the latest closure.
  const zoomAtRef = useRef(zoomAt);
  zoomAtRef.current = zoomAt;

  /** Button zoom anchors at the viewport center (0×0 in jsdom → origin, deterministic). */
  const zoomBy = (factor: number) => {
    const box = viewportRef.current?.getBoundingClientRect();
    zoomAt(
      (box?.left ?? 0) + (box?.width ?? 0) / 2,
      (box?.top ?? 0) + (box?.height ?? 0) / 2,
      factor,
    );
  };

  const fitRef = useRef<() => void>(() => {});
  fitRef.current = () => {
    const viewport = viewportRef.current;
    const plane = planeRef.current;
    // The mermaid svg is the content bbox — the plane itself is viewport-wide,
    // and the ghost-line overlay svg must not be the thing we fit to.
    const content = plane?.querySelector('svg[id^="cerebro-mermaid-"]') ?? null;
    if (viewport === null || plane === null || content === null) return;
    const vb = viewport.getBoundingClientRect();
    const cb = content.getBoundingClientRect();
    const pb = plane.getBoundingClientRect();
    setT((prev) => {
      // Every rect above was measured under the CURRENT transform; divide it out.
      const w = cb.width / prev.scale;
      const h = cb.height / prev.scale;
      if (w === 0 || h === 0 || vb.width === 0 || vb.height === 0) return prev; // jsdom / not rendered yet
      const dx = (cb.left - pb.left) / prev.scale; // content offset inside the plane (editor padding)
      const dy = (cb.top - pb.top) / prev.scale;
      const PAD = 32;
      const scale = clamp(Math.min((vb.width - PAD) / w, (vb.height - PAD) / h));
      return {
        scale,
        offset: {
          x: (vb.width - w * scale) / 2 - dx * scale,
          y: (vb.height - h * scale) / 2 - dy * scale,
        },
      };
    });
  };

  // Native, non-passive: React registers its root wheel listener passive, so a
  // JSX onWheel + preventDefault is silently ignored and the host page scrolls
  // under the zoom (the M29.5 lightbox lesson). `[]` deps are sound HERE —
  // unlike the lightbox, this viewport renders unconditionally, so the ref has
  // its element on the first effect run. If this component ever grows an
  // `open`-style early return, this effect needs the lightbox's dep treatment.
  useEffect(() => {
    const el = viewportRef.current;
    if (el === null) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      zoomAtRef.current(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  // initialFit waits for content: the mermaid svg arrives async (lazy chunk +
  // render), so fitting at mount would measure nothing. A ResizeObserver on
  // the plane fires when the injected svg gives it height; the first
  // measurable content wins, once. jsdom has no ResizeObserver — initialFit is
  // then a no-op, which the tests pin.
  useEffect(() => {
    if (!initialFit) return;
    const plane = planeRef.current;
    if (plane === null || typeof ResizeObserver === 'undefined') return;
    let done = false;
    const ro = new ResizeObserver(() => {
      if (done) return;
      const content = plane.querySelector('svg[id^="cerebro-mermaid-"]');
      if (content === null || content.getBoundingClientRect().width === 0) return;
      done = true;
      fitRef.current();
      ro.disconnect();
    });
    ro.observe(plane);
    return () => ro.disconnect();
  }, [initialFit]);

  return (
    <CanvasTransformRefContext.Provider value={tRef}>
      <CanvasTransformContext.Provider value={t}>
        <div
          ref={viewportRef}
          data-testid="canvas-viewport"
          // `touch-none select-none`: pan is this surface's primary gesture, and
          // pointerdown never calls preventDefault, so without them a background
          // drag across mermaid's label text drag-selects it and smears blue
          // behind the canvas. Every other drag surface in the repo already pairs
          // these (CalendarView.tsx:339,391 · GanttView.tsx:337 ·
          // TimelineView.tsx:272); the resize/grip handles take touch-none alone.
          className="relative h-full w-full touch-none select-none overflow-hidden bg-n-25 cursor-grab active:cursor-grabbing"
          onPointerDown={(e) => {
            if (e.button !== 0 || !startsPan(e.target)) return;
            e.currentTarget.setPointerCapture?.(e.pointerId);
            drag.current = {
              startX: e.clientX,
              startY: e.clientY,
              baseX: t.offset.x,
              baseY: t.offset.y,
            };
          }}
          onPointerMove={(e) => {
            if (drag.current === null) return;
            const d = drag.current;
            setT((prev) => ({
              ...prev,
              offset: { x: d.baseX + (e.clientX - d.startX), y: d.baseY + (e.clientY - d.startY) },
            }));
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          <div
            ref={planeRef}
            data-testid="canvas-plane"
            style={{
              transform: `translate(${t.offset.x}px, ${t.offset.y}px) scale(${t.scale})`,
              transformOrigin: '0 0',
            }}
          >
            {children}
          </div>
          <div
            data-testid="canvas-zoom-controls"
            data-no-pan
            className="absolute bottom-3 left-3 z-10 flex items-center gap-0.5 rounded-md border border-n-200 bg-n-0 px-1 py-0.5 shadow-sm"
          >
            <IconButton
              icon="zoom-out"
              label="Zoom out"
              size="sm"
              onClick={() => zoomBy(1 / 1.1)}
            />
            <button
              type="button"
              aria-label="Reset zoom"
              className="rounded border-0 bg-transparent px-1.5 py-0.5 text-xs tabular-nums text-n-600 hover:bg-n-50"
              onClick={() => setT({ scale: 1, offset: { x: 0, y: 0 } })}
            >
              {Math.round(t.scale * 100)}%
            </button>
            <IconButton icon="zoom-in" label="Zoom in" size="sm" onClick={() => zoomBy(1.1)} />
            <IconButton
              icon="maximize"
              label="Fit diagram"
              size="sm"
              onClick={() => fitRef.current()}
            />
          </div>
        </div>
      </CanvasTransformContext.Provider>
    </CanvasTransformRefContext.Provider>
  );
}
