import { getItem, paintOrder } from './board';
import { edgeLabelBox, edgeRoute, groupLabelBox, routeSamples, type Point } from './figure';
import type { Board, Box, ItemKey } from './model';

export const containsPoint = (box: Box, point: Point): boolean =>
  point.x >= box.x &&
  point.y >= box.y &&
  point.x <= box.x + box.width &&
  point.y <= box.y + box.height;
export const containsBox = (outer: Box, inner: Box): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;
export const intersects = (a: Box, b: Box): boolean =>
  a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
export const betweenPoints = (a: Point, b: Point): Box => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y),
});
export function segmentDistance(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t =
    length === 0
      ? 0
      : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length));
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}
function nearLine(point: Point, points: readonly Point[], tolerance: number): boolean {
  return points.length === 1
    ? Math.hypot(point.x - points[0].x, point.y - points[0].y) <= tolerance
    : points.some((next, i) => i > 0 && segmentDistance(point, points[i - 1], next) <= tolerance);
}
/** Edges paint over cards; ink paints last. Groups own their frame and label,
 * so empty space inside one remains available for a marquee. */
export function hitAt(board: Board, point: Point, scale = 1): ItemKey | null {
  const tolerance = 6 / Math.max(0.1, scale);
  const items = paintOrder(board).reverse();
  for (const entry of items) {
    if (entry.kind !== 'e') continue;
    const from = board.nodes.get(entry.item.fromNode),
      to = board.nodes.get(entry.item.toNode);
    if (!from || !to) continue;
    const route = edgeRoute(entry.item, from, to);
    if (
      (entry.item.label && containsPoint(edgeLabelBox(entry.item, route), point)) ||
      nearLine(point, routeSamples(route), tolerance)
    )
      return entry.key;
  }
  for (const entry of items) {
    if (entry.kind === 'e') continue;
    const item = entry.item;
    if (entry.kind === 'i') {
      const points: Point[] = [];
      for (let i = 0; i < entry.item.points.length; i += 3)
        points.push({
          x: item.x + entry.item.points[i] / 10,
          y: item.y + entry.item.points[i + 1] / 10,
        });
      if (nearLine(point, points, tolerance + entry.item.size / 2)) return entry.key;
      continue;
    }
    const node = entry.item;
    if (node.type === 'group') {
      if (node.label && containsPoint(groupLabelBox(node), point)) return entry.key;
      const expanded = {
        x: node.x - tolerance,
        y: node.y - tolerance,
        width: node.width + 2 * tolerance,
        height: node.height + 2 * tolerance,
      };
      const inner = {
        x: node.x + tolerance,
        y: node.y + tolerance,
        width: Math.max(0, node.width - 2 * tolerance),
        height: Math.max(0, node.height - 2 * tolerance),
      };
      if (containsPoint(expanded, point) && !containsPoint(inner, point)) return entry.key;
      continue;
    }
    if (!containsPoint(node, point)) continue;
    if (node.type === 'text' && node.shape !== 'rectangle') {
      const nx = (point.x - node.x - node.width / 2) / (node.width / 2),
        ny = (point.y - node.y - node.height / 2) / (node.height / 2);
      if (node.shape === 'ellipse' ? nx * nx + ny * ny <= 1 : Math.abs(nx) + Math.abs(ny) <= 1)
        return entry.key;
    } else return entry.key;
  }
  return null;
}
export function marqueeHits(board: Board, box: Box): ItemKey[] {
  return paintOrder(board).flatMap((entry) =>
    entry.kind === 'e'
      ? []
      : (
            entry.kind === 'n' && entry.item.type === 'group'
              ? containsBox(box, entry.item)
              : intersects(box, entry.item)
          )
        ? [entry.key]
        : [],
  );
}
export function selectionBox(board: Board, keys: Iterable<ItemKey>): Box | null {
  let result: Box | null = null;
  for (const key of keys) {
    const item = getItem(board, key);
    if (!item || !('width' in item)) continue;
    if (result === null) result = { x: item.x, y: item.y, width: item.width, height: item.height };
    else {
      const x = Math.min(result.x, item.x),
        y = Math.min(result.y, item.y);
      result = {
        x,
        y,
        width: Math.max(result.x + result.width, item.x + item.width) - x,
        height: Math.max(result.y + result.height, item.y + item.height) - y,
      };
    }
  }
  return result;
}
