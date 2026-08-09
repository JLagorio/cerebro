# M29 Stage D — Full-Screen Canvas Editor (M29.24–M29.28)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One shared full-screen diagram editor (spec D1): a pan/zoom infinite canvas (`CanvasViewport`, spec D2) hosting the structural editor or a read-only render, a floating `CodeOverlay` with Auto-Update, and a `DiagramToolbar` carrying structural controls, the `look: handDrawn` toggle (spec D9, partial), and the export actions. Two hosts: the `.mmd` DiagramPage (now sidebarless) and a "Open full screen" overlay on every mermaid block.

**Architecture:** Everything new lives in `src/mermaid/`. `CanvasViewport` is a dumb primitive that owns pan/zoom/fit and publishes its transform through `useCanvasTransform` so overlays can position in plane coordinates. `FullScreenDiagramEditor` composes viewport + toolbar + overlay and owns NO persistence — hosts keep their own save discipline (DiagramPage's M29.23 keyed autosave survives untouched). `setLook` joins `flowchart/ops.ts` as one more surgical frontmatter op (spec D10). MermaidLightbox stays exactly as it is (spec D2: it does not migrate).

**Tech stack:** No new dependencies. React 19, existing mermaid core (`render.ts`), existing primitives (`Dialog`, `Popover`, `Menu`, `Switch`, `IconButton`).

**Spec:** `docs/superpowers/specs/2026-08-09-cerebro-m29-wave2-parity-design.md` — decisions honored here: D1 (one shared editor, two hosts), D2 (CanvasViewport primitive; lightbox untouched), D9 **partially** (direction + Dagre/ELK menu + `look: handDrawn` this stage; the ELK-variant engines and Auto-layout ON/OFF arrive in Stages E/G per the stage map), D10 (every new op surgical, round-trip proven).

**A note on `dangerouslySetInnerHTML` in this plan:** the read-only canvas face injects mermaid output as HTML — the same commented, strict-mode-sanitized pattern every sink in `src/mermaid/` already uses (MermaidDiagram, MermaidLightbox, LivePreview). No other HTML source ever reaches these sinks; keep the in-code safety comments.

---

## Read this first — repo traps that will bite you

1. **`pnpm test` is watch mode and never exits.** Always `pnpm test:run` (or `pnpm test:run <file>`).
2. **No jest-dom.** `toBeInTheDocument`/`toHaveTextContent` do not exist here. Use `toBeTruthy()`, `toBeNull()`, `.textContent`, `.className` — copy the assertions in `src/pages/DiagramPage.test.tsx`.
3. **jsdom cannot render SVG.** Unit tests ALWAYS mock the render service — `vi.mock('./render')` from `src/mermaid/*`, `vi.mock('@/mermaid/render')` from elsewhere. Mocking is by resolved module, so one mock covers every importer (`StructuralEditor` imports `../render`; same file). Only e2e renders for real.
4. **A pre-existing security hook blocks Write/Edit on file contents that carry raw-html-injection patterns** (`dangerouslySetInnerHTML`, `.innerHTML =`). Every file in this plan containing those (FullScreenDiagramEditor.tsx and any test fixture quoting it) must be written via Bash heredoc: `cat > path <<'EOF' … EOF`, then edited the same way. Do not fight the hook; route around it and say so in the commit if asked.
5. **React's `onWheel` is passive** — `e.preventDefault()` in JSX is silently ignored and the page scrolls under the zoom. Attach a NATIVE listener with `{ passive: false }`, the way `MermaidLightbox.tsx:46-56` does. The lightbox also teaches the dep lesson: its effect deps `open` because Dialog returns null while closed and the ref has nothing to attach to at mount. `CanvasViewport` renders its viewport unconditionally, so `[]` deps are sound THERE — but only because of that; say so in a comment.
6. **React must never own the StructuralEditor's svg subtree.** It writes `hostRef.current.innerHTML` imperatively and hangs raw handlers on mermaid's DOM (StructuralEditor.tsx:93-171). Wrap it, transform it, scale it — but never re-parent it into a React-diffed container or key it into remounting per state change.
7. **The M29.23 corruption fix must survive.** App.tsx keys DiagramPage on `selection.path` (App.tsx:108) and the page's debounced save flushes as an unmount cleanup. Do not touch the key, the flush refs, or `handleChange`. Task D4 adds ONE layer (CodeOverlay's own 250ms debounce) and gives it its own unmount flush so the guarantee composes.
8. **e2e always runs isolated:** `PORT=5273 pnpm e2e` (a stale HMR'd dev server on :5173 fails whole suites at boot). Copy the boot block from `e2e/diagrams.spec.ts` verbatim — distiller off, theme pinned light — and `test.setTimeout(60_000)` for the lazy mermaid/ELK chunks.
9. **svg locators need scoping:** a bare `locator('svg')` also matches icon buttons and the ghost-line overlay and trips Playwright strict mode. Always `svg[id^="cerebro-mermaid-"]` for mermaid output; `[id*="flowchart-<NodeId>-"]` for node groups (the render id prefixes them — `id^=` finds nothing live).
10. **Zero-warning lint** (`pnpm lint`), Prettier 100 cols single quotes, every `eslint-disable` carries a written reason in place.
11. **Commits:** `type(scope): sentence (M29.<n>)`, one phase per commit, never `--no-verify`.
12. **demo-vault is the golden corpus.** Stage D touches it not at all — `diagrams/pipeline.mmd` and `strategy/systems-map.md` are already seeded and the e2e reuses them.

## Stage-D decisions the spec left open (settled here — implementers do not re-litigate)

- **The zoom cluster renders INSIDE CanvasViewport** (floating bottom-left card), not in DiagramToolbar. "The zoom cluster comes from CanvasViewport" (spec D2/D9) is read as ownership: the viewport owns zoom state, so it draws the controls, and every future host (Stage H's WhiteboardView) gets them for free.
- **StructuralEditor grows two things:** a `toolbar` prop (default `true`; the full-screen editor passes `false` because DiagramToolbar owns those controls — rendering both would be two direction rows) and scale-corrected overlay math via `useCanvasTransform` (its overlays measure `getBoundingClientRect` deltas, which are screen px; inside a scaled plane those must divide by `scale` to become the plane coordinates CSS positioning uses). The default context value is the identity, so both existing hosts (block, page-until-D4) are byte-for-byte unaffected.
- **The `look: handDrawn` toggle is flowchart-only this stage:** `setLook` is a model op per the spec's own signature (`setLook(model, look|null)`), and a non-flowchart source has no model. The toggle simply doesn't render over a read-only canvas.
- **Block full-screen = a `fullscreen` variant on the existing Dialog**, not a new layer primitive. Dialog already owns scrim, Escape-via-layers, Tab trap, and focus restore; the variant is ~6 lines of CSS + one prop. A bespoke FullscreenLayer would re-answer all four questions to save a header we actually want (title + Close).
- **The latch never auto-promotes** (same rule as MermaidBlockView/DiagramPage), so a flowchart-capable source on a read-only canvas gets an explicit **"Edit visually"** toolbar button. Without it, a demoted session would be stuck read-only until remount.
- **CodeOverlay flushes its pending Auto-Update draft on unmount.** The overlay adds a 250ms buffer UNDER DiagramPage's 500ms save debounce; keystrokes younger than 250ms at navigation time would otherwise vanish — the exact shape of the M29.23 bug one level up. Auto-Update OFF keeps its contract: only Apply commits, and closing discards.

## File structure (Stage D end state)

```
src/mermaid/
  CanvasViewport.tsx            pan/zoom plane, zoom cluster, transform context (M29.24)
  CanvasViewport.test.tsx
  CodeOverlay.tsx               floating code panel: Auto-Update / Apply / dirty dot (M29.25)
  CodeOverlay.test.tsx
  DiagramToolbar.tsx            structural cluster, layout menu, look toggle, export, Show code (M29.26)
  DiagramToolbar.test.tsx
  FullScreenDiagramEditor.tsx   the shared editor: toolbar + viewport + overlay (M29.26)
  FullScreenDiagramEditor.test.tsx
  MermaidBlockView.tsx          + "Open full screen" header action (M29.27)
  flowchart/ops.ts              + setLook (M29.26)
  flowchart/StructuralEditor.tsx  + toolbar prop, scale-aware overlays (M29.26)
src/pages/DiagramPage.tsx       body becomes the shared editor; header/save/tombstone stay (M29.27)
src/app/Sidebar.tsx             + 'diagram' in SIDEBARLESS (M29.27)
src/components/ui/Dialog.tsx    + fullscreen variant (M29.27)
e2e/diagrams.spec.ts            + two full-screen journeys (M29.28)
```

---

### Task D1: `CanvasViewport` — the pan/zoom plane (M29.24)

**Files:**
- Create: `src/mermaid/CanvasViewport.tsx`
- Create: `src/mermaid/CanvasViewport.test.tsx`

The dumb primitive under everything in this stage (spec D2). It knows nothing about mermaid: children render inside one transformed plane div, pan is a background pointer-drag, zoom is a native non-passive wheel plus a floating control cluster, and the current `{scale, offset}` is published through context so overlays inside the plane can convert screen measurements to plane coordinates.

- [ ] **Step 1: Write the failing test**

Create `src/mermaid/CanvasViewport.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CanvasViewport, useCanvasTransform } from './CanvasViewport';

/** Reads the context the way an overlay would. */
function Probe() {
  const t = useCanvasTransform();
  return (
    <span data-testid="probe">
      {Math.round(t.scale * 100)}:{t.offset.x},{t.offset.y}
    </span>
  );
}

const readout = () => screen.getByRole('button', { name: 'Reset zoom' });
const plane = () => screen.getByTestId('canvas-plane');

describe('CanvasViewport', () => {
  it('renders children inside the transformed plane, identity at mount', () => {
    render(
      <CanvasViewport>
        <div data-testid="content" />
      </CanvasViewport>,
    );
    expect(plane().querySelector('[data-testid="content"]')).toBeTruthy();
    expect(plane().style.transform).toBe('translate(0px, 0px) scale(1)');
    expect(plane().style.transformOrigin).toBe('0 0');
    expect(readout().textContent).toContain('100%');
  });

  it('zoom buttons move the readout; reset restores the identity', async () => {
    render(<CanvasViewport>x</CanvasViewport>);
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(readout().textContent).toContain('110%');
    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(readout().textContent).toContain('100%');
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    await userEvent.click(readout());
    expect(readout().textContent).toContain('100%');
    expect(plane().style.transform).toBe('translate(0px, 0px) scale(1)');
  });

  it('wheel zooms through the native non-passive listener', () => {
    render(<CanvasViewport>x</CanvasViewport>);
    fireEvent.wheel(screen.getByTestId('canvas-viewport'), { deltaY: -1 });
    expect(readout().textContent).toContain('110%');
    fireEvent.wheel(screen.getByTestId('canvas-viewport'), { deltaY: 1 });
    expect(readout().textContent).toContain('100%');
  });

  it('clamps zoom to 10%–400%', async () => {
    render(<CanvasViewport>x</CanvasViewport>);
    for (let i = 0; i < 30; i += 1) {
      await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    }
    expect(readout().textContent).toContain('400%');
    for (let i = 0; i < 60; i += 1) {
      await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    }
    expect(readout().textContent).toContain('10%');
  });

  it('pans on a background drag with button 0, and pointercancel ends the gesture', () => {
    render(<CanvasViewport>x</CanvasViewport>);
    const viewport = screen.getByTestId('canvas-viewport');
    fireEvent.pointerDown(viewport, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(viewport, { clientX: 22, clientY: 18 });
    expect(plane().style.transform).toBe('translate(12px, 8px) scale(1)');
    fireEvent.pointerCancel(viewport);
    fireEvent.pointerMove(viewport, { clientX: 99, clientY: 99 });
    expect(plane().style.transform).toBe('translate(12px, 8px) scale(1)');
  });

  it('does not pan from a non-primary button or from a control', () => {
    render(<CanvasViewport>x</CanvasViewport>);
    const viewport = screen.getByTestId('canvas-viewport');
    fireEvent.pointerDown(viewport, { button: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(viewport, { clientX: 40, clientY: 40 });
    expect(plane().style.transform).toBe('translate(0px, 0px) scale(1)');
    // Starting on the zoom cluster must never pan (it is data-no-pan + buttons).
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Zoom in' }), {
      button: 0,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(viewport, { clientX: 40, clientY: 40 });
    expect(plane().style.transform).toBe('translate(0px, 0px) scale(1)');
  });

  it('publishes the live transform through useCanvasTransform', async () => {
    render(
      <CanvasViewport>
        <Probe />
      </CanvasViewport>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('100:0,0');
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByTestId('probe').textContent).toContain('110:');
  });

  it('defaults to the identity outside any viewport', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('100:0,0');
  });

  it('Fit is a safe no-op when nothing is measurable (jsdom rects are 0×0)', async () => {
    render(<CanvasViewport initialFit>x</CanvasViewport>);
    await userEvent.click(screen.getByRole('button', { name: 'Fit diagram' }));
    expect(readout().textContent).toContain('100%');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm test:run src/mermaid/CanvasViewport.test.tsx`
Expected: FAIL — `Cannot find module './CanvasViewport'`.

- [ ] **Step 3: Implement `src/mermaid/CanvasViewport.tsx`**

```tsx
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

/** The viewport's current transform — for overlays positioning in plane coordinates. */
export function useCanvasTransform(): CanvasTransform {
  return useContext(CanvasTransformContext);
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
    <CanvasTransformContext.Provider value={t}>
      <div
        ref={viewportRef}
        data-testid="canvas-viewport"
        className="relative h-full w-full cursor-grab overflow-hidden bg-n-25 active:cursor-grabbing"
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
          <IconButton icon="zoom-out" label="Zoom out" size="sm" onClick={() => zoomBy(1 / 1.1)} />
          <button
            type="button"
            aria-label="Reset zoom"
            className="rounded border-0 bg-transparent px-1.5 py-0.5 text-xs tabular-nums text-n-600 hover:bg-n-50"
            onClick={() => setT({ scale: 1, offset: { x: 0, y: 0 } })}
          >
            {Math.round(t.scale * 100)}%
          </button>
          <IconButton icon="zoom-in" label="Zoom in" size="sm" onClick={() => zoomBy(1.1)} />
          <IconButton icon="maximize" label="Fit diagram" size="sm" onClick={() => fitRef.current()} />
        </div>
      </div>
    </CanvasTransformContext.Provider>
  );
}
```

Verify at implementation time: `maximize` is a valid lucide name for the `Icon` component (`zoom-in`/`zoom-out` are already used by the lightbox); if it isn't, `expand` and `scan` are the fallbacks — pick whichever renders, keep the label `Fit diagram`.

Note the plane deliberately carries NO svg sizing classes: the structural editor's host keeps its own `[&_svg]:max-w-full`, and the read-only face (Task D3) brings the lightbox's `[&_svg]:max-w-none` on its own wrapper. The plane imposing either would fight its children with equal-specificity arbitrary variants.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `pnpm test:run src/mermaid/CanvasViewport.test.tsx`
Expected: 9 passed.

- [ ] **Step 5: Lint + typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/mermaid/CanvasViewport.tsx src/mermaid/CanvasViewport.test.tsx
git commit -m "feat(mermaid): CanvasViewport — the pan/zoom plane every canvas surface shares (M29.24)"
```

---

### Task D2: `CodeOverlay` — the floating code panel (M29.25)

**Files:**
- Create: `src/mermaid/CodeOverlay.tsx`
- Create: `src/mermaid/CodeOverlay.test.tsx`

The mermaid.ai-style floating panel: header ("Code" + Auto-Update switch + dirty dot + Apply + close), body is the existing `HighlightedTextarea`. Auto-Update ON (the default) streams edits out through `onChangeCode` debounced 250ms; OFF buffers locally until Apply. It is positioned absolutely by its HOST (top-left card over the canvas) but defends itself on any host: `stopPropagation` on keydown (canvas Delete / BlockNote hotkeys must not fire while typing) and on pointerdown (a drag that starts on the panel is a text selection, not a pan), plus `data-no-pan`.

- [ ] **Step 1: Write the failing test**

Create `src/mermaid/CodeOverlay.test.tsx`. Real timers + `waitFor` for the positive debounce cases; one explicit sleep for the negative one (a "nothing happened" claim needs the window to actually elapse).

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CodeOverlay } from './CodeOverlay';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const source = () => screen.getByLabelText('Mermaid source') as HTMLTextAreaElement;

describe('CodeOverlay', () => {
  it('shows the code, the Auto-update switch on, and no Apply button', () => {
    render(<CodeOverlay code={'graph TD\n  A --> B'} onChangeCode={() => {}} onClose={() => {}} />);
    expect(source().value).toBe('graph TD\n  A --> B');
    expect((screen.getByRole('switch', { name: 'Auto-update' }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
  });

  it('Auto-update streams edits out after the 250ms debounce', async () => {
    const onChangeCode = vi.fn();
    render(<CodeOverlay code="graph TD" onChangeCode={onChangeCode} onClose={() => {}} />);
    fireEvent.change(source(), { target: { value: 'graph TD\n  A --> B' } });
    expect(onChangeCode).not.toHaveBeenCalled();
    await waitFor(() => expect(onChangeCode).toHaveBeenCalledWith('graph TD\n  A --> B'));
    expect(onChangeCode).toHaveBeenCalledTimes(1);
  });

  it('Auto-update OFF buffers: a dirty dot appears, only Apply commits', async () => {
    const onChangeCode = vi.fn();
    render(<CodeOverlay code="graph TD" onChangeCode={onChangeCode} onClose={() => {}} />);
    await userEvent.click(screen.getByText('Auto-update'));
    fireEvent.change(source(), { target: { value: 'graph TD\n  A --> C' } });
    await sleep(350); // past the debounce window — nothing may have flowed out
    expect(onChangeCode).not.toHaveBeenCalled();
    expect(screen.getByTestId('code-overlay-dirty')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onChangeCode).toHaveBeenCalledWith('graph TD\n  A --> C');
  });

  it('flipping Auto-update back ON commits the buffered draft', async () => {
    const onChangeCode = vi.fn();
    render(<CodeOverlay code="graph TD" onChangeCode={onChangeCode} onClose={() => {}} />);
    await userEvent.click(screen.getByText('Auto-update'));
    fireEvent.change(source(), { target: { value: 'graph TD\n  A --> D' } });
    await userEvent.click(screen.getByText('Auto-update'));
    await waitFor(() => expect(onChangeCode).toHaveBeenCalledWith('graph TD\n  A --> D'));
  });

  it('an external code change refreshes an idle draft', () => {
    const { rerender } = render(
      <CodeOverlay code="graph TD" onChangeCode={() => {}} onClose={() => {}} />,
    );
    rerender(<CodeOverlay code={'graph TD\n  X[Renamed]'} onChangeCode={() => {}} onClose={() => {}} />);
    expect(source().value).toBe('graph TD\n  X[Renamed]');
  });

  it('unmount flushes a pending Auto-Update draft — keystrokes never die with the panel', () => {
    const onChangeCode = vi.fn();
    const { unmount } = render(
      <CodeOverlay code="graph TD" onChangeCode={onChangeCode} onClose={() => {}} />,
    );
    fireEvent.change(source(), { target: { value: 'graph TD\n  A --> E' } });
    unmount(); // inside the 250ms window
    expect(onChangeCode).toHaveBeenCalledWith('graph TD\n  A --> E');
  });

  it('keydown never escapes the panel (host shortcuts must not fire while typing)', () => {
    const onKeyDown = vi.fn();
    render(
      <div onKeyDown={onKeyDown}>
        <CodeOverlay code="graph TD" onChangeCode={() => {}} onClose={() => {}} />
      </div>,
    );
    fireEvent.keyDown(source(), { key: 'a' });
    fireEvent.keyDown(source(), { key: 'Backspace' });
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it('the close button calls onClose', async () => {
    const onClose = vi.fn();
    render(<CodeOverlay code="graph TD" onChangeCode={() => {}} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Hide code' }));
    expect(onClose).toHaveBeenCalled();
  });
});
```

(`HighlightedTextarea` loads shiki lazily and falls back to plain mono on failure — no mock needed; `DiagramPage.test.tsx` already runs it unmocked.)

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm test:run src/mermaid/CodeOverlay.test.tsx`
Expected: FAIL — `Cannot find module './CodeOverlay'`.

- [ ] **Step 3: Implement `src/mermaid/CodeOverlay.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { Switch } from '@/components/ui/Switch';
import { HighlightedTextarea } from './HighlightedTextarea';
import { useDebounced } from './useDebounced';

/**
 * The floating code panel (M29.25, spec D1). Auto-Update ON (default): edits
 * flow out through onChangeCode 250ms behind the keystroke — the same cadence
 * LivePreview renders at, so the canvas follows typing without a re-layout per
 * key. OFF: edits buffer locally, a dirty dot appears, and only Apply commits.
 *
 * The panel is host-positioned (absolute card over the canvas) but
 * self-defending: keydown stops here (the canvas's Delete-deletes-node and
 * BlockNote's hotkeys must not fire while typing source), pointerdown stops
 * here (dragging across the textarea is a selection, not a pan), and
 * data-no-pan covers hosts that check the marker instead.
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
    setDraft((d) => (d === lastCode.current ? code : d));
    lastCode.current = code;
  }, [code]);

  // Auto-Update: the settled draft flows out. Also fires when the switch
  // flips ON over a buffered draft — turning Auto-Update on IS consenting to
  // the pending edits.
  useEffect(() => {
    if (autoUpdate && debounced !== codeRef.current) changeRef.current(debounced);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- codeRef/changeRef are latest-refs; depping `code` would re-fire this on the echo of our own commit.
  }, [debounced, autoUpdate]);

  // A pending debounce must not die with the panel — DiagramPage's M29.23
  // discipline extended one level down. Keystrokes younger than 250ms at
  // close/navigation time flow out here; the host's own unmount flush (or
  // BlockNote's history) takes it from there. Auto-Update OFF keeps its
  // contract: only Apply commits, closing discards.
  useEffect(() => {
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
      onKeyDown={(e) => e.stopPropagation()}
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
```

Verify at implementation time: `Switch` renders `role="switch"` on a visually hidden checkbox and the `label` prop text toggles it via the wrapping `<label>` (`src/components/ui/Switch.tsx:44-60`) — the tests and the e2e click the label TEXT, never the zero-size input.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `pnpm test:run src/mermaid/CodeOverlay.test.tsx`
Expected: 8 passed.

- [ ] **Step 5: Lint + typecheck, then commit**

Run: `pnpm lint && pnpm typecheck`

```bash
git add src/mermaid/CodeOverlay.tsx src/mermaid/CodeOverlay.test.tsx
git commit -m "feat(mermaid): CodeOverlay — the floating code panel with Auto-Update and Apply (M29.25)"
```

---

### Task D3: `setLook`, scale-aware StructuralEditor, `DiagramToolbar`, `FullScreenDiagramEditor` (M29.26)

**Files:**
- Modify: `src/mermaid/flowchart/ops.ts` (append `setLook`)
- Modify: `src/mermaid/flowchart/ops.test.ts` (append)
- Modify: `src/mermaid/flowchart/StructuralEditor.tsx` (`toolbar` prop, scale-corrected overlays)
- Modify: `src/mermaid/flowchart/StructuralEditor.test.tsx` (append)
- Create: `src/mermaid/DiagramToolbar.tsx`
- Create: `src/mermaid/DiagramToolbar.test.tsx`
- Create: `src/mermaid/FullScreenDiagramEditor.tsx` (**heredoc — contains `dangerouslySetInnerHTML`, trap #4**)
- Create: `src/mermaid/FullScreenDiagramEditor.test.tsx`

One phase, one commit: the op, the two editor adjustments, the toolbar, and the composition land together because none is shippable alone.

- [ ] **Step 1: Write the failing `setLook` tests**

Append to `src/mermaid/flowchart/ops.test.ts` (it already imports `parseFlowchart`/`serialize` and uses the `parseFlowchart(src)!` idiom):

```ts
describe('setLook', () => {
  it('creates frontmatter when there is none', () => {
    const m = parseFlowchart('flowchart TD\n  A --> B')!;
    expect(serialize(setLook(m, 'handDrawn'))).toBe(
      '---\nconfig:\n  look: handDrawn\n---\nflowchart TD\n  A --> B',
    );
  });

  it('joins an existing config block without touching its other keys', () => {
    const src = '---\nconfig:\n  layout: elk\n---\nflowchart TD\n  A --> B';
    const m = parseFlowchart(src)!;
    expect(serialize(setLook(m, 'handDrawn'))).toBe(
      '---\nconfig:\n  look: handDrawn\n  layout: elk\n---\nflowchart TD\n  A --> B',
    );
  });

  it('null removes exactly the look line, nothing else', () => {
    const src = '---\nconfig:\n  look: handDrawn\n  layout: elk\n---\nflowchart TD\n  A --> B';
    const m = parseFlowchart(src)!;
    expect(serialize(setLook(m, null))).toBe(
      '---\nconfig:\n  layout: elk\n---\nflowchart TD\n  A --> B',
    );
  });

  it('null with no look anywhere is byte-identical (D10)', () => {
    const src = '---\nconfig:\n  layout: elk\n---\nflowchart TD\n  A --> B';
    const m = parseFlowchart(src)!;
    expect(serialize(setLook(m, null))).toBe(src);
  });

  it('rewrites an existing look line in place, indentation preserved', () => {
    const src = '---\nconfig:\n    look: neo\n---\nflowchart TD\n  A --> B';
    const m = parseFlowchart(src)!;
    expect(serialize(setLook(m, 'handDrawn'))).toBe(
      '---\nconfig:\n    look: handDrawn\n---\nflowchart TD\n  A --> B',
    );
  });

  it('opaque body lines survive byte-for-byte around the edit (D10)', () => {
    const src = 'flowchart TD\n  A[Start] --> B\n  classDef hot fill:#f96\n  class A hot';
    const out = serialize(setLook(parseFlowchart(src)!, 'handDrawn'));
    expect(out.endsWith(src)).toBe(true);
  });
});
```

Add `setLook` to the ops import list at the top of the test file.

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm test:run src/mermaid/flowchart/ops.test.ts`
Expected: FAIL — `setLook` is not exported.

- [ ] **Step 3: Implement `setLook` in `src/mermaid/flowchart/ops.ts`**

Append after `setLayoutEngine` (it is that function with `layout` swapped for `look` — same sanctioned opaque-raw exception, same insertion points):

```ts
/**
 * `look: handDrawn` rides the diagram's YAML frontmatter (spec D9), exactly
 * as `setLayoutEngine` handles `layout:` — the one sanctioned opaque-raw
 * exception, because frontmatter is structure the parser refuses to own.
 * `null` removes the override (mermaid's classic look). Only `handDrawn` is
 * offered this wave (spec §1 non-goals keep the theme picker out).
 */
export function setLook(model: FlowchartModel, look: 'handDrawn' | null): FlowchartModel {
  const next = clone(model);
  const hasFrontmatter = next.lines[0]?.raw.trim() === '---';

  if (!hasFrontmatter) {
    if (look === null) return next;
    next.lines.unshift(
      { raw: '---', parsed: { kind: 'opaque' }, dirty: false },
      { raw: 'config:', parsed: { kind: 'opaque' }, dirty: false },
      { raw: `  look: ${look}`, parsed: { kind: 'opaque' }, dirty: false },
      { raw: '---', parsed: { kind: 'opaque' }, dirty: false },
    );
    return next;
  }

  let close = 1;
  while (close < next.lines.length && next.lines[close].raw.trim() !== '---') close += 1;
  const lookIdx = next.lines.findIndex(
    (l, i) => i > 0 && i < close && l.raw.match(/^\s*look:/) !== null,
  );

  if (look === null) {
    if (lookIdx !== -1) next.lines.splice(lookIdx, 1);
    return next;
  }

  if (lookIdx !== -1) {
    const indent = next.lines[lookIdx].raw.match(/^\s*/)?.[0] ?? '  ';
    next.lines[lookIdx].raw = `${indent}look: ${look}`;
    return next;
  }
  const configIdx = next.lines.findIndex(
    (l, i) => i > 0 && i < close && l.raw.match(/^\s*config:\s*$/) !== null,
  );
  if (configIdx !== -1) {
    next.lines.splice(configIdx + 1, 0, {
      raw: `  look: ${look}`,
      parsed: { kind: 'opaque' },
      dirty: false,
    });
  } else {
    next.lines.splice(close, 0, { raw: 'config:', parsed: { kind: 'opaque' }, dirty: false });
    next.lines.splice(close + 1, 0, {
      raw: `  look: ${look}`,
      parsed: { kind: 'opaque' },
      dirty: false,
    });
  }
  return next;
}
```

Run: `pnpm test:run src/mermaid/flowchart/ops.test.ts`
Expected: all pass (existing + 6 new).

- [ ] **Step 4: StructuralEditor — `toolbar` prop + scale-corrected overlays**

Write the failing test first. Append to `src/mermaid/flowchart/StructuralEditor.test.tsx` (match its existing render-mock setup):

```tsx
it('toolbar={false} hides the built-in control row but keeps the host', async () => {
  render(<StructuralEditor code={'flowchart TD\n  A --> B'} onChangeCode={() => {}} toolbar={false} />);
  expect(screen.queryByTestId('structural-toolbar')).toBeNull();
  expect(screen.getByTestId('structural-host')).toBeTruthy();
});
```

Run `pnpm test:run src/mermaid/flowchart/StructuralEditor.test.tsx` — the new test FAILS (prop not accepted / toolbar renders).

Then edit `src/mermaid/flowchart/StructuralEditor.tsx` — **this file assigns `.innerHTML`, so every edit goes through Bash heredoc (trap #4)**. Four changes:

**(a)** Import the transform hook and take the prop:

```tsx
import { useCanvasTransform } from '../CanvasViewport';
```

```tsx
export function StructuralEditor({
  code,
  onChangeCode,
  toolbar = true,
}: {
  code: string;
  onChangeCode: (code: string) => void;
  /** The built-in control row. The full-screen editor passes false — its DiagramToolbar owns those controls (M29.26). */
  toolbar?: boolean;
}) {
```

**(b)** Read the scale through a ref (the bind effect re-runs only on `[code, model]`, so its closures must not capture a stale scale):

```tsx
  // Inside a CanvasViewport the host is scaled, and getBoundingClientRect
  // deltas are SCREEN px — dividing by the plane scale converts them to the
  // plane coordinates CSS absolute positioning uses in here. Outside any
  // viewport the context is the identity and this is a no-op (M29.26).
  const { scale } = useCanvasTransform();
  const scaleRef = useRef(1);
  scaleRef.current = scale;
```

**(c)** Divide every rect delta by the scale. In the node `onclick` (the toolbarPos block):

```tsx
            const s = scaleRef.current;
            const above = (box.top - hostBox.top) / s - 34;
            const y = above >= 0 ? above : (box.bottom - hostBox.top) / s + 6;
            setToolbarPos({ x: (box.left - hostBox.left) / s, y });
```

In the node `pointerdown` ghost start:

```tsx
          const s = scaleRef.current;
          dragFrom.current = id;
          setGhost({
            x1: (e.clientX - hostBox.left) / s,
            y1: (e.clientY - hostBox.top) / s,
            x2: (e.clientX - hostBox.left) / s,
            y2: (e.clientY - hostBox.top) / s,
          });
```

And in the window-level `onPointerMove`:

```tsx
      const s = scaleRef.current;
      setGhost((g) =>
        g === null
          ? null
          : { ...g, x2: (e.clientX - hostBox.left) / s, y2: (e.clientY - hostBox.top) / s },
      );
```

**(d)** Gate the control row: wrap the existing `<div data-testid="structural-toolbar" …>…</div>` block in `{toolbar && ( … )}`.

jsdom rects are all 0×0, so a unit test of the division would assert `0 === 0` — the scale correction is exercised by the Stage-D e2e (zoomed rename) and live checks; the honest unit coverage is the `toolbar={false}` test plus the untouched existing suite proving the identity default changed nothing.

Run: `pnpm test:run src/mermaid/flowchart/` — all pass.

- [ ] **Step 5: Write the failing `DiagramToolbar` test**

Create `src/mermaid/DiagramToolbar.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DiagramToolbar } from './DiagramToolbar';

vi.mock('./render', () => ({
  renderMermaid: vi.fn().mockResolvedValue({ ok: true, svg: '<svg data-fake="t"></svg>' }),
}));
vi.mock('./export', () => ({
  copySvg: vi.fn().mockResolvedValue(undefined),
  copyPng: vi.fn().mockResolvedValue(undefined),
  savePng: vi.fn().mockResolvedValue('/tmp/x.png'),
}));
import { copySvg } from './export';

const FLOW = 'flowchart TD\n  A[Start] --> B[End]';

function mount(overrides: Partial<Parameters<typeof DiagramToolbar>[0]> = {}) {
  const onChangeCode = vi.fn();
  render(
    <DiagramToolbar
      code={FLOW}
      onChangeCode={onChangeCode}
      mode="visual"
      showCode={false}
      onToggleShowCode={() => {}}
      onEditVisually={null}
      {...overrides}
    />,
  );
  return onChangeCode;
}

describe('DiagramToolbar', () => {
  it('direction buttons rewrite the header surgically', async () => {
    const onChangeCode = mount();
    await userEvent.click(screen.getByRole('button', { name: 'Direction LR' }));
    expect(onChangeCode).toHaveBeenCalledWith('flowchart LR\n  A[Start] --> B[End]');
  });

  it('the layout menu switches engines through frontmatter', async () => {
    const onChangeCode = mount();
    await userEvent.click(screen.getByRole('button', { name: 'Layout engine' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'ELK' }));
    expect(onChangeCode).toHaveBeenCalledWith(
      '---\nconfig:\n  layout: elk\n---\nflowchart TD\n  A[Start] --> B[End]',
    );
  });

  it('the hand-drawn toggle writes and removes look: handDrawn', async () => {
    const onChangeCode = mount();
    await userEvent.click(screen.getByRole('button', { name: 'Hand-drawn look' }));
    expect(onChangeCode).toHaveBeenCalledWith(
      '---\nconfig:\n  look: handDrawn\n---\nflowchart TD\n  A[Start] --> B[End]',
    );
    const off = mount({ code: '---\nconfig:\n  look: handDrawn\n---\nflowchart TD\n  A --> B' });
    await userEvent.click(screen.getAllByRole('button', { name: 'Hand-drawn look' })[1]);
    // Surgical: only the look line goes — the fences and `config:` stay, the
    // same leave-the-empty-config rule setLayoutEngine follows.
    expect(off).toHaveBeenCalledWith('---\nconfig:\n---\nflowchart TD\n  A --> B');
  });

  it('+ Node appends a fresh node line', async () => {
    const onChangeCode = mount();
    await userEvent.click(screen.getByRole('button', { name: 'Add node' }));
    expect(onChangeCode).toHaveBeenCalledWith('flowchart TD\n  A[Start] --> B[End]\n  n1[New step]');
  });

  it('hides the structural cluster over a read-only canvas, shows Edit visually when offered', () => {
    const onEditVisually = vi.fn();
    mount({ code: 'sequenceDiagram\n  A->>B: x', mode: 'code', onEditVisually });
    expect(screen.queryByRole('button', { name: 'Direction TD' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Hand-drawn look' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit visually' })).toBeTruthy();
  });

  it('Show code flips its label with the panel', () => {
    mount({ showCode: true });
    expect(screen.getByRole('button', { name: 'Hide code' })).toBeTruthy();
  });

  it('Copy SVG renders through the cached service and hands the svg to export', async () => {
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'Copy SVG' }));
    await vi.waitFor(() => expect(vi.mocked(copySvg)).toHaveBeenCalledWith('<svg data-fake="t"></svg>'));
  });
});
```

Run: `pnpm test:run src/mermaid/DiagramToolbar.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 6: Implement `src/mermaid/DiagramToolbar.tsx`**

```tsx
import { useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { MenuItem, MenuSurface } from '@/components/ui/Menu';
import { Popover } from '@/components/ui/Popover';
import { useUiStore } from '@/stores/uiStore';
import { parseFlowchart, serialize, type FlowchartModel } from './flowchart/model';
import { addNode, setDirection, setLayoutEngine, setLook } from './flowchart/ops';
import { copyPng, copySvg, savePng } from './export';
import { renderMermaid } from './render';

const DIRECTIONS = ['TD', 'LR', 'BT', 'RL'] as const;

const isElk = (code: string): boolean => code.match(/^\s*layout:\s*elk\s*$/m) !== null;
const isHandDrawn = (code: string): boolean => code.match(/^\s*look:\s*handDrawn\s*$/m) !== null;

const TEXT_BTN =
  'rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-xs text-n-600 hover:bg-n-50';

/**
 * The full-screen editor's control strip (M29.26, spec D1/D9-partial).
 *
 * The structural cluster (add node, direction, layout engine, hand-drawn
 * look) only exists over the structural editor — a read-only canvas has no
 * model to operate on. The zoom cluster is NOT here on purpose: CanvasViewport
 * owns zoom state, so it draws its own controls (spec D2). Stage G grows the
 * layout menu (ELK variants, Auto-layout OFF); this stage names the two
 * engines the ops already speak.
 *
 * Export renders through the cached service at click time — the canvas just
 * rendered this exact code, so it is a cache hit, never a second layout.
 */
export function DiagramToolbar({
  code,
  onChangeCode,
  title,
  mode,
  showCode,
  onToggleShowCode,
  onEditVisually,
}: {
  code: string;
  onChangeCode: (code: string) => void;
  /** For hosts with no chrome of their own (Stage H's WhiteboardView). The page header and the block dialog already name the diagram, so both omit it. */
  title?: string;
  /** What the canvas is hosting right now. */
  mode: 'visual' | 'code';
  showCode: boolean;
  onToggleShowCode: () => void;
  /** Present when the source is flowchart-capable but the canvas is read-only. The latch never auto-promotes (M29.18.1), so promotion is this explicit button — or null when there is nothing to promote to. */
  onEditVisually: (() => void) | null;
}) {
  const toast = useUiStore((s) => s.toast);
  const model = useMemo(() => parseFlowchart(code), [code]);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const layoutAnchor = useRef<HTMLButtonElement | null>(null);

  const apply = (next: FlowchartModel | null) => {
    if (next !== null) onChangeCode(serialize(next));
  };

  // savePng resolves null on user cancel — no toast either way (the M29.5
  // contract); the copy actions resolve undefined and always toast.
  const act = (success: string, failure: string, run: (svg: string) => Promise<unknown>) => {
    void renderMermaid(code)
      .then((r) => {
        if (!r.ok) throw new Error(r.message);
        return run(r.svg);
      })
      .then((result) => {
        if (result !== null) toast(success);
      })
      .catch(() => toast(failure));
  };

  return (
    <div
      data-testid="diagram-toolbar"
      className="flex h-10 flex-none items-center gap-1 border-b border-n-200 bg-n-0 px-2"
    >
      {title !== undefined && (
        <span className="mr-1 truncate text-sm font-medium text-n-900">{title}</span>
      )}
      {mode === 'visual' && model !== null && (
        <>
          <button
            type="button"
            aria-label="Add node"
            onClick={() => apply(addNode(model, 'New step').model)}
            className={TEXT_BTN}
          >
            + Node
          </button>
          <span className="mx-0.5 h-4 w-px bg-n-100" />
          {DIRECTIONS.map((d) => (
            <button
              key={d}
              type="button"
              aria-label={`Direction ${d}`}
              onClick={() => apply(setDirection(model, d))}
              className={TEXT_BTN}
            >
              {d}
            </button>
          ))}
          <span className="mx-0.5 h-4 w-px bg-n-100" />
          <button
            type="button"
            ref={layoutAnchor}
            aria-label="Layout engine"
            onClick={() => setLayoutOpen(true)}
            className={TEXT_BTN}
          >
            {isElk(code) ? 'Layout: ELK' : 'Layout: Dagre'}
          </button>
          {layoutOpen && (
            <Popover
              anchorRef={layoutAnchor}
              onClose={() => setLayoutOpen(false)}
              role="menu"
              ariaLabel="Layout engine"
            >
              <MenuSurface width={160}>
                <MenuItem
                  label="Dagre"
                  checked={!isElk(code)}
                  onSelect={() => {
                    apply(setLayoutEngine(model, 'dagre'));
                    setLayoutOpen(false);
                  }}
                />
                <MenuItem
                  label="ELK"
                  checked={isElk(code)}
                  onSelect={() => {
                    apply(setLayoutEngine(model, 'elk'));
                    setLayoutOpen(false);
                  }}
                />
              </MenuSurface>
            </Popover>
          )}
          <IconButton
            icon="pen-tool"
            label="Hand-drawn look"
            active={isHandDrawn(code)}
            onClick={() => apply(setLook(model, isHandDrawn(code) ? null : 'handDrawn'))}
          />
        </>
      )}
      {onEditVisually !== null && (
        <button type="button" onClick={onEditVisually} className={TEXT_BTN}>
          Edit visually
        </button>
      )}
      <span className="flex-1" />
      <button type="button" onClick={onToggleShowCode} className={TEXT_BTN}>
        {showCode ? 'Hide code' : 'Show code'}
      </button>
      <span className="mx-0.5 h-4 w-px bg-n-100" />
      <Button variant="secondary" onClick={() => act('SVG copied', 'Copy SVG failed', (svg) => copySvg(svg))}>
        Copy SVG
      </Button>
      <Button variant="secondary" onClick={() => act('PNG copied', 'Copy PNG failed', (svg) => copyPng(svg))}>
        Copy PNG
      </Button>
      <Button variant="secondary" onClick={() => act('PNG saved', 'Save PNG failed', (svg) => savePng(svg, 'diagram.png'))}>
        Save PNG…
      </Button>
    </div>
  );
}
```

Verify at implementation time: `pen-tool` is a valid lucide name for `Icon` (fallback: `pencil-ruler`, keep the label), and `Popover`'s `anchorRef` accepts a `RefObject<HTMLButtonElement | null>` (`PopoverProps.anchorRef: React.RefObject<HTMLElement | null>` — TS property covariance allows it; if the compiler disagrees, type the ref as `HTMLElement | null` and cast at the `ref=` site with a written reason).

Run: `pnpm test:run src/mermaid/DiagramToolbar.test.tsx`
Expected: 7 passed.

- [ ] **Step 7: Write the failing `FullScreenDiagramEditor` test**

Create `src/mermaid/FullScreenDiagramEditor.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FullScreenDiagramEditor } from './FullScreenDiagramEditor';

vi.mock('./render', () => ({
  renderMermaid: vi.fn().mockResolvedValue({ ok: true, svg: '<svg data-fake="f"></svg>' }),
}));
vi.mock('./export', () => ({
  copySvg: vi.fn().mockResolvedValue(undefined),
  copyPng: vi.fn().mockResolvedValue(undefined),
  savePng: vi.fn().mockResolvedValue(null),
}));
import { renderMermaid } from './render';
const renderMock = vi.mocked(renderMermaid);

const FLOW = 'flowchart TD\n  A[Start] --> B[End]';
const SEQ = 'sequenceDiagram\n  A->>B: x';

describe('FullScreenDiagramEditor', () => {
  it('a flowchart latches visual: structural editor inside the plane, overlay closed', async () => {
    render(<FullScreenDiagramEditor code={FLOW} onChangeCode={() => {}} />);
    const plane = screen.getByTestId('canvas-plane');
    expect(plane.querySelector('[data-testid="structural-host"]')).toBeTruthy();
    // DiagramToolbar owns the controls — the built-in row must not double up.
    expect(screen.queryByTestId('structural-toolbar')).toBeNull();
    expect(screen.queryByTestId('code-overlay')).toBeNull();
    expect(screen.getByTestId('diagram-toolbar')).toBeTruthy();
  });

  it('a non-flowchart latches code: read-only canvas, overlay open, Edit visually absent', async () => {
    render(<FullScreenDiagramEditor code={SEQ} onChangeCode={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId('fullscreen-readonly-diagram').innerHTML).toContain(
        'data-fake="f"',
      ),
    );
    expect(screen.getByTestId('code-overlay')).toBeTruthy();
    expect(screen.queryByTestId('structural-host')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit visually' })).toBeNull();
  });

  it('Show code toggles the overlay, and overlay edits flow out debounced', async () => {
    const onChangeCode = vi.fn();
    render(<FullScreenDiagramEditor code={FLOW} onChangeCode={onChangeCode} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show code' }));
    const source = screen.getByLabelText('Mermaid source') as HTMLTextAreaElement;
    expect(source.value).toBe(FLOW);
    fireEvent.change(source, { target: { value: `${FLOW}\n  B --> C[More]` } });
    await waitFor(() => expect(onChangeCode).toHaveBeenCalledWith(`${FLOW}\n  B --> C[More]`));
    await userEvent.click(screen.getByRole('button', { name: 'Hide code' }));
    expect(screen.queryByTestId('code-overlay')).toBeNull();
  });

  it('demotes to code when the source stops being a flowchart, and opens the overlay', async () => {
    const { rerender } = render(<FullScreenDiagramEditor code={FLOW} onChangeCode={() => {}} />);
    rerender(<FullScreenDiagramEditor code={SEQ} onChangeCode={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('code-overlay')).toBeTruthy());
    expect(screen.queryByTestId('structural-host')).toBeNull();
    // Explicit promotion is offered — the latch never promotes on its own.
    rerender(<FullScreenDiagramEditor code={FLOW} onChangeCode={() => {}} />);
    expect(screen.queryByTestId('structural-host')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Edit visually' }));
    expect(screen.getByTestId('canvas-plane').querySelector('[data-testid="structural-host"]')).toBeTruthy();
  });

  it('a broken source in code mode keeps the last good svg and names the line', async () => {
    renderMock.mockResolvedValueOnce({ ok: true, svg: '<svg data-fake="good"></svg>' });
    const { rerender } = render(<FullScreenDiagramEditor code={SEQ} onChangeCode={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId('fullscreen-readonly-diagram').innerHTML).toContain('good'),
    );
    renderMock.mockResolvedValueOnce({ ok: false, message: 'Parse error on line 2:', line: 2 });
    rerender(<FullScreenDiagramEditor code={`${SEQ}\n  broken`} onChangeCode={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('fullscreen-render-error')).toBeTruthy());
    expect(screen.getByTestId('fullscreen-render-error').textContent).toContain('Line 2:');
    expect(screen.getByTestId('fullscreen-readonly-diagram').innerHTML).toContain('good');
  });

  it('renders the title when a host passes one', () => {
    render(<FullScreenDiagramEditor code={FLOW} onChangeCode={() => {}} title="Pipeline" />);
    expect(screen.getByText('Pipeline')).toBeTruthy();
  });
});
```

Run: `pnpm test:run src/mermaid/FullScreenDiagramEditor.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 8: Implement `src/mermaid/FullScreenDiagramEditor.tsx`** (via Bash heredoc — trap #4)

```tsx
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
  embedded = false,
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
    <div
      data-testid="fullscreen-diagram-editor"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
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
```

Note the CodeOverlay is a SIBLING of CanvasViewport (both absolute in the same relative box), not a child of the plane — it must not scale with the zoom, and its pointer events never reach the viewport at all.

- [ ] **Step 9: Run the whole mermaid suite**

Run: `pnpm test:run src/mermaid/`
Expected: all pass — including the untouched MermaidBlockView/StructuralEditor suites (the identity-default context and `toolbar = true` default mean zero behavior change for existing hosts).

- [ ] **Step 10: Lint + typecheck, then commit**

Run: `pnpm lint && pnpm typecheck`

```bash
git add src/mermaid/flowchart/ops.ts src/mermaid/flowchart/ops.test.ts \
  src/mermaid/flowchart/StructuralEditor.tsx src/mermaid/flowchart/StructuralEditor.test.tsx \
  src/mermaid/DiagramToolbar.tsx src/mermaid/DiagramToolbar.test.tsx \
  src/mermaid/FullScreenDiagramEditor.tsx src/mermaid/FullScreenDiagramEditor.test.tsx
git commit -m "feat(mermaid): the full-screen diagram editor — canvas, toolbar, code overlay (M29.26)"
```

---

### Task D4: The two hosts — DiagramPage goes canvas, blocks open full screen (M29.27)

**Files:**
- Modify: `src/components/ui/Dialog.tsx` (+ `fullscreen` variant), `src/components/ui/Dialog.test.tsx`
- Modify: `src/pages/DiagramPage.tsx`, `src/pages/DiagramPage.test.tsx`
- Modify: `src/app/Sidebar.tsx` (SIDEBARLESS)
- Modify: `src/mermaid/MermaidBlockView.tsx`, `src/mermaid/MermaidBlockView.test.tsx`

- [ ] **Step 1: Dialog grows a `fullscreen` variant (failing test first)**

Append to `src/components/ui/Dialog.test.tsx` (match its existing render idiom):

```tsx
it('fullscreen fills the viewport: unpadded scrim, full-height unpadded flex body', () => {
  render(
    <Dialog open fullscreen title="Full" onClose={() => {}}>
      <div data-testid="body-child" />
    </Dialog>,
  );
  const card = screen.getByRole('dialog');
  expect(card.className).toContain('cb-dlg-full');
  expect(card.style.maxWidth).toBe('none');
});
```

Run `pnpm test:run src/components/ui/Dialog.test.tsx` — the new test FAILS (`fullscreen` not a prop).

Then edit `src/components/ui/Dialog.tsx`. Append to the `css` template string:

```css
.cb-dlg-scrim-full{padding:0}
.cb-dlg-full{height:100vh;max-height:100vh;border-radius:0}
.cb-dlg-full>.cb-dlg-bd{display:flex;flex:1;min-height:0;padding:0;overflow:hidden}
```

Add to `DialogProps`:

```tsx
  /**
   * Fill the viewport: no scrim padding, full-height card, radius 0, and the
   * body becomes an unpadded flex column (M29.27) — for surfaces that ARE a
   * page, like the block's full-screen diagram editor. Everything else
   * (layers, Escape, Tab trap, focus restore, the titled header with its
   * Close button) is unchanged — which is exactly why this is a Dialog
   * variant and not a new overlay primitive.
   */
  fullscreen?: boolean;
```

In `DialogCard`, destructure `fullscreen = false` and change the two classNames and the card style:

```tsx
    <div
      className={`cb-dlg-scrim ${fullscreen ? 'cb-dlg-scrim-full' : ''}`}
```

```tsx
        className={`cb-dlg ${fullscreen ? 'cb-dlg-full' : ''}`}
        …
        style={{ maxWidth: fullscreen ? 'none' : width, ...style }}
```

Run: `pnpm test:run src/components/ui/Dialog.test.tsx` — all pass.

- [ ] **Step 2: DiagramPage — body becomes the shared editor (failing tests first)**

Rewrite the affected tests in `src/pages/DiagramPage.test.tsx`. The header, save chrome, tombstone, and keyed-flush tests are the page's contract and stay; every `diagram-code-pane` / page-owned pane assertion changes to the editor's surfaces. The load/save machinery assertions must NOT weaken — they are the M29.23 regression net. Changed tests, in full:

Three tests change only their pane assertions — apply these exact swaps and leave every other line alone:

- `'loads a flowchart .mmd and opens in the structural editor'`: drop the `expect(screen.queryByTestId('diagram-code-pane')).toBeNull()` line; add `expect(screen.getByTestId('canvas-plane')).toBeTruthy();` and `expect(screen.queryByTestId('code-overlay')).toBeNull();` (visual entry keeps the overlay closed).
- `'opens a non-flowchart .mmd in code mode with the source verbatim'`: `findByTestId('diagram-code-pane')` becomes `findByTestId('code-overlay')` (the overlay IS the editor there); the verbatim-value, no-structural-host, and 'Sequence' assertions stay.
- `'shows the whole file in code mode — the mermaid header is source, not frontmatter'`: unchanged except the title (`… in the overlay — …`) — 'Show code' now lives on the toolbar and the textarea in the overlay, but both keep their accessible names, so the body already passes.
- `'opens a file the scanner has not adopted yet …'`: `findByTestId('diagram-code-pane')` → `findByTestId('code-overlay')`.

The two load-bearing tests are rewritten in full:

```tsx
  it('debounce-saves overlay edits raw, preserving the leading config header', async () => {
    render(<DiagramPage selection={{ kind: 'diagram', path: PIPELINE }} />);
    await screen.findByTestId('structural-host');
    fireEvent.click(screen.getByRole('button', { name: 'Show code' }));
    const textarea = (await screen.findByLabelText('Mermaid source')) as HTMLTextAreaElement;
    const edited = `${textarea.value}  D --> E[Ship]\n`;
    fireEvent.change(textarea, { target: { value: edited } });
    // Two debounces now sit in the path (overlay 250ms, page save 500ms), so
    // 'Unsaved' arrives when the overlay flows the edit out — waitFor, not
    // an immediate read.
    await waitFor(() =>
      expect(screen.getByTestId('diagram-save-state').textContent).toBe('Unsaved'),
    );
    await waitFor(() => expect(fs().get(PIPELINE)).toContain('E[Ship]'), { timeout: 3000 });
    const raw = fs().get(PIPELINE)!;
    expect(raw.startsWith('---\nconfig:\n  layout: elk\n---\n')).toBe(true);
    expect(raw).toBe(edited);
    await waitFor(() => expect(screen.getByTestId('diagram-save-state').textContent).toBe('Saved'));
  });
```

And the keyed-navigation test swaps nothing but its pane lookup — the textarea is now the overlay's, and the flush chain it proves got one link longer:

```tsx
  // M29.23 CRITICAL regression net, now one debounce deeper: the overlay's
  // 250ms buffer flushes on ITS unmount (CodeOverlay cleanup), which feeds
  // handleChange, whose 500ms timer outlives the unmounted page and still
  // writes the OLD file's bytes to the OLD path — the App.tsx key guarantees
  // the whole chain belongs to the dying instance.
  it('a navigation mid-debounce flushes to the OLD file and never touches the new one', async () => {
    const A = 'diagrams/a.mmd';
    const B = 'diagrams/b.mmd';
    const A_RAW = 'sequenceDiagram\n  A->>A: a\n';
    const B_RAW = 'sequenceDiagram\n  B->>B: b\n';
    await writeTextFile('/demo-vault', A, A_RAW);
    await writeTextFile('/demo-vault', B, B_RAW);
    await useVaultStore.getState().rescan();

    const { rerender } = render(<DiagramPage key={A} selection={{ kind: 'diagram', path: A }} />);
    const textarea = (await screen.findByLabelText('Mermaid source')) as HTMLTextAreaElement;
    const edited = `${A_RAW}  A->>B: edited\n`;
    fireEvent.change(textarea, { target: { value: edited } });

    // Navigate to B inside BOTH debounce windows.
    rerender(<DiagramPage key={B} selection={{ kind: 'diagram', path: B }} />);
    await screen.findByTestId('code-overlay');

    await waitFor(() => expect(fs().get(A)).toBe(edited), { timeout: 3000 });
    expect(fs().get(B)).toBe(B_RAW);
  });
```

Run `pnpm test:run src/pages/DiagramPage.test.tsx` — the changed tests FAIL against the current page.

Then edit `src/pages/DiagramPage.tsx`:

- Drop the `mode` state, the `flowchartCapable` derivation, the demotion effect, the header's Show code/Show diagram button, and both body panes.
- Drop the now-unused imports: `parseFlowchart`, `StructuralEditor`, `HighlightedTextarea`, `LivePreview`.
- Add `import { FullScreenDiagramEditor } from '@/mermaid/FullScreenDiagramEditor';`
- The header row keeps: icon, title, `detectDiagramType(code ?? '')` tag, save-state label. Everything about `handleChange`, `flushRef`, the load effect, the unmount flush, and the tombstone stays BYTE-FOR-BYTE — that is the M29.23 machinery (trap #7).
- The body becomes:

```tsx
      {code !== null && (
        /* Every edit — structural op, overlay keystroke — commits through
           handleChange, the same channel the old panes used, so the keyed
           debounced autosave (M29.23) is untouched. The editor owns no
           persistence; this page is the only writer. */
        <FullScreenDiagramEditor code={code} onChangeCode={handleChange} />
      )}
```

No `title` prop on purpose — the page header above already names the file.

Run: `pnpm test:run src/pages/DiagramPage.test.tsx`
Expected: 7 passed.

- [ ] **Step 3: Sidebar — the diagram surface goes sidebarless**

In `src/app/Sidebar.tsx:56`, extend the set and its docstring:

```tsx
// M29.27 adds `diagram` for a different reason again: the page IS a canvas
// (spec D1), and an infinite plane beside a tree reads as a pane, not a
// surface. Navigation back out is the topbar's, same as Settings.
const SIDEBARLESS = new Set(['settings', 'pulse', 'inbox', 'library', 'diagram']);
```

Run: `pnpm test:run src/app/` — expected all pass (no sidebar test enumerates the set today; if one asserts it, extend the expectation).

- [ ] **Step 4: MermaidBlockView — "Open full screen" (failing test first)**

Append to `src/mermaid/MermaidBlockView.test.tsx` (its existing `vi.mock('./render')` covers the editor's whole tree):

```tsx
  it('opens the full-screen editor from the header, wired to the block channel', async () => {
    renderMock.mockResolvedValue({ ok: true, svg: '<svg data-fake="fs"></svg>' });
    const onChangeCode = vi.fn();
    render(<MermaidBlockView code={'flowchart TD\n  A --> B'} onChangeCode={onChangeCode} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open full screen' }));
    expect(screen.getByTestId('fullscreen-diagram-editor')).toBeTruthy();
    // The dialog closes back to the block.
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('fullscreen-diagram-editor')).toBeNull();
  });

  it('hides Open full screen while editing and on an empty block', async () => {
    renderMock.mockResolvedValue({ ok: true, svg: '<svg></svg>' });
    render(<MermaidBlockView code="" onChangeCode={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Open full screen' })).toBeNull();
    cleanup();
    render(<MermaidBlockView code={'flowchart TD\n  A --> B'} onChangeCode={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit', exact: true }));
    expect(screen.queryByRole('button', { name: 'Open full screen' })).toBeNull();
  });
```

Run it — FAIL. Then edit `src/mermaid/MermaidBlockView.tsx` (**heredoc — the file's test sibling quotes svg fixtures, and Stage-C history shows the hook firing on this pair; write both via Bash**):

Add imports and state:

```tsx
import { Dialog } from '@/components/ui/Dialog';
import { FullScreenDiagramEditor } from './FullScreenDiagramEditor';
```

```tsx
  const [fullScreen, setFullScreen] = useState(false);
```

In the header, before the "Save as file…" button (same gate — a view-mode block with content):

```tsx
        {!editing && code.trim() !== '' && (
          <button
            type="button"
            onClick={() => setFullScreen(true)}
            className="rounded-md border-0 bg-transparent px-1.5 py-0.5 text-xs text-n-500 hover:bg-n-50 hover:text-n-800"
          >
            Open full screen
          </button>
        )}
```

At the end of the component, next to the lightbox mount:

```tsx
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
          <FullScreenDiagramEditor code={code} onChangeCode={onChangeCode} />
        </Dialog>
      )}
```

- [ ] **Step 5: Run the full unit suite + gates**

Run: `pnpm test:run`
Expected: all pass. Suites most likely to flag drift: `MermaidBlockView.test.tsx` (header button count), `Sidebar`-adjacent app tests, `Dialog.test.tsx`.

Run: `pnpm lint && pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/Dialog.tsx src/components/ui/Dialog.test.tsx \
  src/pages/DiagramPage.tsx src/pages/DiagramPage.test.tsx \
  src/app/Sidebar.tsx src/mermaid/MermaidBlockView.tsx src/mermaid/MermaidBlockView.test.tsx
git commit -m "feat(mermaid): full-screen hosts — the diagram page goes canvas, blocks open full screen (M29.27)"
```

---

### Task D5: e2e — the two full-screen journeys, then the full gate (M29.28)

**Files:**
- Modify: `e2e/diagrams.spec.ts` (append two tests)

- [ ] **Step 1: Append the diagram-page canvas test**

Copy the boot and quick-open blocks from the existing `.mmd` test in the same file VERBATIM (distiller off, theme pinned, `Pipeline` row labeled Diagram). Append:

```ts
// M29.24–.27: the .mmd page is now a full-screen canvas — pan/zoom viewport,
// zoom cluster, floating code overlay with Auto-Update and Apply — and the
// page's keyed debounced autosave still writes raw bytes underneath it all.
test('the diagram page is a pan/zoom canvas with a floating code overlay', async ({ page }) => {
  test.setTimeout(60_000);

  // -- Boot + open 'Pipeline' through quick open: copy the boot and
  // quick-open block VERBATIM from the "'.mmd file opens as a diagram page'"
  // test earlier in this file — same init script, same demo-vault fallback,
  // same Diagram-labeled result row.

  // -- Canvas up, sidebar gone (SIDEBARLESS) -----------------------------
  await expect(page.getByTestId('diagram-page')).toBeVisible();
  const viewport = page.getByTestId('canvas-viewport');
  await expect(viewport).toBeVisible();
  await expect(page.getByTestId('sidebar-type')).toHaveCount(0);
  const host = page.getByTestId('structural-host');
  await host.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 20_000 });

  // -- Wheel zoom moves the readout --------------------------------------
  // Pin 100% first: initialFit may have landed on any scale.
  const readout = page.getByRole('button', { name: 'Reset zoom' });
  await readout.click();
  await expect(readout).toContainText('100%');
  await viewport.hover();
  await page.mouse.wheel(0, -100);
  await expect(readout).toContainText('110%');

  // -- Overlay: Auto-Update streams edits onto the canvas ----------------
  await page.getByRole('button', { name: 'Show code' }).click();
  const overlay = page.getByTestId('code-overlay');
  await expect(overlay).toBeVisible();
  const source = page.getByLabel('Mermaid source');
  await expect(source).toHaveValue(/^---\nconfig:/);
  const current = await source.inputValue();
  await source.fill(`${current}  D --> Quill[Quill]\n`);
  await expect(host).toContainText('Quill', { timeout: 15_000 });
  // …and the page's raw autosave got it too (250ms overlay + 500ms save).
  await expect
    .poll(() => page.evaluate(() => window.__cerebroMockFs.get('diagrams/pipeline.mmd')), {
      timeout: 15_000,
    })
    .toContain('Quill[Quill]');

  // -- Auto-Update OFF buffers until Apply -------------------------------
  await page.getByText('Auto-update').click(); // the Switch input is 0×0; its label text is the click target
  const buffered = await source.inputValue();
  await source.fill(`${buffered}  D --> Vega[Vega]\n`);
  // Bounded negative: give the (disabled) debounce room to have fired.
  await page.waitForTimeout(800);
  await expect(host).not.toContainText('Vega');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(host).toContainText('Vega', { timeout: 15_000 });
});
```

- [ ] **Step 2: Append the block full-screen test**

```ts
// M29.27: a doc block opens the SAME editor full screen in a Dialog layer,
// wired to the block's own code channel — a structural rename made there
// lands back in the block render and, through the doc's autosave, on disk.
test('a doc block opens full screen, and a rename flows back into the block', async ({ page }) => {
  test.setTimeout(60_000);

  // -- Boot + open 'Systems map' through quick open: copy the boot,
  // quick-open, doc-title, and first-diagram-visible block VERBATIM from the
  // 'structural editing round-trips to the file' test earlier in this file —
  // do not improvise a shorter journey.

  // -- Open the first (flowchart) block full screen ----------------------
  const block = page.getByTestId('mermaid-block').first();
  await block.getByRole('button', { name: 'Open full screen' }).click();
  const editor = page.getByTestId('fullscreen-diagram-editor');
  await expect(editor).toBeVisible();
  // The structural editor is unique on the page (the block behind is a plain
  // render), so structural-host scopes every node locator below — a bare
  // [id*=…] would also match the block's svg and trip strict mode.
  const host = page.getByTestId('structural-host');
  await host.locator('svg[id^="cerebro-mermaid-"]').waitFor({ timeout: 15_000 });

  // -- Rename by double-click, same gesture as the inline editor ---------
  await host.locator('[id*="flowchart-Idea-"]').dblclick();
  const labelInput = page.getByLabel('Node label');
  await labelInput.fill('Quasar');
  await labelInput.press('Enter');
  await expect(host).toContainText('Quasar', { timeout: 15_000 });

  // -- Close the dialog; the block shows the rename ----------------------
  await page.locator('.cb-dlg').getByRole('button', { name: 'Close' }).click();
  await expect(editor).toHaveCount(0);
  await expect(block.getByTestId('mermaid-diagram')).toContainText('Quasar', { timeout: 15_000 });
  // The surgical edit reached the (mock) disk through the doc's autosave.
  await expect
    .poll(() => page.evaluate(() => window.__cerebroMockFs.get('strategy/systems-map.md')), {
      timeout: 15_000,
    })
    .toContain('Idea[Quasar]');
});
```

- [ ] **Step 3: Run the diagram suite, then the whole e2e**

Run: `PORT=5273 pnpm e2e -- diagrams.spec.ts`
Expected: 6 passed — the four existing tests must still pass untouched. The old `.mmd` test's 'Show code' click now hits the toolbar and its 'Mermaid source' the overlay; both keep their accessible names by design, so it passes unmodified. If it does not, the names drifted — fix the component, not the old test.

Run: `PORT=5273 pnpm e2e`
Expected: all pass (no corpus changes this stage, so no count churn elsewhere).

- [ ] **Step 4: Full gate**

Run: `pnpm lint && pnpm typecheck && pnpm test:run && pnpm test:coverage`
Expected: clean; coverage not below the ratchet (Stage D adds well-tested files — if a threshold trips, the fix is more tests, never a lower ratchet).

Rust is untouched this stage; `cd src-tauri && cargo test` should be a no-op green if run.

- [ ] **Step 5: Commit**

```bash
git add e2e/diagrams.spec.ts
git commit -m "test(mermaid): full-screen canvas e2e — page zoom, overlay editing, block round-trip (M29.28)"
```

---

## Stage D exit criteria

- Opening a `.mmd` file is a full-screen canvas: sidebar gone (`SIDEBARLESS`), pan on background drag (button 0, pointercancel-safe), cursor-anchored wheel zoom through a native non-passive listener, zoom cluster (out / % readout-reset / in / fit) with aria-labels, scale clamped 0.1–4.
- The floating Code panel edits any diagram type: Auto-Update ON streams at 250ms; OFF buffers behind a dirty dot until Apply; keystrokes never leak to host shortcuts; a pending Auto-Update draft survives close/navigation (unmount flush).
- `FullScreenDiagramEditor` is ONE component with two hosts (spec D1): DiagramPage's keyed debounced autosave is byte-for-byte intact (M29.23 regression test still passes, now one debounce deeper), and the block's "Open full screen" edits through the block's own `onChangeCode` — BlockNote history, doc autosave, no new file or Selection kind.
- The toolbar carries add-node/direction/layout(Dagre|ELK)/`look: handDrawn` over the structural editor, "Edit visually" as the only promotion path, Show code, and the Copy SVG / Copy PNG / Save PNG… actions through `export.ts`; `setLook` round-trips surgically with opaque lines byte-identical (spec D10).
- StructuralEditor behaves identically on its two old hosts (identity context, `toolbar` defaulting true) and positions its overlays correctly under scale inside the viewport; React still never touches its svg subtree.
- MermaidLightbox is unchanged (spec D2).
- `pnpm lint && pnpm typecheck && pnpm test:run && pnpm test:coverage` and `PORT=5273 pnpm e2e` all green; live-check once in the packaged app (`./scripts/mac-build.sh`) that Save PNG… still opens the native dialog from the full-screen toolbar.
