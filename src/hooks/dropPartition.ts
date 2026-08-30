/**
 * Which drop target the pointer is in, for a column of stacked targets
 * (M46.2 Task 3).
 *
 * `sortableGeometry.ts` is the same split one drag family over: the numbers
 * that decide WHERE a thing lands live in a pure module a test can drive,
 * because jsdom computes no layout and the browser is the only other place
 * these rects exist.
 *
 * ## The defect this exists to close
 *
 * The layout canvas registered its `DropSlot`s as dnd-kit droppables and let
 * the default `rectIntersection` pick the winner. That resolves a target by
 * OVERLAP between the dragged element's rect and a droppable's rect — so a
 * slot of height `h` at pitch `p`, dragged by a grip of height `d`, is live
 * only while the grip's leading edge sits in `(slotTop - d, slotTop + h)`.
 * Consecutive slots therefore meet only when `p <= h + d`, and where they do
 * not, the shortfall is `p - h - d` pixels in which NOTHING is lit.
 *
 * The baseline measured exactly that:
 * `docs/superpowers/specs/2026-08-29-cerebro-drag-baseline.md` §D7/D9 swept
 * the canvas at 1px and found y 225-247 -> slot 0, **248-250 -> nothing**,
 * 251-279 -> slot 1 — a 3px void, twice in one 90px sweep, from a 33px pitch
 * against a 6px slot and a 24px grip. Widening the slot by 3px would have
 * closed that ONE arithmetic and reopened the moment any of the three numbers
 * moved.
 *
 * ## The rule instead
 *
 * A target is not a rect you must touch; it is a REGION of the axis, and the
 * regions partition the column:
 *
 * 1. **Containment wins.** A pointer inside a target's own extent belongs to
 *    that target (the smallest one, if extents nest). This is what keeps a
 *    tall area target — the heading strip, the rest block — owning all of
 *    itself even when a thin slot sits close underneath it.
 * 2. **Otherwise, nearest centre.** The boundary between two neighbours is the
 *    midpoint of their centres, which is also Notion's measured above/below
 *    flip (§D9).
 *
 * Rule 2 alone already covers every point of the axis — a midpoint partition
 * has no holes by construction, whatever the pitch, the target height or the
 * size of the thing being dragged — and rule 1 only re-labels points rule 2
 * had already claimed. So the gap cannot reopen when spacing changes: there
 * is no arithmetic left that could fail to meet.
 *
 * ## Why ONE axis
 *
 * Every target in this column is a full-width sibling of every other, so the
 * cross axis carries no information about which one you mean — and consulting
 * it would actively lie: the canvas's field grips sit in a gutter 20px OUTSIDE
 * the slots' own left edge, so a cross-axis bound would blank the target for
 * the whole gesture. A surface whose targets sit side by side needs this rule
 * applied on ITS axis, not this function applied to a second one — `alongX`
 * below is that mapping, and the dashboard (M46.2 Task 4) spends it twice,
 * once per stage, rather than once over both dimensions.
 */

/** The part of a rect this file needs — `DOMRect` and dnd-kit's `ClientRect`
 * both satisfy it. */
export interface TargetRect {
  top: number;
  bottom: number;
}

/**
 * The same rule read along X (M46.2 Task 4).
 *
 * The rule above is about an AXIS; `top` and `bottom` are only the names the
 * first caller — and `DOMRect` — gave that axis's two ends. A surface whose
 * targets sit side by side (the dashboard's widget row: thin vertical slots
 * between widgets) needs the identical partition on its own axis, so it maps
 * its rects through here rather than growing a second, drifting copy of the
 * midpoint rule.
 *
 * Two dimensions are two applications of it, never one function over both: a
 * dashboard resolves the ROW by y and then the slot within that row by x, and
 * each stage is a column of siblings on one axis.
 */
export function alongX(rect: { left: number; right: number }): TargetRect {
  return { top: rect.left, bottom: rect.right };
}

/** One registered drop target and where it sits on the axis. */
export interface DropTarget {
  id: string;
  rect: TargetRect;
}

/**
 * A target's region of the axis, inclusive at both ends. Adjacent bands share
 * their boundary value; the resolver takes the EARLIER band, so a shared pixel
 * still belongs to exactly one target.
 */
export interface Band {
  id: string;
  from: number;
  to: number;
}

const centre = (r: TargetRect) => (r.top + r.bottom) / 2;

/**
 * The targets' regions of the axis, in leading-to-trailing order.
 *
 * Ordered by centre — a target's centre is what its neighbours' boundaries are
 * measured against, and ordering by `top` instead would put a tall area target
 * before a thin slot that sits above its middle. Ties break on `top` and then
 * on `id`, so the partition is the same one on every frame.
 *
 * The first band starts at the stack's leading edge and the last ends at its
 * trailing one, because carrying a drag off the END of a column is not a drop
 * — see `resolveDropTarget`.
 */
export function targetBands(targets: DropTarget[]): Band[] {
  if (targets.length === 0) return [];
  const sorted = [...targets].sort((a, b) => {
    const d = centre(a.rect) - centre(b.rect);
    if (d !== 0) return d;
    const t = a.rect.top - b.rect.top;
    return t !== 0 ? t : a.id.localeCompare(b.id);
  });
  const top = Math.min(...sorted.map((t) => t.rect.top));
  const bottom = Math.max(...sorted.map((t) => t.rect.bottom));
  return sorted.map((t, i) => ({
    id: t.id,
    from: i === 0 ? top : (centre(sorted[i - 1].rect) + centre(t.rect)) / 2,
    to: i === sorted.length - 1 ? bottom : (centre(t.rect) + centre(sorted[i + 1].rect)) / 2,
  }));
}

/**
 * The target at `pointer` on the axis, or `null` when the pointer has left the
 * stack past one of its ends.
 *
 * Off the ends is deliberately still nothing: carrying a section up above the
 * whole property stack and letting go commits no move, which is what it did
 * before and what a user expects from dragging something off the edge. What is
 * NOT nothing any more is being *between* two targets.
 */
export function resolveDropTarget(pointer: number, targets: DropTarget[]): string | null {
  if (targets.length === 0) return null;

  // Rule 1 — containment, smallest extent first so a nested target beats the
  // area it sits in.
  const inside = targets
    .filter((t) => pointer >= t.rect.top && pointer <= t.rect.bottom)
    .sort((a, b) => a.rect.bottom - a.rect.top - (b.rect.bottom - b.rect.top));
  if (inside.length > 0) return inside[0].id;

  // Rule 2 — the midpoint partition, bounded by the stack's own ends.
  const band = targetBands(targets).find((b) => pointer >= b.from && pointer <= b.to);
  return band?.id ?? null;
}
