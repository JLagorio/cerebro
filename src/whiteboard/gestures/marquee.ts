import type { Board, Box, ItemKey } from '@/engine/scene/model';
import { marqueeHits } from '@/engine/scene/pick';
export function marqueeSelection(
  board: Board,
  box: Box,
  baseline: Iterable<ItemKey>,
  add: boolean,
): Set<ItemKey> {
  return new Set([...(add ? baseline : []), ...marqueeHits(board, box)]);
}
