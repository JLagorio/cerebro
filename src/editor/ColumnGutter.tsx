/**
 * Dragging the gutter between two columns (M48.5).
 *
 * The handle belongs to the column on the RIGHT of the gutter, because that is
 * the only column that can be sure there is one: the first column of a row has
 * nothing to its left and renders no handle at all. So a row of N columns has
 * N−1 gutters, which is the number of gutters a row of N columns has.
 *
 * The arithmetic is `resizeColumnPair` and is pure. This is the pointer loop,
 * and it follows the shape `ResizeHandle` established (M11, hardened in
 * M46.2): listeners on the WINDOW because the pointer leaves a 12px strip
 * immediately; the new width computed from where the drag STARTED rather than
 * accumulated per event, so a fast drag lands under the cursor instead of
 * drifting away from it; and Escape puts the ratios back where the grab found
 * them.
 *
 * It is a `separator` with arrow keys for the same reason that one is: a
 * pointer-only resize is a resize keyboard users do not have.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDragGesture } from '@/hooks/useDragGesture';
import { DEFAULT_COLUMN_WIDTH, resizeColumnPair } from '@/engine/pageColumns';

/** One arrow press, in pixels of gutter travel. */
const KEY_STEP = 24;

export function ColumnGutter({
  id,
  onResize,
}: {
  id: string;
  onResize: (left: number, right: number) => void;
}) {
  const host = useRef<HTMLButtonElement | null>(null);
  const [active, setActive] = useState(false);
  const gesture = useDragGesture();

  /**
   * The pair this gutter sits between, measured from the DOM.
   *
   * Read at grab time rather than held in props: the ratios live on two
   * different blocks and the widths in pixels live in the layout, and a
   * component that cached either would resize against a stale row after a
   * sibling changed.
   */
  const pair = () => {
    const outer = host.current?.closest('[data-node-type="blockOuter"]');
    const previous = outer?.previousElementSibling;
    if (!(outer instanceof HTMLElement) || !(previous instanceof HTMLElement)) return null;
    const ratioOf = (el: HTMLElement) => {
      const declared = el.querySelector('[data-content-type="column"]')?.getAttribute('data-width');
      return declared === null || declared === undefined ? DEFAULT_COLUMN_WIDTH : Number(declared);
    };
    const width = previous.getBoundingClientRect().width + outer.getBoundingClientRect().width;
    return { left: ratioOf(previous), right: ratioOf(outer), width };
  };

  const apply = (from: { left: number; right: number; width: number }, deltaPx: number) => {
    const [left, right] = resizeColumnPair(from.left, from.right, deltaPx, from.width);
    onResize(left, right);
  };

  /**
   * A NATIVE listener, not React's `onPointerDown`.
   *
   * MEASURED: the React handler never fired. BlockNote renders a custom block
   * into the ProseMirror DOM, and ProseMirror stops the pointer event on its
   * way up — so it never reaches the React root, which is where React 19
   * dispatches from. Bound on the element itself, this runs at the target
   * before any ancestor can swallow it. (The editor's block grip has no such
   * trouble: the side menu is drawn OUTSIDE the ProseMirror content.)
   */
  const onPointerDown = useCallback((event: PointerEvent) => {
    if (event.button !== 0) return;
    const from = pair();
    if (from === null) return;
    event.preventDefault();
    const startX = event.clientX;
    setActive(true);

    const move = (e: PointerEvent) => apply(from, e.clientX - startX);
    const teardown = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setActive(false);
    };
    // Escape abandons: the ratios go back to what the grab found, which on a
    // handle that paints by WRITING is a write of its own rather than the
    // absence of one.
    const cancel = () => {
      teardown();
      onResize(from.left, from.right);
    };
    function up() {
      gesture.end();
    }

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    gesture.begin(teardown, cancel);
    // The dependencies are a ref and two stable callbacks; `pair` and `apply`
    // are redefined per render by design and read only live DOM.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = host.current;
    if (el === null) return;
    el.addEventListener('pointerdown', onPointerDown);
    return () => el.removeEventListener('pointerdown', onPointerDown);
  }, [onPointerDown]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.key === 'ArrowLeft' ? -KEY_STEP : event.key === 'ArrowRight' ? KEY_STEP : 0;
    if (step === 0) return;
    const from = pair();
    if (from === null) return;
    event.preventDefault();
    apply(from, step);
  };

  return (
    <button
      ref={host}
      type="button"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column"
      data-testid="column-gutter"
      data-column={id}
      data-active={active ? 'true' : 'false'}
      onKeyDown={onKeyDown}
      className="cb-column-gutter"
    />
  );
}
