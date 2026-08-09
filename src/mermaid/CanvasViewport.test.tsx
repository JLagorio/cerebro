import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CanvasViewport, useCanvasTransform } from './CanvasViewport';

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
        </svg>
        <div data-no-pan data-testid="island" />
      </CanvasViewport>,
    );
    for (const id of ['n', 'island']) {
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
});
