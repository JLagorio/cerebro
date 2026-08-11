import { useEffect, type RefObject } from 'react';

/**
 * The smallest fraction of its natural size a diagram may be shrunk to in order
 * to fit a document column, and how far past the column it is then allowed to
 * extend (M29.52).
 *
 * Mermaid renders with `useMaxWidth`, so its svg carries `max-width: <natural>px`
 * and our hosts add `max-w-full` — the two together fit any diagram to its
 * container, however small that makes it. For a flowchart that is fine; for a
 * wide one it is not. MEASURED on `demo-vault/strategy/systems-map.md`: the
 * gantt's viewBox is 1600 units in a 638px column, a scale of 0.399, so its
 * 10px labels render at 3.99px. That is not a small diagram, it is an unreadable
 * one, and nothing on screen tells the reader the full-size view exists.
 *
 * Below MIN_SCALE the svg stops shrinking and the host scrolls instead. The
 * scroll is bounded by MAX_OVERFLOW so a very wide diagram cannot turn a
 * document into a horizontal scroller — past that it goes back to shrinking,
 * because an unreachable diagram is worse than a small one.
 */
const MIN_SCALE = 0.55;
const MAX_OVERFLOW = 1.6;

/** Mermaid's own `max-width: <n>px`, i.e. the svg's natural width in px. */
function naturalWidth(svg: SVGSVGElement): number | null {
  const declared = svg.style.maxWidth.match(/^([\d.]+)px$/);
  if (declared !== null) return Number(declared[1]);
  // No max-width means mermaid was configured without useMaxWidth; the viewBox
  // is then the only statement of natural size it has made.
  const vb = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  return vb.length === 4 && vb[2] > 0 ? vb[2] : null;
}

/**
 * Keeps a rendered diagram legible inside a document column.
 *
 * Sets `min-width` on the host's own svg — never `width`, so a diagram that
 * already fits is untouched and the value is re-derived from scratch on every
 * pass rather than compounding. Reruns whenever the svg changes (`token`) and
 * whenever the column resizes.
 */
export function useLegibleWidth(ref: RefObject<HTMLElement | null>, token: unknown): void {
  useEffect(() => {
    const host = ref.current;
    if (host === null) return;
    const apply = () => {
      const svg = host.querySelector('svg');
      if (svg === null) return;
      // Clear first: the floor is a function of the CURRENT column width, and a
      // stale min-width would be part of the box we are about to measure.
      svg.style.minWidth = '';
      const natural = naturalWidth(svg);
      const column = host.clientWidth;
      if (natural === null || natural <= 0 || column <= 0) return;
      if (natural <= column) return; // fits already; nothing to floor
      const floor = Math.min(natural * MIN_SCALE, column * MAX_OVERFLOW);
      if (floor > column) svg.style.minWidth = `${Math.round(floor)}px`;
    };
    apply();
    // jsdom has no ResizeObserver; the one-shot pass above is the whole
    // behaviour there, which is what the tests pin.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(apply);
    ro.observe(host);
    return () => ro.disconnect();
  }, [ref, token]);
}
