import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { IconButton } from '@/components/ui/IconButton';
import { useUiStore } from '@/stores/uiStore';
import { copyPng, copySvg, savePng, viewBoxRect } from './export';
import { claimedByHostEditor } from './keys';
import { useInertDiagramLinks } from './svgLinks';

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
/** Breathing room the fit leaves around the diagram, in screen px. */
const FIT_PAD = 24;
/** How much of the diagram a pan must leave on screen, in screen px. */
const KEEP_VISIBLE = 48;

/**
 * Diagram viewer (M29.5): zoom (buttons + wheel), drag-to-pan, copy/export.
 * Receives the already-rendered svg — it never re-renders the diagram, so
 * opening it is instant and cannot fail.
 */
export function MermaidLightbox({
  open,
  svg,
  title,
  onClose,
}: {
  open: boolean;
  svg: string;
  title: string;
  onClose: () => void;
}) {
  const toast = useUiStore((s) => s.toast);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  /**
   * The diagram's own size in svg units, once it is on screen (M29.53).
   *
   * Without it the readout lied: mermaid emits `width="100%"` with an inline
   * `max-width`, so the svg was sized by the CANVAS and the zoom multiplied
   * that — MEASURED, a gantt opened filling 17.3% of the viewer with 6.3px
   * date labels while the control said "100%", and the same "100%" meant
   * natural size for the sequence diagram next to it. Pinning the svg to its
   * viewBox width makes 100% mean 1:1 for every diagram, and makes a fit
   * something that can be computed at all.
   */
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const drag = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(
    null,
  );
  const viewportRef = useRef<HTMLDivElement>(null);
  // A rendered diagram must not be able to navigate the app away (M29.38).
  // `open ? svg : null` for the same reason the wheel effect below depends
  // on `open`: Dialog returns null while closed, so the canvas is destroyed
  // and recreated without this component ever unmounting — an `[svg]`
  // dependency alone would not fire on the reopen that rebuilt it.
  const canvasRef = useInertDiagramLinks<HTMLDivElement>(open ? svg : null);
  /**
   * A STABLE object, and that is load-bearing for the line above (M29.53).
   *
   * React re-runs `dangerouslySetInnerHTML` whenever the prop's object
   * IDENTITY changes, not when its string does — so an inline `{{ __html }}`
   * literal rewrites the subtree on every render and throws away the href
   * strip that ran in the commit before it. Nothing re-rendered this viewer
   * after mount until it grew a fit and a clamped pan, at which point a single
   * pan frame would have brought every link target back to life. MermaidDiagram
   * has always memoized it; this is the same reason.
   */
  const html = useMemo(() => ({ __html: svg }), [svg]);

  const clamp = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

  /**
   * Keeps at least a corner of the diagram on screen (M29.53).
   *
   * MEASURED: one continuous drag put the canvas at (−2135, −1633) against a
   * viewport at (264, 166, 912x540) — an intersection of exactly 0 px², an
   * empty grey box, and no scrollbar or edge hint to say where the diagram had
   * gone. The only way back was a button labelled with the zoom percentage.
   *
   * A zero-sized viewport (jsdom, or before the first layout) clamps nothing:
   * an unmeasurable box must not be read as "everything is off screen".
   */
  const clampOffset = useCallback(
    (o: { x: number; y: number }, s: number): { x: number; y: number } => {
      const box = viewportRef.current?.getBoundingClientRect();
      if (box === undefined || box.width === 0 || natural === null) return o;
      const w = natural.w * s;
      const h = natural.h * s;
      return {
        x: Math.min(box.width - KEEP_VISIBLE, Math.max(KEEP_VISIBLE - w, o.x)),
        y: Math.min(box.height - KEEP_VISIBLE, Math.max(KEEP_VISIBLE - h, o.y)),
      };
    },
    [natural],
  );

  /**
   * Zoom about a fixed client point — the same arithmetic CanvasViewport uses.
   * MEASURED before it: with the pointer parked on an actor box, four wheel
   * steps from 100% to 146% moved that box 287.2px away from the cursor inside
   * a 912x540 viewer.
   */
  const zoomAtRef = useRef<(cx: number, cy: number, factor: number) => void>(() => {});
  zoomAtRef.current = (cx, cy, factor) => {
    const box = viewportRef.current?.getBoundingClientRect();
    const px = cx - (box?.left ?? 0);
    const py = cy - (box?.top ?? 0);
    setScale((prev) => {
      const next = clamp(prev * factor);
      if (next === prev) return prev;
      const k = next / prev;
      setOffset((o) => clampOffset({ x: px - (px - o.x) * k, y: py - (py - o.y) * k }, next));
      return next;
    });
  };

  /** Zoom about the viewer's centre, for the buttons. */
  const zoomBy = (factor: number) => {
    const box = viewportRef.current?.getBoundingClientRect();
    zoomAtRef.current(
      (box?.left ?? 0) + (box?.width ?? 0) / 2,
      (box?.top ?? 0) + (box?.height ?? 0) / 2,
      factor,
    );
  };

  /** Fill the viewer with the diagram, centred. `max` caps the enlargement. */
  const fitTo = useCallback(
    (size: { w: number; h: number } | null, max = MAX_SCALE) => {
      const box = viewportRef.current?.getBoundingClientRect();
      if (box === undefined || box.width === 0 || size === null || size.w === 0) return;
      const s = Math.min(
        max,
        clamp(Math.min((box.width - FIT_PAD) / size.w, (box.height - FIT_PAD) / size.h)),
      );
      setScale(s);
      setOffset({ x: (box.width - size.w * s) / 2, y: (box.height - size.h * s) / 2 });
    },
    // `clamp` is a pure local over module constants and `viewportRef` is a ref,
    // so this callback genuinely closes over nothing that can change.
    [],
  );

  /**
   * Pin the injected svg to its own intrinsic size, then open on a fit.
   *
   * Keyed on `open ? svg : null` for the same reason the wheel effect below
   * depends on `open`: Dialog returns null while closed, so the canvas is
   * destroyed and recreated without this component unmounting.
   */
  useEffect(() => {
    if (!open) {
      setNatural(null);
      return;
    }
    const el = canvasRef.current?.querySelector('svg');
    if (el === null || el === undefined) return;
    const box = viewBoxRect(svg);
    if (box.width === 0 || box.height === 0) return;
    el.style.width = `${box.width}px`;
    el.style.height = 'auto';
    el.style.maxWidth = 'none';
    const size = { w: box.width, h: box.height };
    setNatural(size);
    // `1` as the cap: a small diagram opens at life size rather than blown up
    // to fill the viewer, which is what every canvas tool does — and a big one
    // still shrinks to fit instead of opening 83% off screen.
    fitTo(size, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- canvasRef is a stable ref; re-running on it would be re-running on nothing.
  }, [open, svg, fitTo]);

  /**
   * A modal viewer swallows the keys the editor underneath it would act on
   * (M29.53).
   *
   * This Dialog renders IN PLACE, inside BlockNote's contenteditable, and the
   * block carries a ProseMirror NodeSelection from the click that opened the
   * viewer. MEASURED: one printable keystroke — 'a', '=', Backspace — with
   * focus on the Close button typed OVER the selected node and took the whole
   * mermaid block out of the document, 842 bytes and four fences down to 653
   * and three, one block per keystroke, carrying the heading after it away too.
   *
   * Document capture, because the key that did the damage was aimed at the
   * DIALOG'S OWN chrome, which is not inside this component's subtree. Escape
   * is deliberately let through — it is the Dialog's, and closing is the right
   * answer to it. Native button activation is a default action, not a
   * propagation, so Enter and Space still press what they are on.
   */
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && claimedByHostEditor(e)) e.stopPropagation();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  // React registers its root wheel listener passive, so a JSX `onWheel` +
  // `e.preventDefault()` is silently ignored and the Dialog body scrolls
  // under the zoom. A native listener opted out of passive mode, attached
  // directly to the viewport, is the only way to actually stop it (code
  // review, M29.5). `open` is a dep, not just a guard: Dialog returns null
  // while closed, so the viewport doesn't exist at mount — a caller that
  // mounts with `open={false}` and flips it true later needs this effect to
  // run again once the ref actually has something to attach to (re-review).
  useEffect(() => {
    const el = viewportRef.current;
    if (el === null) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      zoomAtRef.current(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [open]);

  // `savePng` resolves `null` on a user cancel (the Rust side returns
  // Ok(None)) — that is not a failure, but it is not a success either, so it
  // gets no toast at all. The copy actions always resolve (undefined),
  // which is `!== null`, so they keep toasting unconditionally.
  const act = (success: string, failure: string, run: () => Promise<unknown>) => {
    void run()
      .then((result) => {
        if (result !== null) toast(success);
      })
      .catch(() => toast(failure));
  };

  return (
    <Dialog open={open} onClose={onClose} title={title} width={960}>
      <>
        <div className="mb-2 flex items-center gap-1.5">
          <IconButton icon="zoom-out" label="Zoom out" onClick={() => zoomBy(1 / 1.1)} />
          {/* Button has no aria-label passthrough, and this control's visible
            text ("100%") is not its accessible name ("Reset zoom") — a plain
            button reusing Button's own classes covers both. */}
          <button
            type="button"
            aria-label="Reset zoom"
            className="cb-btn cb-btn-md cb-btn-ghost"
            // 100% about the view centre, now that 100% means 1:1 with the
            // diagram's own units rather than "whatever the canvas made it".
            onClick={() => zoomBy(1 / scale)}
          >
            {Math.round(scale * 100)}%
          </button>
          <IconButton icon="zoom-in" label="Zoom in" onClick={() => zoomBy(1.1)} />
          <IconButton icon="maximize" label="Fit diagram" onClick={() => fitTo(natural)} />
          <span className="flex-1" />
          <Button
            variant="secondary"
            onClick={() => act('SVG copied', 'Copy SVG failed', () => copySvg(svg))}
          >
            Copy SVG
          </Button>
          <Button
            variant="secondary"
            onClick={() => act('PNG copied', 'Copy PNG failed', () => copyPng(svg))}
          >
            Copy PNG
          </Button>
          <Button
            variant="secondary"
            onClick={() => act('PNG saved', 'Save PNG failed', () => savePng(svg, 'diagram.png'))}
          >
            Save PNG…
          </Button>
        </div>
        <div
          ref={viewportRef}
          data-testid="lightbox-viewport"
          className="relative h-[60vh] cursor-grab overflow-hidden rounded-lg border border-n-200 bg-n-25 active:cursor-grabbing"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture?.(e.pointerId);
            drag.current = {
              startX: e.clientX,
              startY: e.clientY,
              baseX: offset.x,
              baseY: offset.y,
            };
          }}
          onPointerMove={(e) => {
            if (drag.current === null) return;
            setOffset(
              clampOffset(
                {
                  x: drag.current.baseX + (e.clientX - drag.current.startX),
                  y: drag.current.baseY + (e.clientY - drag.current.startY),
                },
                scale,
              ),
            );
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          <div
            ref={canvasRef}
            data-testid="lightbox-canvas"
            className="[&_svg]:h-auto [&_svg]:max-w-none"
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              transformOrigin: '0 0',
            }}
            // Safe: same strict-mode mermaid output the inline view showed.
            dangerouslySetInnerHTML={html}
          />
        </div>
      </>
    </Dialog>
  );
}
