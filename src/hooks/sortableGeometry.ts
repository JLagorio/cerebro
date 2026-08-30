/**
 * The slot maths of a C-I list reorder (M46.2 Task 2).
 *
 * Pure numbers, deliberately: the hook reads rects and paints styles, and
 * everything that decides WHERE a row goes lives here where a test can drive
 * it without a layout engine. `workspace/tabDrag.ts` is the same split, one
 * drag system over.
 *
 * The grammar is Notion's, measured in
 * `docs/superpowers/specs/2026-08-29-notion-drag-and-row-reference.md` §C-I:
 * a list reorder has no ghost and no insertion line. The rows themselves move
 * — the dragged one under the cursor, the others out of its way — and the gap
 * that opens IS the indicator.
 *
 * Two places where we do NOT copy the measurement:
 *
 * - **Pitch.** Notion's list is 7 × 38px and its maths says `slot × 38`. Ours
 *   are property rows, popover rows, tab strips and chain levels, and nothing
 *   guarantees two of them are the same size. Every row carries its own size
 *   and every gap its own width, so a uniform list reduces to `slot × pitch`
 *   and a ragged one still lands each row on a real edge.
 * - **The up direction.** Notion measured the flip going DOWN only. Going up
 *   is the symmetric rule — the midpoint crossing the neighbour's trailing
 *   edge — which we are choosing, not copying.
 */

/** The part of a `DOMRect` this file needs. */
export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Which way the list runs. The tab strips are the horizontal consumers. */
export type Axis = 'x' | 'y';

/**
 * One list, measured at grab time.
 *
 * "Main" is along the list, "cross" is across it. Everything is relative to
 * the container's padding edge, because that is what `top: 0; left: 0` on an
 * absolutely positioned child means.
 */
export interface ListMetrics {
  /** Leading edge of slot 0. */
  start: number;
  /** Main-axis extent of each row, in the order it was measured. */
  sizes: number[];
  /**
   * Space AFTER each slot: `gaps[k]` sits between slot k and slot k + 1, so
   * `sizes.length - 1` of them. The gap belongs to the slot rather than to the
   * row in it, which is what lets the identity order reproduce the measured
   * offsets exactly however ragged the list is.
   */
  gaps: number[];
  /** Cross-axis offset of each row — non-zero when a row bleeds out sideways. */
  cross: number[];
  /** Cross-axis extent of each row. */
  crossSizes: number[];
}

/** Read a frozen list's geometry off its rows' rects. */
export function measureRows(
  rows: Rect[],
  origin: { top: number; left: number },
  axis: Axis,
): ListMetrics {
  const main = (r: Rect) => (axis === 'y' ? r.top - origin.top : r.left - origin.left);
  const size = (r: Rect) => (axis === 'y' ? r.height : r.width);
  const offsets = rows.map(main);
  const sizes = rows.map(size);
  return {
    start: offsets[0] ?? 0,
    sizes,
    // Never negative: rows that overlap would invert the two thresholds below,
    // leaving the up rule to decide both directions. The layout is then off by
    // the overlap, which is a pixel and not a wrong order.
    gaps: sizes.slice(0, -1).map((s, i) => Math.max(0, offsets[i + 1] - (offsets[i] + s))),
    cross: rows.map((r) => (axis === 'y' ? r.left - origin.left : r.top - origin.top)),
    crossSizes: rows.map((r) => (axis === 'y' ? r.width : r.height)),
  };
}

/** First leading edge to last trailing edge — what the frozen list spans. */
export function extentOf(m: ListMetrics): number {
  const rows = m.sizes.reduce((a, b) => a + b, 0);
  return rows + m.gaps.reduce((a, b) => a + b, 0);
}

/** `[0..n)` with `from` lifted out and put back down at `to`. */
export function orderWith(n: number, from: number, to: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  return order;
}

/** Leading edge of each POSITION, for one order. */
export function slotOffsets(m: ListMetrics, order: number[]): number[] {
  const offsets: number[] = [];
  let at = m.start;
  order.forEach((row, position) => {
    offsets.push(at);
    at += m.sizes[row] + (m.gaps[position] ?? 0);
  });
  return offsets;
}

/** Leading edge of each ROW, with the dragged row resting in `slot`. */
export function offsetByRow(m: ListMetrics, from: number, slot: number): number[] {
  const order = orderWith(m.sizes.length, from, slot);
  const offsets = slotOffsets(m, order);
  const byRow = new Array<number>(order.length);
  order.forEach((row, position) => {
    byRow[row] = offsets[position];
  });
  return byRow;
}

/** Hold the dragged row inside the list, however far the pointer travels. */
export function clampMain(m: ListMetrics, from: number, pos: number): number {
  const last = m.start + extentOf(m) - (m.sizes[from] ?? 0);
  return Math.min(Math.max(pos, m.start), Math.max(m.start, last));
}

/**
 * The slot the dragged row belongs in, given where its midpoint now is.
 *
 * Notion's rule, measured: the swap fires when the dragged row's MIDPOINT
 * crosses the neighbour's leading edge — not the pointer, and not the row's
 * own top edge, both of which fire a half-row early or late.
 *
 * The thresholds are read off the layout the OTHER rows take with the dragged
 * row lifted out, which does not depend on the slot — so the answer is a
 * function of the midpoint alone and the same pointer position cannot produce
 * two different slots on two consecutive moves. `slot` is passed in only for
 * the band between the two thresholds, which is the gap wide and belongs to
 * whoever holds it.
 *
 * **Horizontal lists take exactly this rule**, with "leading edge" meaning the
 * left edge and the midpoint meaning the horizontal one — a tab moves right
 * once its own centre passes the left edge of the tab to its right. Notion has
 * no measured horizontal list, so the axis generalisation is ours; what it
 * preserves is the property that made the rule feel right vertically, which is
 * that the flip is about the two ROWS overlapping and never about the pointer.
 */
export function slotFor(m: ListMetrics, from: number, slot: number, mid: number): number {
  const n = m.sizes.length;
  if (n === 0) return 0;
  const others = orderWith(n, from, n - 1).slice(0, n - 1);
  // The gap the dragged row carries with it. Our lists space their rows with
  // one flex `gap`, so every entry is the same number; a list that spaced its
  // rows individually would move its flip point by the difference, never the
  // resulting order.
  const spacing = m.gaps[Math.min(from, m.gaps.length - 1)] ?? 0;
  const pitch = m.sizes[from] + spacing;

  // Where the others sit with the dragged row lifted out.
  let at = m.start;
  const closed = others.map((row, position) => {
    const edge = at;
    at += m.sizes[row] + (m.gaps[position] ?? 0);
    return edge;
  });

  // Down: the neighbour below has been pushed one pitch further along, and its
  // leading edge is what the midpoint has to cross.
  const down = (k: number) => closed[k] + pitch;
  // Up: the neighbour above has NOT moved, so it is its trailing edge.
  const up = (k: number) => closed[k - 1] + m.sizes[others[k - 1]];

  // Down first, then up, both to exhaustion: a move that jumps several rows at
  // once lands where it was dropped rather than one slot per event. On a
  // uniform list the second loop can never undo the first (`down(k)` sits a gap
  // beyond `up(k + 1)`); on a ragged one, where a neighbour is taller than the
  // dragged row's whole pitch, the two cross and the up rule decides — which is
  // the conservative answer, and the one that keeps the opened gap under the
  // row you are holding.
  let next = slot;
  while (next < n - 1 && mid > down(next)) next += 1;
  while (next > 0 && mid < up(next)) next -= 1;
  return next;
}
