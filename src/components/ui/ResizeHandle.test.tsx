import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ownsEscape, pushLayer, resetLayers } from '@/components/ui/layers';
import { ResizeHandle } from '@/components/ui/ResizeHandle';

/**
 * The shared panel-edge resize (M11), and abandoning one (M46.2).
 *
 * The handle had no keydown listener at all, so Escape reached whatever
 * surface the panel was drawn inside and the release then wrote the width the
 * user was backing out of. Lower stakes than a reorder — a width, not an order
 * — but the same class of defect, and this one primitive is the sidebar's
 * edge, the record panel's, the assistant panel's and the time axis's.
 */

afterEach(cleanup);
afterEach(resetLayers);
afterEach(() => document.body.classList.remove('cb-resizing'));

const at = (type: string, clientX: number) => new MouseEvent(type, { clientX, bubbles: true });

function handle(onResize = vi.fn()) {
  const view = render(
    <ResizeHandle
      label="Resize panel"
      side="right"
      width={300}
      min={200}
      max={600}
      onResize={onResize}
    />,
  );
  return { onResize, unmount: view.unmount, el: screen.getByTestId('resize-right') };
}

const escape = () => fireEvent.keyDown(document.body, { key: 'Escape' });

describe('ResizeHandle Escape (M46.2)', () => {
  beforeEach(() => resetLayers());

  it('writes the width on release', () => {
    const { onResize, el } = handle();
    fireEvent(el, at('pointerdown', 100));
    fireEvent(window, at('pointermove', 200));
    fireEvent(window, at('pointerup', 200));
    expect(onResize).toHaveBeenLastCalledWith(400);
  });

  it('puts the width back on Escape, and the release writes nothing more', () => {
    const { onResize, el } = handle();
    fireEvent(el, at('pointerdown', 100));
    fireEvent(window, at('pointermove', 200));
    expect(onResize).toHaveBeenLastCalledWith(400);

    escape();

    // This handle paints by WRITING, so the restore is a write of its own.
    expect(onResize).toHaveBeenLastCalledWith(300);
    const written = onResize.mock.calls.length;
    fireEvent(window, at('pointerup', 200));
    // Without the cancel this release writes 400 — the measured defect.
    expect(onResize).toHaveBeenCalledTimes(written);
  });

  it('stops tracking the pointer, so a later move writes nothing', () => {
    const { onResize, el } = handle();
    fireEvent(el, at('pointerdown', 100));
    fireEvent(window, at('pointermove', 200));
    escape();
    const written = onResize.mock.calls.length;
    fireEvent(window, at('pointermove', 500));
    expect(onResize).toHaveBeenCalledTimes(written);
  });

  it('leaves a later drag able to write', () => {
    const { onResize, el } = handle();
    fireEvent(el, at('pointerdown', 100));
    fireEvent(window, at('pointermove', 200));
    escape();
    fireEvent(window, at('pointerup', 200));

    // A DIFFERENT width, so the assertion can tell the two worlds apart:
    // cancelling a drag to 400 and then repeating it lands on the very width
    // an uncancelled first drag would have produced.
    const before = onResize.mock.calls.length;
    fireEvent(el, at('pointerdown', 100));
    fireEvent(window, at('pointermove', 150));
    fireEvent(window, at('pointerup', 150));
    expect(onResize).toHaveBeenLastCalledWith(350);
    // Exactly one write per move plus one on the release: a cancelled gesture
    // that left its listeners attached would write twice on this release.
    expect(onResize.mock.calls.length - before).toBe(2);
  });

  it('keeps the keystroke away from the surface behind while a drag is live', () => {
    const { el } = handle();
    const onWindow = vi.fn();
    fireEvent(el, at('pointerdown', 100));
    fireEvent(window, at('pointermove', 200));
    window.addEventListener('keydown', onWindow);
    try {
      escape();
      // One Escape must not abandon the resize AND close the panel it resizes.
      expect(onWindow).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onWindow);
    }
  });

  it('takes Escape off the surface underneath for the length of the drag', () => {
    const { el } = handle();
    // What DetailPanel and Dialog both register; their handlers ask the stack
    // who owns the keystroke.
    pushLayer('panel');
    fireEvent(el, at('pointerdown', 100));
    fireEvent(window, at('pointermove', 200));
    expect(ownsEscape('panel')).toBe(false);
    escape();
    expect(ownsEscape('panel')).toBe(true);
  });

  it('hands the layer back on a normal release too', () => {
    const { el } = handle();
    pushLayer('panel');
    fireEvent(el, at('pointerdown', 100));
    fireEvent(window, at('pointermove', 200));
    fireEvent(window, at('pointerup', 200));
    expect(ownsEscape('panel')).toBe(true);
  });

  it('leaves no resizing cursor and no listeners when it unmounts mid-drag', () => {
    const { onResize, el, unmount } = handle();
    pushLayer('panel');
    fireEvent(el, at('pointerdown', 100));
    fireEvent(window, at('pointermove', 200));
    expect(document.body.classList.contains('cb-resizing')).toBe(true);

    unmount();

    // `cb-resizing` pins `cursor: col-resize` on the page. Stranded, it never
    // comes off — and a leaked gesture layer takes every later Escape.
    expect(document.body.classList.contains('cb-resizing')).toBe(false);
    expect(ownsEscape('panel')).toBe(true);
    const written = onResize.mock.calls.length;
    fireEvent(window, at('pointerup', 500));
    expect(onResize).toHaveBeenCalledTimes(written);
  });

  it('still resizes from the keyboard — Escape claims nothing when no drag is live', () => {
    const { onResize, el } = handle();
    escape();
    fireEvent.keyDown(el, { key: 'ArrowRight' });
    expect(onResize).toHaveBeenLastCalledWith(312);
  });
});

/**
 * A panel drawn narrower than its stored width (M52): the record peek beside
 * the assistant is capped by the room left, so what the handle sits on and
 * what the store holds differ.
 */
describe('ResizeHandle on a capped panel (M52)', () => {
  function capped(onResize = vi.fn()) {
    render(
      <ResizeHandle
        label="Resize panel"
        side="left"
        width={400}
        preferred={1000}
        min={360}
        max={500}
        onResize={onResize}
      />,
    );
    return { onResize, el: screen.getByTestId('resize-left') };
  }

  it('drags from the width it is drawn at, so there is no dead zone', () => {
    const { onResize, el } = capped();
    fireEvent(el, at('pointerdown', 500));
    fireEvent(window, at('pointermove', 480));
    // 400 drawn + 20 leftwards. Measured from the stored 1000 it jumped
    // straight to the ceiling, and a narrowing drag did nothing for 500px.
    expect(onResize).toHaveBeenLastCalledWith(420);
  });

  it('cannot widen past its ceiling, the room left beside the assistant', () => {
    const { onResize, el } = capped();
    fireEvent(el, at('pointerdown', 500));
    fireEvent(window, at('pointermove', 0));
    fireEvent(window, at('pointerup', 0));
    expect(onResize).toHaveBeenLastCalledWith(500);
  });

  it('puts the stored preference back on Escape, not the capped width', () => {
    const { onResize, el } = capped();
    fireEvent(el, at('pointerdown', 500));
    fireEvent(window, at('pointermove', 480));
    escape();
    expect(onResize).toHaveBeenLastCalledWith(1000);
  });

  it('reports the width it is drawn at', () => {
    const { el } = capped();
    expect(el.getAttribute('aria-valuenow')).toBe('400');
  });
});

/**
 * A panel capped AT its ceiling (M52): drawn at the room it has, which is under
 * its stored width. Verified at 1280 beside a record and the assistant: the
 * sidebar's ceiling was 180 with 264 stored, and a drag to widen it wrote 180
 * — the one width the ceiling allowed — and kept it once the room came back.
 */
describe('ResizeHandle at a ceiling under the stored width (M52)', () => {
  function atCeiling(onResize = vi.fn()) {
    render(
      <ResizeHandle
        label="Resize sidebar"
        side="right"
        width={180}
        preferred={264}
        min={180}
        max={180}
        onResize={onResize}
      />,
    );
    return { onResize, el: screen.getByTestId('resize-right') };
  }

  it('keeps the stored width through a drag that cannot widen the panel', () => {
    const { onResize, el } = atCeiling();
    fireEvent(el, at('pointerdown', 180));
    fireEvent(window, at('pointermove', 600));
    fireEvent(window, at('pointerup', 900));
    expect(onResize).toHaveBeenLastCalledWith(264);
    expect(onResize).not.toHaveBeenCalledWith(180);
  });

  it('keeps it through a key or a double-click that lands where it is drawn', () => {
    const { onResize, el } = atCeiling();
    fireEvent.keyDown(el, { key: 'ArrowRight' });
    fireEvent.keyDown(el, { key: 'ArrowLeft' });
    fireEvent.doubleClick(el);
    expect(onResize.mock.calls.every(([w]) => w === 264)).toBe(true);
  });

  it('still stores a narrower width when the drag draws one', () => {
    const onResize = vi.fn();
    render(
      <ResizeHandle
        label="Resize sidebar"
        side="right"
        width={340}
        preferred={460}
        min={180}
        max={340}
        onResize={onResize}
      />,
    );
    const el = screen.getByTestId('resize-right');
    fireEvent(el, at('pointerdown', 340));
    fireEvent(window, at('pointermove', 300));
    fireEvent(window, at('pointerup', 300));
    expect(onResize).toHaveBeenLastCalledWith(300);
    // And back out to where it started: the stored width again, not 340.
    fireEvent(el, at('pointerdown', 340));
    fireEvent(window, at('pointermove', 900));
    fireEvent(window, at('pointerup', 900));
    expect(onResize).toHaveBeenLastCalledWith(460);
  });
});
