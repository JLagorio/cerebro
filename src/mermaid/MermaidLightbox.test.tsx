import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '@/stores/uiStore';
import { MermaidLightbox } from './MermaidLightbox';

// Only the three IO functions are mocked: viewBoxRect is pure parsing the
// viewer reads its own geometry from, and a whole-module factory would hand
// back undefined for it.
// jsdom implements no PointerEvent, so RTL builds a bare Event for
// `fireEvent.pointerDown` and every property the init carried — `button`,
// `clientX` — arrives undefined, which the viewer's own `e.button !== 0` guard
// then refuses. CanvasViewport.test.tsx carries the same shim for the same
// reason; pointerId and pressure are meaningless under it, so nothing here
// asserts on them.
if (typeof window.PointerEvent === 'undefined') {
  window.PointerEvent = MouseEvent as unknown as typeof window.PointerEvent;
}

vi.mock('./export', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./export')>()),
  copySvg: vi.fn().mockResolvedValue(undefined),
  copyPng: vi.fn().mockResolvedValue(undefined),
  savePng: vi.fn().mockResolvedValue('/tmp/x.png'),
}));

import { copySvg, savePng } from './export';

describe('MermaidLightbox', () => {
  const svg = '<svg data-fake="z"></svg>';

  beforeEach(() => {
    useUiStore.setState({ toasts: [] });
  });

  it('renders the svg and a 100% zoom readout', () => {
    render(<MermaidLightbox open svg={svg} title="Diagram" onClose={() => {}} />);
    expect(screen.getByTestId('lightbox-canvas').innerHTML).toContain('data-fake="z"');
    expect(screen.getByRole('button', { name: 'Reset zoom' }).textContent).toContain('100%');
  });

  it('zoom buttons change the scale readout', async () => {
    render(<MermaidLightbox open svg={svg} title="Diagram" onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByRole('button', { name: 'Reset zoom' }).textContent).toContain('110%');
    await userEvent.click(screen.getByRole('button', { name: 'Reset zoom' }));
    expect(screen.getByRole('button', { name: 'Reset zoom' }).textContent).toContain('100%');
  });

  it('wheel zooms the canvas', () => {
    render(<MermaidLightbox open svg={svg} title="Diagram" onClose={() => {}} />);
    fireEvent.wheel(screen.getByTestId('lightbox-viewport'), { deltaY: -1 });
    expect(screen.getByRole('button', { name: 'Reset zoom' }).textContent).toContain('110%');
  });

  it('copy SVG goes through the export module', async () => {
    render(<MermaidLightbox open svg={svg} title="Diagram" onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy SVG' }));
    expect(vi.mocked(copySvg)).toHaveBeenCalledWith(svg);
  });

  it('toasts a specific failure when copy SVG rejects', async () => {
    vi.mocked(copySvg).mockRejectedValueOnce(new Error('denied'));
    render(<MermaidLightbox open svg={svg} title="Diagram" onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy SVG' }));
    await waitFor(() => expect(useUiStore.getState().toasts.length).toBe(1));
    expect(useUiStore.getState().toasts[0].message).toBe('Copy SVG failed');
  });

  it('does not toast success when save PNG resolves null (cancelled)', async () => {
    vi.mocked(savePng).mockResolvedValueOnce(null);
    render(<MermaidLightbox open svg={svg} title="Diagram" onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Save PNG…' }));
    // Give the resolved promise's .then a turn to run, then confirm nothing toasted.
    await waitFor(() => expect(vi.mocked(savePng)).toHaveBeenCalled());
    expect(useUiStore.getState().toasts).toEqual([]);
  });
});

/**
 * The lightbox shows the SAME svg the inline view did, anchors and all, and
 * it is the surface a reader is most likely to click around in.
 */
describe('MermaidLightbox cannot navigate the app away (M29.38)', () => {
  const linked = (gen: string, target: string): string =>
    `<svg data-gen="${gen}"><g class="nodes">` +
    `<a href="${target}"><g class="node clickable"/></a>` +
    `<a xlink:href="${target}"><g class="node clickable"/></a></g></svg>`;

  const liveTargets = (root: ParentNode): string[] =>
    [...root.querySelectorAll('a')].flatMap((a) =>
      [...a.attributes].filter((at) => at.localName === 'href').map((at) => at.value),
    );

  it('strips every link target, and again when a different diagram is shown', () => {
    const { rerender } = render(
      <MermaidLightbox open svg={linked('1', 'notes/a.md')} title="D" onClose={() => {}} />,
    );
    const canvas = screen.getByTestId('lightbox-canvas');
    expect(canvas.querySelectorAll('a')).toHaveLength(2);
    expect(liveTargets(canvas)).toEqual([]);

    rerender(
      <MermaidLightbox
        open
        svg={linked('2', 'https://example.com/')}
        title="D"
        onClose={() => {}}
      />,
    );
    expect(
      screen.getByTestId('lightbox-canvas').querySelector('svg')?.getAttribute('data-gen'),
    ).toBe('2');
    expect(liveTargets(screen.getByTestId('lightbox-canvas'))).toEqual([]);
  });

  it('and on a REOPEN, which rebuilds the canvas without remounting this component', () => {
    const svg = linked('1', 'notes/a.md');
    const { rerender } = render(
      <MermaidLightbox open={false} svg={svg} title="D" onClose={() => {}} />,
    );
    expect(screen.queryByTestId('lightbox-canvas')).toBeNull();
    rerender(<MermaidLightbox open svg={svg} title="D" onClose={() => {}} />);
    const canvas = screen.getByTestId('lightbox-canvas');
    expect(canvas.querySelectorAll('a')).toHaveLength(2);
    expect(liveTargets(canvas)).toEqual([]);
  });

  it('and through a re-render, which React would otherwise use to rewrite the subtree', () => {
    render(<MermaidLightbox open svg={linked('1', 'notes/a.md')} title="D" onClose={() => {}} />);
    expect(liveTargets(screen.getByTestId('lightbox-canvas'))).toEqual([]);
    // A pan or a zoom is a state change, and React re-applies
    // dangerouslySetInnerHTML on the prop object's IDENTITY, not on its string
    // — an inline literal would restore every href on the first pan frame.
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByTestId('lightbox-canvas').querySelectorAll('a')).toHaveLength(2);
    expect(liveTargets(screen.getByTestId('lightbox-canvas'))).toEqual([]);
  });
});

/**
 * A modal viewer has to swallow the keys the editor underneath it would act on
 * (M29.53). This Dialog renders IN PLACE, inside BlockNote's contenteditable,
 * and the block carries a ProseMirror NodeSelection from the click that opened
 * the viewer — MEASURED: one printable keystroke with focus on the Close
 * button took strategy/systems-map.md from 842 bytes and four fences to 653
 * and three, one whole block per keystroke, with the "## Rollout" heading
 * going with it.
 */
describe('MermaidLightbox keeps its keystrokes', () => {
  function mounted() {
    const onKeyDown = vi.fn();
    render(
      <div onKeyDown={onKeyDown}>
        <MermaidLightbox open svg="<svg/>" title="D" onClose={() => {}} />
      </div>,
    );
    return onKeyDown;
  }

  it('stops a printable key and a Backspace from reaching the document editor', () => {
    const onKeyDown = mounted();
    const close = screen.getByRole('button', { name: 'Close' });
    fireEvent.keyDown(close, { key: 'a' });
    fireEvent.keyDown(close, { key: 'Backspace' });
    fireEvent.keyDown(close, { key: '=' });
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it("lets Escape past, because closing is the dialog's own answer to it", () => {
    const onKeyDown = mounted();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close' }), { key: 'Escape' });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });
});

/**
 * The viewer's geometry, with rects a browser would have given us (M29.53).
 * jsdom reports 0x0 for everything, which is why none of this could be
 * asserted before — and why all three defects shipped.
 */
describe('MermaidLightbox geometry', () => {
  const WIDE = '<svg viewBox="0 0 1440 148"><g/></svg>';

  function measure(): () => void {
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const box =
        this.getAttribute('data-testid') === 'lightbox-viewport'
          ? { left: 0, top: 0, width: 900, height: 500 }
          : { left: 0, top: 0, width: 0, height: 0 };
      return {
        ...box,
        right: box.left + box.width,
        bottom: box.top + box.height,
        x: box.left,
        y: box.top,
        toJSON: () => ({}),
      } as DOMRect;
    };
    return () => {
      Element.prototype.getBoundingClientRect = original;
    };
  }

  const canvas = () => screen.getByTestId('lightbox-canvas');

  it("opens on a fit, and 100% means the diagram's own size", () => {
    const restore = measure();
    try {
      render(<MermaidLightbox open svg={WIDE} title="D" onClose={() => {}} />);
      // MEASURED before this: a 1440-unit gantt opened filling 17.3% of the
      // viewer with 6.3px date labels while the readout said "100%" — and the
      // sequence diagram beside it was at natural size for the same "100%".
      expect(screen.getByRole('button', { name: 'Reset zoom' }).textContent).toBe('61%');
      // The svg is pinned to its own units, which is what makes that true.
      expect(canvas().querySelector('svg')?.style.width).toBe('1440px');
      expect(canvas().style.transform).toContain('scale(0.6083333333333333)');
    } finally {
      restore();
    }
  });

  it('has a Fit control at all', () => {
    render(<MermaidLightbox open svg={WIDE} title="D" onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Fit diagram' })).toBeTruthy();
  });

  it('anchors a wheel zoom on the pointer', () => {
    const restore = measure();
    try {
      render(<MermaidLightbox open svg={WIDE} title="D" onClose={() => {}} />);
      const before = canvas().style.transform;
      fireEvent.wheel(screen.getByTestId('lightbox-viewport'), {
        deltaY: -1,
        clientX: 100,
        clientY: 100,
      });
      // MEASURED before this: with the pointer parked on an actor box, four
      // wheel steps moved that box 287.2px away from the cursor. Anchoring
      // means the offset moves with the scale rather than staying put.
      expect(canvas().style.transform).not.toBe(before);
      expect(canvas().style.transform).toContain('scale(0.6691666666666667)');
      // The point under the cursor is preserved: x' = px - (px - x)·k.
      const x = Number(/translate\((-?[\d.]+)px/.exec(canvas().style.transform)?.[1]);
      const x0 = Number(/translate\((-?[\d.]+)px/.exec(before)?.[1]);
      expect(x).toBeCloseTo(100 - (100 - x0) * 1.1, 6);
    } finally {
      restore();
    }
  });

  it('clamps a pan, so the diagram cannot leave the viewer entirely', () => {
    const restore = measure();
    try {
      render(<MermaidLightbox open svg={WIDE} title="D" onClose={() => {}} />);
      const vp = screen.getByTestId('lightbox-viewport');
      fireEvent.pointerDown(vp, { button: 0, clientX: 400, clientY: 250 });
      // MEASURED before this: one continuous drag put the canvas at
      // (-2135, -1633) against a 912x540 viewer — an intersection of exactly
      // 0px², an empty grey box, and no hint of where the diagram went.
      fireEvent.pointerMove(vp, { clientX: -3000, clientY: -3000 });
      fireEvent.pointerUp(vp);
      const [, x, y] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(
        canvas().style.transform,
      ) as unknown as [string, string, string];
      // 48px of the diagram stays on screen in each axis.
      expect(Number(x)).toBeCloseTo(48 - 1440 * 0.6083333333333333, 6);
      expect(Number(y)).toBeCloseTo(48 - 148 * 0.6083333333333333, 6);
    } finally {
      restore();
    }
  });
});
