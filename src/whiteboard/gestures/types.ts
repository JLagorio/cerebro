import type { Board, Box, Item, ItemKey } from '@/engine/scene/model';
export type Preview = Map<ItemKey, Item | null>;
export interface GestureStart {
  board: Board;
  keys: readonly ItemKey[];
  box: Box | null;
}
