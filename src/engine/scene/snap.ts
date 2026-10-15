import type { Box } from './model';
import { resizeBox, type ResizeHandle, type ResizeOptions } from './resize';
export interface Guide {
  axis: 'x' | 'y';
  position: number;
  from: number;
  to: number;
}
export interface SnapOptions {
  scale: number;
  grid: boolean;
  objects: boolean;
  gridSize: number;
}
const lines = (box: Box, axis: 'x' | 'y') =>
  axis === 'x'
    ? [box.x, box.x + box.width / 2, box.x + box.width]
    : [box.y, box.y + box.height / 2, box.y + box.height];
function snapAxis(
  box: Box,
  axis: 'x' | 'y',
  moving: readonly number[],
  targets: readonly Box[],
  options: SnapOptions,
): { delta: number; guide: Guide | null } {
  let best: { delta: number; target: Box; position: number } | null = null;
  if (options.objects)
    for (const target of targets)
      for (const line of lines(target, axis))
        for (const current of moving) {
          const delta = line - current;
          if (
            Math.abs(delta) <= 6 / Math.max(0.1, options.scale) &&
            (best === null || Math.abs(delta) < Math.abs(best.delta))
          )
            best = { delta, target, position: line };
        }
  if (best !== null)
    return {
      delta: best.delta,
      guide: {
        axis,
        position: best.position,
        from: axis === 'x' ? Math.min(box.y, best.target.y) : Math.min(box.x, best.target.x),
        to:
          axis === 'x'
            ? Math.max(box.y + box.height, best.target.y + best.target.height)
            : Math.max(box.x + box.width, best.target.x + best.target.width),
      },
    };
  const current = moving[0];
  return {
    delta:
      options.grid && current !== undefined && options.gridSize > 0
        ? Math.round(current / options.gridSize) * options.gridSize - current
        : 0,
    guide: null,
  };
}
export function snapMove(
  box: Box,
  dx: number,
  dy: number,
  targets: readonly Box[],
  options: SnapOptions,
): { dx: number; dy: number; guides: Guide[] } {
  const moved = { ...box, x: box.x + dx, y: box.y + dy };
  const x = snapAxis(moved, 'x', lines(moved, 'x'), targets, options),
    y = snapAxis(moved, 'y', lines(moved, 'y'), targets, options);
  return {
    dx: Math.round(dx + x.delta),
    dy: Math.round(dy + y.delta),
    guides: [x.guide, y.guide].filter((g): g is Guide => g !== null),
  };
}
/** Only edges under the handle seek a snap. Reapplying resize preserves the
 * opposite anchor, centre and ratio constraints after that correction. */
export function snapResize(
  start: Box,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  targets: readonly Box[],
  options: SnapOptions & ResizeOptions,
): { box: Box; guides: Guide[] } {
  const candidate = resizeBox(start, handle, dx, dy, options);
  const xs = handle.includes('w')
    ? [candidate.x]
    : handle.includes('e')
      ? [candidate.x + candidate.width]
      : [];
  const ys = handle.includes('n')
    ? [candidate.y]
    : handle.includes('s')
      ? [candidate.y + candidate.height]
      : [];
  const x = snapAxis(candidate, 'x', xs, targets, options),
    y = snapAxis(candidate, 'y', ys, targets, options);
  const box = resizeBox(start, handle, dx + x.delta, dy + y.delta, options);
  // A ratio lock may move one axis away from its candidate; do not promise a
  // guide unless the final edge actually lands there.
  const guides = [x.guide, y.guide]
    .filter((g): g is Guide => g !== null)
    .filter(
      (g) =>
        Math.abs(
          (g.axis === 'x'
            ? handle.includes('w')
              ? box.x
              : box.x + box.width
            : handle.includes('n')
              ? box.y
              : box.y + box.height) - g.position,
        ) < 1,
    );
  return { box, guides };
}
