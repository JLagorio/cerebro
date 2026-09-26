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
