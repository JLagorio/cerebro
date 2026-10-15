import type { Point } from './figure';
import type { Box, ItemKey } from './model';
export const RESIZE_HANDLES = ['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w'] as const;
export type ResizeHandle = (typeof RESIZE_HANDLES)[number];
export interface ResizeOptions {
  keepRatio?: boolean;
  fromCenter?: boolean;
}
export function handlePoints(box: Box): { handle: ResizeHandle; point: Point }[] {
  return RESIZE_HANDLES.map((handle) => ({
    handle,
    point: {
      x: box.x + (handle.includes('w') ? 0 : handle.includes('e') ? box.width : box.width / 2),
      y: box.y + (handle.includes('n') ? 0 : handle.includes('s') ? box.height : box.height / 2),
    },
  }));
}
export function handleAt(box: Box, point: Point, scale = 1): ResizeHandle | null {
  return (
    handlePoints(box).find(
      (h) =>
        Math.abs(point.x - h.point.x) <= 6 / scale && Math.abs(point.y - h.point.y) <= 6 / scale,
    )?.handle ?? null
  );
}
/** Resize keeps its opposite edge (or centre) fixed and never flips. The UI's
 * minimum20 is independent of the file reader's valid1-unit boxes. */
export function resizeBox(
  start: Box,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  options: ResizeOptions = {},
): Box {
  const sx = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0,
    sy = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
  const factor = options.fromCenter ? 2 : 1;
  let width = Math.max(20, start.width + sx * dx * factor),
    height = Math.max(20, start.height + sy * dy * factor);
  if (options.keepRatio) {
    const wx = width / start.width,
      hy = height / start.height;
    const ratio = sx === 0 ? hy : sy === 0 ? wx : Math.abs(wx - 1) >= Math.abs(hy - 1) ? wx : hy;
    const bounded = Math.max(20 / start.width, 20 / start.height, ratio);
    width = start.width * bounded;
    height = start.height * bounded;
  }
  width = Math.round(width);
  height = Math.round(height);
  const x =
    options.fromCenter || sx === 0
      ? start.x + (start.width - width) / 2
      : sx < 0
        ? start.x + start.width - width
        : start.x;
  const y =
    options.fromCenter || sy === 0
      ? start.y + (start.height - height) / 2
      : sy < 0
        ? start.y + start.height - height
        : start.y;
  return { x: Math.round(x), y: Math.round(y), width, height };
}
export function scaleBoxes(
  boxes: readonly { key: ItemKey; box: Box }[],
  from: Box,
  to: Box,
): { key: ItemKey; box: Box }[] {
  return boxes.map(({ key, box }) => ({
    key,
    box: {
      x: Math.round(to.x + ((box.x - from.x) * to.width) / from.width),
      y: Math.round(to.y + ((box.y - from.y) * to.height) / from.height),
      width: Math.max(20, Math.round((box.width * to.width) / from.width)),
      height: Math.max(20, Math.round((box.height * to.height) / from.height)),
    },
  }));
}
