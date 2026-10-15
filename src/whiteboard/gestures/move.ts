import { getItem, membersOf } from '@/engine/scene/board';
import type { Board, ItemKey } from '@/engine/scene/model';
import type { Preview } from './types';
/** A group's membership is fixed from the start board, never recomputed
 * from a preview that has already moved it past another card. */
export function moveKeys(board: Board, selection: Iterable<ItemKey>): ItemKey[] {
  const keys = new Set(selection);
  for (const key of [...keys])
    if (key.startsWith('n:')) for (const member of membersOf(board, key.slice(2))) keys.add(member);
  return [...keys];
}
export function movePreview(
  board: Board,
  keys: readonly ItemKey[],
  dx: number,
  dy: number,
): Preview {
  const result: Preview = new Map();
  for (const key of keys) {
    const item = getItem(board, key);
    if (item && 'width' in item) result.set(key, { ...item, x: item.x + dx, y: item.y + dy });
  }
  return result;
}
