import { boardBounds } from './board';
import type { Board, BoardEdge, Box, GroupCard, Side } from './model';

export interface Point {
  readonly x: number;
  readonly y: number;
}
export interface EdgeRoute {
  readonly from: Point;
  readonly c1: Point;
  readonly c2: Point;
  readonly to: Point;
  readonly path: string;
}
const normal: Record<Side, Point> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};
/** Includes connection paint too: SVG overflow can draw outside the cards,
 * but a standalone export is clipped to its viewBox. The cubic control hull
 * bounds every point on its curve without a sampled approximation. */
export function sceneBox(board: Board): Box {
  const box = boardBounds(board);
  if (box === null) return { x: -400, y: -300, width: 800, height: 600 };
  let left = box.x,
    top = box.y,
    right = box.x + box.width,
    bottom = box.y + box.height;
  const include = (point: Point) => {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  };
  for (const edge of board.edges.values()) {
    const from = board.nodes.get(edge.fromNode),
      to = board.nodes.get(edge.toNode);
    if (!from || !to) continue;
    const curve = edgeRoute(edge, from, to);
    [curve.from, curve.c1, curve.c2, curve.to].forEach(include);
    if (edge.fromEnd === 'arrow') arrowHead(curve.from, curve.c1).forEach(include);
    if (edge.toEnd !== 'none') arrowHead(curve.to, curve.c2).forEach(include);
    if (edge.label) {
      const label = edgeLabelBox(edge, curve);
      include(label);
      include({ x: label.x + label.width, y: label.y + label.height });
    }
  }
  return { x: left - 64, y: top - 64, width: right - left + 128, height: bottom - top + 128 };
}
export function sideAnchor(box: Box, side: Side): Point {
  return {
    x: box.x + (side === 'left' ? 0 : side === 'right' ? box.width : box.width / 2),
    y: box.y + (side === 'top' ? 0 : side === 'bottom' ? box.height : box.height / 2),
  };
}
export function facingSides(from: Box, to: Box): { from: Side; to: Side } {
  const dx = to.x + to.width / 2 - from.x - from.width / 2;
  const dy = to.y + to.height / 2 - from.y - from.height / 2;
  return Math.abs(dx) >= Math.abs(dy)
    ? { from: dx >= 0 ? 'right' : 'left', to: dx >= 0 ? 'left' : 'right' }
    : { from: dy >= 0 ? 'bottom' : 'top', to: dy >= 0 ? 'top' : 'bottom' };
}
const route = (from: Point, c1: Point, c2: Point, to: Point): EdgeRoute => ({
  from,
  c1,
  c2,
  to,
  path: `M ${from.x} ${from.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${to.x} ${to.y}`,
});
export function selfLoop(box: Box): EdgeRoute {
  const from = sideAnchor(box, 'right');
  const to = sideAnchor(box, 'top');
  const reach = Math.max(32, Math.min(160, Math.max(box.width, box.height) / 2));
  return route(from, { x: from.x + reach, y: from.y }, { x: to.x, y: to.y - reach }, to);
}
export function edgeRoute(edge: BoardEdge, from: Box, to: Box): EdgeRoute {
  if (edge.fromNode === edge.toNode && edge.fromSide === undefined && edge.toSide === undefined)
    return selfLoop(from);
  const facing = facingSides(from, to);
  const fromSide = edge.fromSide ?? facing.from;
  const toSide = edge.toSide ?? facing.to;
  const a = sideAnchor(from, fromSide);
  const b = sideAnchor(to, toSide);
  const distance = Math.max(24, Math.min(160, Math.hypot(b.x - a.x, b.y - a.y) / 2));
  return route(
    a,
    { x: a.x + normal[fromSide].x * distance, y: a.y + normal[fromSide].y * distance },
    { x: b.x + normal[toSide].x * distance, y: b.y + normal[toSide].y * distance },
    b,
  );
}
function at(curve: EdgeRoute, t: number): Point {
  const u = 1 - t;
  return {
    x:
      u * u * u * curve.from.x +
      3 * u * u * t * curve.c1.x +
      3 * u * t * t * curve.c2.x +
      t * t * t * curve.to.x,
    y:
      u * u * u * curve.from.y +
      3 * u * u * t * curve.c1.y +
      3 * u * t * t * curve.c2.y +
      t * t * t * curve.to.y,
  };
}
export function routeSamples(curve: EdgeRoute, steps = 24): Point[] {
  const count = Math.max(1, Math.min(256, Math.floor(steps) || 1));
  return Array.from({ length: count + 1 }, (_, i) => at(curve, i / count));
}
export const labelAnchor = (curve: EdgeRoute): Point => at(curve, 0.5);
/** Triangle points behind the tip, oriented along the final tangent. */
export function arrowHead(tip: Point, previous: Point, size = 9): readonly Point[] {
  const length = Math.hypot(tip.x - previous.x, tip.y - previous.y) || 1;
  const dx = (tip.x - previous.x) / length;
  const dy = (tip.y - previous.y) / length;
  return [
    tip,
    { x: tip.x - dx * size - (dy * size) / 2, y: tip.y - dy * size + (dx * size) / 2 },
    { x: tip.x - dx * size + (dy * size) / 2, y: tip.y - dy * size - (dx * size) / 2 },
  ];
}
export function edgeLabelBox(edge: BoardEdge, curve: EdgeRoute): Box {
  const anchor = labelAnchor(curve);
  const width = Math.max(20, [...(edge.label ?? '')].length * 14 + 12);
  return { x: anchor.x - width / 2, y: anchor.y - 12, width, height: 24 };
}
export function groupLabelBox(group: GroupCard): Box {
  return {
    x: group.x + 8,
    y: group.y + 6,
    width: Math.min(
      Math.max(0, group.width - 16),
      Math.max(20, [...(group.label ?? '')].length * 8 + 12),
    ),
    height: Math.max(0, Math.min(24, group.height - 6)),
  };
}
