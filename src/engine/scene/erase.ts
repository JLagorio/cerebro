import type { Point } from './figure';
import type { Board, ItemKey } from './model';
import { hitAt } from './pick';

/** A fast sweep samples the whole segment, using the same visible-shape
 * rule as selection. Groups own their border/label, never their interior. */
export function eraseHits(board: Board, from: Point, to: Point, radius = 10): Set<ItemKey> {
  const found = new Set<ItemKey>();
  const steps = Math.max(
    1,
    Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / Math.max(0.5, radius / 2)),
  );
  const remaining = {
    ...board,
    nodes: new Map(board.nodes),
    edges: new Map(board.edges),
    ink: new Map(board.ink),
  };
  for (let i = 0; i <= steps; i++) {
    const point = {
      x: from.x + ((to.x - from.x) * i) / steps,
      y: from.y + ((to.y - from.y) * i) / steps,
    };
    for (;;) {
      const key = hitAt(remaining, point, 6 / Math.max(0.5, radius));
      if (key === null) break;
      found.add(key);
      const map = key.startsWith('n:')
        ? remaining.nodes
        : key.startsWith('e:')
          ? remaining.edges
          : remaining.ink;
      map.delete(key.slice(2));
    }
  }
  return found;
}
