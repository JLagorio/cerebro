import { paintOrder } from './board';
import { edgeRoute, sideAnchor, type EdgeRoute, type Point } from './figure';
import { hitAt } from './pick';
import type { Board, BoardNode, Side } from './model';

export interface PortTarget {
  readonly node: string;
  readonly side?: Side;
}
const NORMALS: Readonly<Record<Side, Point>> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};
/** Ports live beyond the resize band; their reach stays in screen pixels. */
export function portPoints(node: BoardNode, scale = 1): { side: Side; point: Point }[] {
  const reach = 14 / Math.max(0.1, scale);
  return (Object.keys(NORMALS) as Side[]).map((side) => {
    const anchor = sideAnchor(node, side),
      normal = NORMALS[side];
    return { side, point: { x: anchor.x + normal.x * reach, y: anchor.y + normal.y * reach } };
  });
}
export function portAt(board: Board, point: Point, scale = 1): PortTarget | null {
  let nearest: PortTarget | null = null,
    distance = 12 / Math.max(0.1, scale);
  for (const entry of paintOrder(board).reverse()) {
    if (entry.kind !== 'n') continue;
    for (const port of portPoints(entry.item, scale)) {
      const next = Math.hypot(point.x - port.point.x, point.y - port.point.y);
      if (next <= distance && (nearest === null || next < distance)) {
        distance = next;
        nearest = { node: entry.item.id, side: port.side };
      }
    }
  }
  if (nearest) return nearest;
  // Reuse the card/group picking rule without connections or ink masking it.
  const hit = hitAt({ ...board, edges: new Map(), ink: new Map() }, point, scale);
  return hit?.startsWith('n:') ? { node: hit.slice(2) } : null;
}
/** A preview has no disk carrier until both ends have a real card. */
export function freeRoute(
  board: Board,
  from: PortTarget,
  point: Point,
  to?: PortTarget | null,
): EdgeRoute | null {
  const source = board.nodes.get(from.node);
  if (!source) return null;
  const target = to ? board.nodes.get(to.node) : undefined;
  return edgeRoute(
    {
      id: 'preview',
      z: 'a0',
      fromNode: from.node,
      toNode: to?.node ?? '\0preview',
      ...(from.side ? { fromSide: from.side } : {}),
      ...(to?.side ? { toSide: to.side } : {}),
    },
    source,
    target ?? { x: point.x, y: point.y, width: 0, height: 0 },
  );
}
