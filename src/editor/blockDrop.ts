/**
 * Where a dragged block would land (M48.4).
 *
 * Pure geometry over measured boxes, so the rule that decides a drop can be
 * tested without a browser — which matters more here than usual. The drag this
 * replaces was BlockNote's, built on the browser's own HTML5 drag-and-drop,
 * and MEASURED: neither Playwright's `dragTo` nor a hand-stepped mouse drag
 * can drive it. Every behaviour built on that drag was therefore untestable by
 * construction, so "it moves, but feels wrong" had no way to become "it moves
 * like this, and here is the test that says so".
 *
 * The whole document is one list of horizontal insertion lines, columns
 * included. A column's contents stack exactly like a page's do, so dropping
 * INTO a column is not a special case — it is the ordinary case, at a greater
 * depth, and depth is only ever used to break a tie.
 */

/** One rendered block, as measured. `depth` is how deeply it is nested. */
export interface BlockBox {
  id: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
  depth: number;
}

/** A place the dragged block could go, and the line that says so. */
export interface DropSpot {
  /** The block this spot is relative to. */
  blockId: string;
  placement: 'before' | 'after';
  /** Where the line is drawn, in the same coordinates the boxes were measured in. */
  y: number;
  left: number;
  right: number;
  depth: number;
}

/**
 * Every gap in the document, as a line.
 *
 * Each block contributes the gap ABOVE it; only the last block of a run also
 * contributes the one below, so a gap between two siblings is offered once
 * rather than twice. Two spots at the same place would make the nearest-spot
 * search a coin toss between two identical answers that commit differently.
 */
export function dropSpotsFrom(boxes: BlockBox[]): DropSpot[] {
  const spots: DropSpot[] = [];
  for (let i = 0; i < boxes.length; i += 1) {
    const box = boxes[i];
    spots.push({
      blockId: box.id,
      placement: 'before',
      y: box.top,
      left: box.left,
      right: box.right,
      depth: box.depth,
    });
    // The gap below is somebody else's gap above, unless nobody follows this
    // block at its own depth or deeper.
    const next = boxes[i + 1];
    if (next === undefined || next.depth < box.depth) {
      spots.push({
        blockId: box.id,
        placement: 'after',
        y: box.bottom,
        left: box.left,
        right: box.right,
        depth: box.depth,
      });
    }
  }
  return spots;
}

/**
 * The spot the pointer is asking for.
 *
 * Spots whose horizontal span contains the pointer win outright — that is what
 * makes dragging into a column work without a rule about columns: over the left
 * column, only the left column's lines (and the whole list's) contain the
 * pointer's x. Among those, nearest vertically; and on a vertical tie the
 * DEEPER spot wins, because a column's interior and the list's exterior share
 * an edge and the more specific of the two is what somebody aiming there meant.
 *
 * Nothing under the pointer horizontally falls back to plain distance, so a
 * drag out past the margin still lands somewhere rather than nowhere.
 */
export function nearestDropSpot(spots: DropSpot[], x: number, y: number): DropSpot | null {
  if (spots.length === 0) return null;
  const over = spots.filter((s) => x >= s.left && x <= s.right);
  const pool = over.length > 0 ? over : spots;
  let best = pool[0];
  let bestScore = scoreOf(best, x, y, over.length > 0);
  for (const spot of pool.slice(1)) {
    const score = scoreOf(spot, x, y, over.length > 0);
    if (score < bestScore || (score === bestScore && spot.depth > best.depth)) {
      best = spot;
      bestScore = score;
    }
  }
  return best;
}

function scoreOf(spot: DropSpot, x: number, y: number, containsX: boolean): number {
  const dy = Math.abs(y - spot.y);
  if (containsX) return dy;
  const dx = x < spot.left ? spot.left - x : x > spot.right ? x - spot.right : 0;
  return dy + dx;
}

/**
 * Would this drop change anything?
 *
 * Dropping a block immediately above or below itself is the commonest gesture
 * there is — you pick a block up, think better of it, and let go. Running it as
 * a move would still be correct, but it would push an entry onto the undo stack
 * and mark the file dirty for a change nobody made.
 *
 * Adjacency in document order is NOT enough to decide this, and the case that
 * proves it is the one this milestone is about: the block just below a
 * paragraph may be the first block of a column, and moving the paragraph in
 * there changes its parent even though nothing moves more than a line. So the
 * two blocks must be siblings before adjacency means anything.
 */
export function isNoOpDrop(
  siblings: { id: string; parentId: string | null }[],
  draggedId: string,
  spot: DropSpot | null,
): boolean {
  if (spot === null) return true;
  if (spot.blockId === draggedId) return true;
  const from = siblings.findIndex((b) => b.id === draggedId);
  const to = siblings.findIndex((b) => b.id === spot.blockId);
  if (from < 0 || to < 0) return false;
  if (siblings[from].parentId !== siblings[to].parentId) return false;
  if (spot.placement === 'before') return to === from + 1;
  return to === from - 1;
}
