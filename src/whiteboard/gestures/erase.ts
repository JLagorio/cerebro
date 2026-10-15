import { eraseHits } from '@/engine/scene/erase';
import type { Point } from '@/engine/scene/figure';
import type { Board, ItemKey } from '@/engine/scene/model';
export function eraseSweep(
  board: Board,
  found: ReadonlySet<ItemKey>,
  from: Point,
  to: Point,
  radius: number,
): Set<ItemKey> {
  return new Set([...found, ...eraseHits(board, from, to, radius)]);
}
