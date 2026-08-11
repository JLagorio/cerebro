import { useEffect } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  CanvasViewport,
  useCanvasOverlayHost,
  useCanvasScale,
  useCanvasTransform,
} from './CanvasViewport';

// jsdom implements no PointerEvent, so testing-library falls back to plain
// `Event` (`window[EventType] || window.Event`) and silently DROPS `button`,
// `clientX` and `clientY` — the gap already documented at useSortableList.ts:76
// and CalendarView.test.tsx:186. Without this, both pan tests below are lies:
// `button: 0` and `button: 2` both arrive as `undefined`, so the primary-button
// guard rejects every drag and the "does not pan" test passes for the wrong
// reason. No production code can tell those two cases apart — only the event
// construction can. MouseEvent carries all three and jsdom implements it fully.
// Scoped to this file on purpose: src/test/setup.ts is shared with six other
// pointer-driven suites that pass under the fallback today.
//
// What it does NOT give you: MouseEvent carries no pointer identity, so
// `pointerId`, `pointerType` and `isPrimary` are all `undefined` on every event
// this shim produces — do not assert on them or branch on them in a test. jsdom
// also implements no `Element.setPointerCapture`, which is why the component's
// call is optional (`setPointerCapture?.(…)`); make it unconditional and every
// pan test here throws.
if (typeof window.PointerEvent === 'undefined') {
  window.PointerEvent = MouseEvent as unknown as typeof window.PointerEvent;
}

/** Reads the context the way an overlay would. */
function Probe() {
  const t = useCanvasTransform();
  return (
    <span data-testid="probe">
      {Math.round(t.scale * 100)}:{t.offset.x},{t.offset.y}
    </span>
  );
}

/**
 * Reads the SCALE channel and counts its own renders — the point of that
 * channel being a bare number is that a pan, which moves only the offset,
 * must not re-render a consumer that asked for the scale.
 */
let scaleProbeRenders = 0;
function ScaleProbe() {
  const scale = useCanvasScale();
  // Counted in an effect, not during render: a render is not the place for a
  // side effect, and an undepended effect fires after every one of them.
  useEffect(() => {
    scaleProbeRenders += 1;
  });
  return <span data-testid="scale-probe">{scale}</span>;
}

/** Reads the portal target the screen-anchored overlays render into. */
function HostProbe() {
  const host = useCanvasOverlayHost();
  return <span data-testid="host-probe">{host?.dataset.testid ?? 'none'}</span>;
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
    // fireEvent returns dispatchEvent's result — `false` once something called
    // preventDefault. That is the whole point of the native `{ passive: false }`
    // listener (the M29.5 lightbox lesson): without the preventDefault the host
    // page scrolls under the zoom, and the readout assertions alone never notice.
    expect(fireEvent.wheel(screen.getByTestId('canvas-viewport'), { deltaY: -1 })).toBe(false);
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

  it('takes no pointer capture until a press has actually moved', () => {
    const captured: number[] = [];
    render(<CanvasViewport>x</CanvasViewport>);
    const viewport = screen.getByTestId('canvas-viewport');
    // jsdom implements no setPointerCapture at all, which is why the component
    // calls it optionally — so the spy has to be installed, not observed.
    (viewport as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = (
      id: number,
    ) => captured.push(id);

    // A CLICK — press, a 2px tremor, release. Capturing here retargeted the
    // following `click` to this div in Chromium, so it never reached the
    // diagram and clicking empty canvas stopped deselecting (M29.51).
    fireEvent.pointerDown(viewport, { button: 0, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(viewport, { clientX: 51, clientY: 51 });
    expect(captured).toEqual([]);
    expect(plane().style.transform).toBe('translate(0px, 0px) scale(1)');
    fireEvent.pointerUp(viewport);

    // A DRAG — past 3px, so capture is taken and the pan runs.
    fireEvent.pointerDown(viewport, { button: 0, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(viewport, { clientX: 90, clientY: 70 });
    expect(captured).toHaveLength(1);
    expect(plane().style.transform).toBe('translate(40px, 20px) scale(1)');
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

  // The NO_PAN selector is a contract two later Stage-D tasks depend on, not
  // decoration. StructuralEditor hangs a raw `pointerdown` on every `g.node` to
  // start drag-to-connect (StructuralEditor.tsx:140) and Task D3 mounts that
  // editor inside this viewport — drop `g.node` and every connect-drag pans the
  // canvas underneath itself. `[data-no-pan]` is the documented escape hatch
  // Task D4's CodeOverlay uses. Without this test the whole selector can be
  // narrowed to `'button'` with the suite still green.
  it('never starts a pan on a diagram node or a data-no-pan island', () => {
    render(
      <CanvasViewport>
        <svg>
          <g className="node" data-testid="n" />
          {/* An ICON node is not a `g.node` — mermaid draws it as
              `icon-shape default` and an image node as `image-shape default`
              (MEASURED on the bundled 11.16.0, M29.39; asserted in
              flowchart/icons.mermaid.test.ts). Left out of NO_PAN, a
              connect-drag from an icon node panned the canvas underneath
              itself, which is the exact failure this test was written for. */}
          <g className="icon-shape default" data-testid="icon" />
          <g className="image-shape default" data-testid="image" />
          {/* And `look: handDrawn` re-prefixes every ORDINARY node at once, so
              without this one every drag in a hand-drawn diagram panned. */}
          <g className="rough-node default" data-testid="rough" />
        </svg>
        <div data-no-pan data-testid="island" />
      </CanvasViewport>,
    );
    for (const id of ['n', 'icon', 'image', 'rough', 'island']) {
      fireEvent.pointerDown(screen.getByTestId(id), { button: 0, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(screen.getByTestId('canvas-viewport'), { clientX: 40, clientY: 40 });
      expect(plane().style.transform).toBe('translate(0px, 0px) scale(1)');
    }
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

  it('publishes the scale alone, so a pan does not re-render a counter-scale', async () => {
    render(
      <CanvasViewport>
        <ScaleProbe />
      </CanvasViewport>,
    );
    const before = scaleProbeRenders;
    // A pan moves the offset and NOT the scale, so a scale consumer must not
    // re-render — the whole reason this context is a number (M29.51).
    const viewport = screen.getByTestId('canvas-viewport');
    fireEvent.pointerDown(viewport, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(viewport, { clientX: 90, clientY: 20 });
    fireEvent.pointerUp(viewport);
    expect(plane().style.transform).toContain('translate(90px, 20px)');
    expect(scaleProbeRenders).toBe(before);
    expect(screen.getByTestId('scale-probe').textContent).toBe('1');
    // A zoom does move it, and then it must.
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByTestId('scale-probe').textContent).not.toBe('1');
  });

  it('hands screen-anchored overlays the VIEWPORT to portal into', () => {
    render(
      <CanvasViewport>
        <HostProbe />
      </CanvasViewport>,
    );
    // The plane carries the transform; anything centred on the screen has to
    // hang off its untransformed parent instead (M29.51).
    expect(screen.getByTestId('host-probe').textContent).toBe('canvas-viewport');
  });

  it('defaults to scale 1 and NO overlay host outside any viewport', () => {
    render(
      <>
        <ScaleProbe />
        <HostProbe />
      </>,
    );
    expect(screen.getByTestId('scale-probe').textContent).toBe('1');
    expect(screen.getByTestId('host-probe').textContent).toBe('none');
  });

  it('snaps back a scroll it did not ask for, so focus cannot lose the diagram', () => {
    render(<CanvasViewport>x</CanvasViewport>);
    const viewport = screen.getByTestId('canvas-viewport');
    // `overflow-hidden` stops the user, not the browser: focusing anything the
    // zoomed plane has pushed out of view makes Chromium scroll this element,
    // and pan/zoom write the plane's TRANSFORM — so nothing in the UI could
    // undo it and the diagram simply left (measured live: scrollLeft 1654 from
    // one double-click rename, Fit and Reset both powerless). M29.51.
    viewport.scrollLeft = 240;
    viewport.scrollTop = 90;
    fireEvent.scroll(viewport);
    expect(viewport.scrollLeft).toBe(0);
    expect(viewport.scrollTop).toBe(0);
  });
});
