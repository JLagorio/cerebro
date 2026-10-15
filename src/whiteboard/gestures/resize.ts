import { getItem } from '@/engine/scene/board';
import { scaleStroke } from '@/engine/scene/ink';
import type { Board, Box, ItemKey } from '@/engine/scene/model';
import { scaleBoxes } from '@/engine/scene/resize';
import type { Preview } from './types';
export function resizePreview(board: Board, keys: readonly ItemKey[], from: Box, to: Box): Preview {
  const boxes = keys.flatMap((key) => {
    const item = getItem(board, key);
    return item && 'width' in item ? [{ key, box: item }] : [];
  });
  const result: Preview = new Map();
  for (const { key, box } of scaleBoxes(boxes, from, to)) {
    const item = getItem(board, key)!;
    result.set(key, 'points' in item ? scaleStroke(item, box) : { ...item, ...box });
  }
  return result;
}
