import { getItem, refused, settle } from './board';
import { normalizeColor } from './colors';
import type { Board, Command, Item, ItemKey } from './model';
import type { PlacedBox } from './arrange';
export const MIXED = Symbol('mixed');
export function common<T>(values: readonly T[]): T | typeof MIXED | undefined {
  return values.length === 0
    ? undefined
    : values.every((value) => Object.is(value, values[0]))
      ? values[0]
      : MIXED;
}
export function selectedItems(
  board: Board,
  selection: Iterable<ItemKey>,
): { key: ItemKey; item: Item }[] {
  return [...selection].flatMap((key) => {
    const item = getItem(board, key);
    return item ? [{ key, item }] : [];
  });
}
export function selectedBoxes(board: Board, selection: Iterable<ItemKey>): PlacedBox[] {
  return selectedItems(board, selection).flatMap(({ key, item }) =>
    'width' in item
      ? [{ key, box: { x: item.x, y: item.y, width: item.width, height: item.height } }]
      : [],
  );
}
export function sectionsFor(board: Board, selection: Iterable<ItemKey>) {
  const chosen = selectedItems(board, selection),
    items = chosen.map((c) => c.item);
  const boxes = items.filter((item) => 'width' in item).length;
  return {
    count: items.length,
    position: boxes > 0,
    color: items.length > 0,
    shape: items.some((item) => 'type' in item && item.type === 'text'),
    ink: items.some((item) => 'points' in item),
    group: items.some((item) => 'type' in item && item.type === 'group'),
    connection: items.some((item) => 'fromNode' in item),
    pointer: items.some((item) => 'type' in item && (item.type === 'file' || item.type === 'link')),
    align: boxes >= 2 ? boxes : 0,
    distribute: boxes >= 3 ? boxes : 0,
  };
}
/** One colour edit can cover cards, connections and drawings together. */
export const colorItems: Command<{ keys: readonly ItemKey[]; color: string | null }> = (
  board,
  { keys, color },
) => {
  const normalized = color === null ? null : normalizeColor(color);
  if (color !== null && normalized === null)
    return refused('color', 'Use a preset or a hex colour.');
  const nodes = new Map(board.nodes),
    edges = new Map(board.edges),
    ink = new Map(board.ink);
  for (const { key, item } of selectedItems(board, keys)) {
    if ((item.color ?? null) === normalized) continue;
    const next = { ...item };
    if (normalized === null) delete (next as { color?: string }).color;
    else (next as { color?: string }).color = normalized;
    if (key.startsWith('n:') && 'type' in next) nodes.set(next.id, next);
    else if (key.startsWith('e:') && 'fromNode' in next) edges.set(next.id, next);
    else if ('points' in next) ink.set(next.id, next);
  }
  return settle(board, { ...board, nodes, edges, ink }, 'Change colour');
};
export const sizeInk: Command<{ keys: readonly ItemKey[]; size: number }> = (
  board,
  { keys, size },
) => {
  if (!Number.isInteger(size) || size < 1 || size > 32)
    return refused('ink', 'Drawing width must be a whole number from 1 to 32.');
  const ink = new Map(board.ink);
  for (const { item } of selectedItems(board, keys))
    if ('points' in item && item.size !== size) ink.set(item.id, { ...item, size });
  return settle(board, { ...board, ink }, 'Change drawing width');
};
