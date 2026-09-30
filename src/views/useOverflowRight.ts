import { useEffect, useState, type CSSProperties, type RefObject } from 'react';

/**
 * Whether a scroller has more to its right than it shows (M52.5) — for a
 * strip or a table that scrolls sideways with its scrollbar hidden or far
 * below, where a hard cut at the edge ("+ Vi", "Shapin") gave no sign that
 * anything continued.
 *
 * Read on scroll and on resize of the scroller or its content. The tolerance
 * is whole pixels for `TableView`'s reason: fractional widths land a fraction
 * under `scrollWidth` at the real edge, and a comparison that flips on
 * rounding alone flickers the fade.
 */
export function useOverflowRight(
  ref: RefObject<HTMLElement | null>,
  /** Anything that changes what the scroller holds without resizing it — a
   * tab added — so the answer is read again. */
  content: unknown = null,
): boolean {
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const read = () =>
      setMore(Math.ceil(el.scrollLeft + el.clientWidth) < Math.floor(el.scrollWidth) - 2);
    read();
    el.addEventListener('scroll', read, { passive: true });
    const observer = new ResizeObserver(read);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => {
      el.removeEventListener('scroll', read);
      observer.disconnect();
    };
  }, [ref, content]);
  return more;
}

/** The fade a scroller wears while `useOverflowRight` says it continues: its
 * last 32px dissolve into whatever is behind it, rather than stopping on a
 * cut. A mask, not an overlay, so it fades onto any background. */
export const FADE_RIGHT: CSSProperties = {
  maskImage: 'linear-gradient(to right, #000 calc(100% - 32px), transparent)',
  WebkitMaskImage: 'linear-gradient(to right, #000 calc(100% - 32px), transparent)',
};
