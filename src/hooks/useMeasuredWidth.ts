import { useCallback, useState } from 'react';
import { flushSync } from 'react-dom';

/**
 * An element's width as React state, measured by a ResizeObserver (M52).
 *
 * Returns a callback ref and the width. `null` until the first observation,
 * and for a box with no width at all — jsdom lays nothing out, and a 0 read
 * as a measurement would squeeze every panel to its floor in tests that never
 * asked about layout. Callers treat `null` as "draw the stored preference".
 *
 * `beforePaint` is for a width that decides what is DRAWN, like whether a
 * page's side panel still fits beside its column. An observer reports after
 * layout and before paint, but a plain state update renders in a later task
 * — after the frame has been painted with the old answer, which on a fast
 * window resize put a doc's side panel 70–120px past the canvas for a frame.
 * Flushed synchronously inside the observer, the render lands in the same
 * frame: the browser lays the page out again before it paints. A width that
 * only labels something can wait, and should — every flush is a render in
 * the middle of the frame.
 */
export function useMeasuredWidth({ beforePaint = false }: { beforePaint?: boolean } = {}): [
  (el: HTMLElement | null) => (() => void) | undefined,
  number | null,
] {
  const [width, setWidth] = useState<number | null>(null);
  const ref = useCallback(
    (el: HTMLElement | null) => {
      if (el === null) return undefined;
      const observer = new ResizeObserver(([first]) => {
        const next = first?.contentRect.width ?? 0;
        const update = () => setWidth(next > 0 ? Math.round(next) : null);
        if (beforePaint) flushSync(update);
        else update();
      });
      observer.observe(el);
      return () => observer.disconnect();
    },
    [beforePaint],
  );
  return [ref, width];
}
