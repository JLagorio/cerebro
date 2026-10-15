import type { Box, ItemKey } from './model';
export interface PlacedBox {
  readonly key: ItemKey;
  readonly box: Box;
}
export type Alignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
/** Align against the complete selection; all written positions are integers. */
export function alignBoxes(items: readonly PlacedBox[], mode: Alignment): PlacedBox[] {
  if (items.length < 2) return [...items];
  const left = Math.min(...items.map((i) => i.box.x)),
    right = Math.max(...items.map((i) => i.box.x + i.box.width));
  const top = Math.min(...items.map((i) => i.box.y)),
    bottom = Math.max(...items.map((i) => i.box.y + i.box.height));
  return items.map(({ key, box }) => ({
    key,
    box: {
      ...box,
      ...(mode === 'left'
        ? { x: left }
        : mode === 'right'
          ? { x: right - box.width }
          : mode === 'center'
            ? { x: Math.round((left + right - box.width) / 2) }
            : {}),
      ...(mode === 'top'
        ? { y: top }
        : mode === 'bottom'
          ? { y: bottom - box.height }
          : mode === 'middle'
            ? { y: Math.round((top + bottom - box.height) / 2) }
            : {}),
    },
  }));
}
/** Equal edge-to-edge gaps, including negative gaps; outer boxes stay fixed. */
export function distribute(
  items: readonly PlacedBox[],
  axis: 'horizontal' | 'vertical',
): PlacedBox[] {
  if (items.length < 3) return [...items];
  const position = axis === 'horizontal' ? 'x' : 'y',
    size = axis === 'horizontal' ? 'width' : 'height';
  const sorted = [...items].sort((a, b) => a.box[position] - b.box[position]);
  const first = sorted[0],
    last = sorted.at(-1)!;
  const span = last.box[position] + last.box[size] - first.box[position];
  const gap = (span - sorted.reduce((sum, item) => sum + item.box[size], 0)) / (sorted.length - 1);
  let cursor = first.box[position];
  return sorted.map((item, i) => {
    const next =
      i === 0 || i === sorted.length - 1
        ? item
        : { ...item, box: { ...item.box, [position]: Math.round(cursor) } };
    cursor += item.box[size] + gap;
    return next;
  });
}
