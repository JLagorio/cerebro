import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { ANCHOR_MOVED_EVENT } from '@/components/ui/Popover';

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
 * right only for a consumer whose RENDER depends on the live value, and wrong
 * for one that reads the scale inside a handler or a measurement: subscribing
 * re-renders it once per pan frame for a number it never read at render time.
 * This ref's identity never changes, so reading it costs nothing per frame.
 *
 * **Both in-tree overlays read the REF, and this comment used to promise
 * otherwise** — it named Stage H's record chips as the value context's client
 * (M29.26 anticipated them subscribing). They do not, and neither does the
 * structural editor. Every overlay here positions in PLANE units computed as
 * `(elementRect − layerRect) / scale`, and both operands are measured under
 * the same transform, so the quotient is invariant under pan AND zoom: a
 * re-measure on a transform change is arithmetic that cannot come out
 * differently. Measured in Chromium (M29.47 review): a chip sat at
 * dx +4.00 / dy −10.00 at scale 1, at exactly ×1.21 of that after zooming to
 * 1.21, and bit-identically after a 140px pan. The value context stays
 * exported and tested as the seam for an overlay that one day genuinely
 * renders against the live transform; nothing in the tree needs it today.
 *
 * Identity default, same contract as the value context: a consumer outside any
 * viewport reads scale 1 and its divide is a no-op.
 */
const IDENTITY_TRANSFORM_REF: React.RefObject<CanvasTransform> = {
  current: { scale: 1, offset: { x: 0, y: 0 } },
};
const CanvasTransformRefContext =
  createContext<React.RefObject<CanvasTransform>>(IDENTITY_TRANSFORM_REF);

/**
 * The live SCALE alone, as a primitive (M29.51).
 *
 * Overlays that must not zoom with the diagram need the scale AT RENDER TIME,
 * which the ref context deliberately cannot give them. Subscribing to the value
 * context above would work and re-render them once per PAN frame for a number
 * pan never changes; a number-valued context re-renders its consumers only when
 * the number itself moves, so a pan costs nothing and a zoom costs one render.
 *
 * 1 outside any viewport, so `1 / useCanvasScale()` is the identity on the
 * inline block host and every counter-scale below is a no-op there.
 */
const CanvasScaleContext = createContext(1);

/**
 * Move the view without moving the world (M29.53).
 *
 * `growViewBox` extends the svg's viewBox origin when a node is dragged left or
 * up, which slides every OTHER node down-right by the same amount — MEASURED,
 * a (-600, -420) drag left the dragged node exactly where it started and moved
 * its untouched neighbour by (+601, +419), off the canvas entirely. The content
 * is correct in plane space and the PICTURE is what moved, so the answer is a
 * matching pan, not a change to the growth. Outside a viewport there is no pan
 * to give, and this is a no-op.
 */
const CanvasPanContext = createContext<(dx: number, dy: number) => void>(() => {});

/**
 * The element screen-anchored overlays portal into: the viewport itself, i.e.
 * the plane's UNTRANSFORMED parent (M29.51).
 *
 * `absolute left-1/2` inside the plane centres on the PLANE, which is
 * viewport-wide in its own units and then scaled and translated — so at 218%
 * the edge editor, the group bar and the rename box all sat ~700px off the
 * right-hand edge. Worse, they hold the focused control: the browser then
 * scrolled the (overflow-hidden) viewport sideways to reveal them and took the
 * whole diagram off screen with it, unrecoverably — Fit and Reset write the
 * transform, not scrollLeft. Rendering them as children of the viewport instead
 * of the plane fixes the position, the size, and the scroll in one move.
 *
 * null outside any viewport: the inline block host has no separate screen
 * layer, its overlays are already in screen units, and they render in place.
 */
const CanvasOverlayHostContext = createContext<HTMLElement | null>(null);

/** The viewport's current transform — for overlays positioning in plane coordinates. */
export function useCanvasTransform(): CanvasTransform {
  return useContext(CanvasTransformContext);
}

/** The live scale, subscribed to at render time without re-rendering on pan. */
export function useCanvasScale(): number {
  return useContext(CanvasScaleContext);
}

/** Pans the plane by a SCREEN-pixel delta. See CanvasPanContext. */
export function useCanvasPan(): (dx: number, dy: number) => void {
  return useContext(CanvasPanContext);
}

/** Where a screen-anchored overlay portals to, or null when there is no viewport. */
export function useCanvasOverlayHost(): HTMLElement | null {
  return useContext(CanvasOverlayHostContext);
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
 *
 * A node is FOUR classes, not one, and they come from two independent axes:
 * the SHAPE picks the handler (`icon-shape default` for any icon, `image-shape
 * default` for an image) and the LOOK picks the prefix for everything else
 * (`rough-node default` under `look: handDrawn`). Both MEASURED on the bundled
 * mermaid 11.16.0 — see the long note on NODE_GROUP_SELECTOR in
 * flowchart/svgBinding.ts, which this list deliberately mirrors rather than
 * imports: that selector also filters on the flowchart id scheme, which is
 * meaningless here, and this viewport is generic on purpose.
 *
 * With only `g.node`, a connect-drag started on an icon node panned the canvas
 * out from under itself, and in a hand-drawn document EVERY drag did — which is
 * precisely the failure this selector exists to prevent.
 */
const NO_PAN =
  'g.node, g.rough-node, g.icon-shape, g.image-shape, g.edgePaths *, g.edgeLabels *, button, input, textarea, select, [data-no-pan]';

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
/**
 * The dot grid's spacing in PLANE units, and the screen spacing it refuses to
 * go below (M29.52).
 *
 * Dots are drawn on the viewport, not the plane, because a background painted
 * inside a scaled element scales its dots into blobs — so the pattern is
 * re-derived from the transform every frame instead: spacing × scale, offset by
 * the pan. Below MIN_DOT_GAP the dots are closer together than they are wide
 * and the grid turns into grey noise that moires against the pixel grid, so it
 * fades out entirely rather than getting denser.
 */
const DOT_GAP = 24;
const MIN_DOT_GAP = 9;

export function CanvasViewport({
  children,
  initialFit = false,
  dots = false,
  fitInsetLeft = 0,
}: {
  children: React.ReactNode;
  initialFit?: boolean;
  /**
   * Screen pixels along the left edge that a host's own overlay is covering
   * (M29.53). Fit measured the whole viewport and centred in it, so with the
   * code panel open a quarter of a wide diagram landed underneath the panel —
   * MEASURED at 336px of a 1352px diagram, stages 0 through 3 invisible,
   * immediately after the user asked for it to be fitted.
   */
  fitInsetLeft?: number;
  /**
   * Paint the infinite-canvas dot grid (M29.52). On for the whiteboard, which
   * is a place to arrange things; off for a diagram FILE, which is a document
   * that happens to be pannable.
   */
  dots?: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // The same element as a STATE value, because a ref does not re-render the
  // subtree that needs to portal into it. Set once, on mount.
  const [overlayHost, setOverlayHost] = useState<HTMLDivElement | null>(null);
  const planeRef = useRef<HTMLDivElement | null>(null);
  const [t, setT] = useState<CanvasTransform>({ scale: 1, offset: { x: 0, y: 0 } });
  // The ref context's value. Assigned during render, not in an effect: a
  // handler that fires between a pan frame's commit and a passive effect must
  // still read the transform that is already on screen.
  const tRef = useRef<CanvasTransform>(t);
  tRef.current = t;
  const drag = useRef<{
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    /** Whether this gesture has passed the 3px mark and taken pointer capture. */
    captured: boolean;
  } | null>(null);

  const clamp = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

  // Stable identity: a consumer stores this in a ref-held gesture handler.
  const panBy = useCallback((dx: number, dy: number) => {
    if (dx === 0 && dy === 0) return;
    setT((prev) => ({ ...prev, offset: { x: prev.offset.x + dx, y: prev.offset.y + dy } }));
  }, []);

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

  /**
   * `max` caps how far fit is allowed to ENLARGE. The button passes none —
   * "fit" asked for by hand means fill the viewport, at 400% if the diagram is
   * three nodes. The initial fit passes 1: a canvas opens at its natural size
   * unless it is too big to fit, which is what every canvas tool does and what
   * a fresh whiteboard needs, since fitting one empty node clamped it to
   * MAX_SCALE and the first `+ Node` arrived four times life size (M29.51).
   */
  const fitRef = useRef<(max?: number) => void>(() => {});
  fitRef.current = (max = MAX_SCALE) => {
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
      // The free width is what the host has not covered — and the centring
      // starts at the inset, not at zero, so "fit" means "fit into what you
      // can see". Clamped at a quarter of the viewport so a host that reports
      // an absurd inset cannot squeeze the diagram to nothing.
      const inset = Math.max(0, Math.min(fitInsetLeft, vb.width / 2));
      const free = Math.max(vb.width - inset, vb.width / 4);
      const scale = Math.min(max, clamp(Math.min((free - PAD) / w, (vb.height - PAD) / h)));
      return {
        scale,
        offset: {
          x: vb.width - free + (free - w * scale) / 2 - dx * scale,
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

  /**
   * A viewport that changes size keeps showing what it was showing (M29.53).
   *
   * `initialFit` runs once and disconnects, so nothing answered a resize —
   * MEASURED on the whiteboard: opening a record's detail panel halved the
   * canvas (1120px to 560px) and left 0 of 2 nodes inside it, their screen
   * positions unmoved and no re-fit, with closing the panel restoring nothing.
   * The same thing happened to the full-screen dialog on a window resize, where
   * the diagram's visible fraction went 1.000 -> 0.163 -> 0.000.
   *
   * Half the delta, not a re-fit: a re-fit would throw away a zoom and a pan the
   * user chose. Keeping the CENTRE is what a resizing document viewer does, and
   * it needs no opinion about what the user was looking at.
   */
  useEffect(() => {
    const el = viewportRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    let last: { w: number; h: number } | null = null;
    const ro = new ResizeObserver(() => {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return;
      const prev = last;
      last = { w: box.width, h: box.height };
      if (prev === null) return;
      panBy((box.width - prev.w) / 2, (box.height - prev.h) / 2);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [panBy]);

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
      fitRef.current(1);
      ro.disconnect();
    });
    ro.observe(plane);
    return () => ro.disconnect();
  }, [initialFit]);

  /**
   * Tell anything anchored INSIDE the plane that its anchor just moved
   * (M29.53).
   *
   * The plane's pan and zoom are a CSS transform, so an overlay measured
   * against an element in here goes stale without a `resize` and without a
   * `scroll` — the two signals `Popover` was listening for. MEASURED: five
   * wheel steps to 161% moved a node by (-358, -214) and left its shape
   * palette exactly where it was, still open, over an unrelated part of the
   * diagram. The editor's own overlays ride the plane and need nothing; this
   * is for the portalled ones, which cannot.
   *
   * A layout effect, so the re-measure happens in the same frame the transform
   * was painted in rather than one behind it.
   */
  useLayoutEffect(() => {
    window.dispatchEvent(new Event(ANCHOR_MOVED_EVENT));
  }, [t]);

  // The dot grid, re-derived from the live transform (M29.52). Painted as this
  // element's own background rather than as a child, so it costs no node, takes
  // no hit test, and cannot be dragged; `background-position` follows the pan
  // exactly because both are in the same screen pixels.
  const gap = DOT_GAP * t.scale;
  const dotStyle: React.CSSProperties | undefined =
    !dots || gap < MIN_DOT_GAP
      ? undefined
      : {
          // `at 1px 1px` puts the dot's centre one pixel in from the tile's
          // corner, so the pattern's origin lands on the plane's origin rather
          // than half a tile off it.
          backgroundImage:
            'radial-gradient(circle at 1px 1px, var(--canvas-dot) 1px, transparent 0)',
          backgroundSize: `${gap}px ${gap}px`,
          // Modulo the gap, so the numbers stay small at extreme pans instead of
          // growing without bound (Chromium quantises very large background
          // offsets, which shows up as the grid visibly jittering under a drag).
          backgroundPosition: `${t.offset.x % gap}px ${t.offset.y % gap}px`,
        };

  return (
    <CanvasTransformRefContext.Provider value={tRef}>
      <CanvasTransformContext.Provider value={t}>
        <CanvasScaleContext.Provider value={t.scale}>
          <CanvasPanContext.Provider value={panBy}>
            <CanvasOverlayHostContext.Provider value={overlayHost}>
              <div
                ref={(el) => {
                  viewportRef.current = el;
                  setOverlayHost(el);
                }}
                style={dotStyle}
                data-dots={dots ? (gap < MIN_DOT_GAP ? 'faded' : 'on') : undefined}
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
                  // NO capture yet — see onPointerMove (M29.51).
                  drag.current = {
                    startX: e.clientX,
                    startY: e.clientY,
                    baseX: t.offset.x,
                    baseY: t.offset.y,
                    captured: false,
                  };
                }}
                onPointerMove={(e) => {
                  if (drag.current === null) return;
                  const d = drag.current;
                  const dx = e.clientX - d.startX;
                  const dy = e.clientY - d.startY;
                  // Capture on the first real MOVEMENT, never on the press.
                  //
                  // Capture is what lets a fast pan keep receiving moves after the
                  // cursor leaves the viewport, and it is worth having — but while
                  // it is held Chromium retargets the following `click` to the
                  // CAPTURE ELEMENT. Taking it on pointerdown therefore rerouted
                  // every plain click on the canvas to this div, so it never
                  // travelled through the structural editor's subtree and the
                  // editor's "clear the selection" handler never ran: on all three
                  // viewport surfaces, clicking empty canvas simply did not
                  // deselect (measured live — a real click left the node toolbar
                  // up, the same click as a synthetic DOM event cleared it, which
                  // is exactly why no test could tell). Deferring past a 3px
                  // threshold — the same one the editor's own drag uses — gives
                  // both behaviours their due: a click stays a click and reaches
                  // the diagram, a drag captures and pans, and a pan deliberately
                  // does NOT deselect.
                  if (!d.captured && Math.hypot(dx, dy) > 3) {
                    e.currentTarget.setPointerCapture?.(e.pointerId);
                    d.captured = true;
                  }
                  if (!d.captured) return;
                  setT((prev) => ({ ...prev, offset: { x: d.baseX + dx, y: d.baseY + dy } }));
                }}
                onPointerUp={() => {
                  drag.current = null;
                }}
                onPointerCancel={() => {
                  drag.current = null;
                }}
                // `overflow-hidden` stops the USER scrolling; it does not stop the
                // BROWSER. Focusing anything that sits outside the visible box —
                // which, at any scale above 1, is most of a zoomed plane — makes
                // Chromium scroll this element to reveal it, and pan/zoom write the
                // plane's transform, so nothing in the UI can undo it: the diagram
                // simply leaves and Fit will not bring it back. Snapping straight
                // back is the whole fix (M29.51); the overlays that used to trigger
                // it now render outside the plane entirely, so this is the guard for
                // everything else that can take focus in there — link badges, the
                // subgraph toolbar, the node toolbar's own buttons.
                onScroll={(e) => {
                  const el = e.currentTarget;
                  if (el.scrollLeft !== 0) el.scrollLeft = 0;
                  if (el.scrollTop !== 0) el.scrollTop = 0;
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
                    className="rounded border-0 bg-transparent px-1.5 py-0.5 text-xs tabular-nums text-n-600 hover:bg-n-50 focus-visible:outline-none focus-visible:ring"
                    // 100% about the CURRENT view centre — what a percentage chip
                    // means in Figma and in Lucidchart. It used to throw the pan
                    // away with the zoom: MEASURED, a diagram centred at
                    // translate(617.7, 187) jumped to translate(0, 0), i.e. into
                    // the viewport's top-left corner, 680px left and 187px above
                    // where the user was looking (M29.53).
                    onClick={() => zoomBy(1 / t.scale)}
                  >
                    {Math.round(t.scale * 100)}%
                  </button>
                  <IconButton
                    icon="zoom-in"
                    label="Zoom in"
                    size="sm"
                    onClick={() => zoomBy(1.1)}
                  />
                  <IconButton
                    icon="maximize"
                    label="Fit diagram"
                    size="sm"
                    onClick={() => fitRef.current()}
                  />
                </div>
              </div>
            </CanvasOverlayHostContext.Provider>
          </CanvasPanContext.Provider>
        </CanvasScaleContext.Provider>
      </CanvasTransformContext.Provider>
    </CanvasTransformRefContext.Provider>
  );
}
