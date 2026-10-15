import { edgeRoute, type Point } from '@/engine/scene/figure';
import type { Board, ItemKey } from '@/engine/scene/model';
import { updateEdges } from '@/engine/scene/commands';
import type { Command } from '@/engine/scene/model';
import type { PortTarget } from '@/engine/scene/ports';
export interface Endpoint {
  edge: string;
  end: 'from' | 'to';
}
export function endpointAt(
  board: Board,
  selection: ReadonlySet<ItemKey>,
  point: Point,
  scale: number,
): Endpoint | null {
  if (selection.size !== 1) return null;
  const key = [...selection][0];
  if (!key.startsWith('e:')) return null;
  const edge = board.edges.get(key.slice(2));
  if (!edge) return null;
  const a = board.nodes.get(edge.fromNode),
    b = board.nodes.get(edge.toNode);
  if (!a || !b) return null;
  const route = edgeRoute(edge, a, b);
  for (const end of ['from', 'to'] as const)
    if (Math.hypot(point.x - route[end].x, point.y - route[end].y) <= 8 / Math.max(0.1, scale))
      return { edge: edge.id, end };
  return null;
}
export const reconnectEdge: Command<{ endpoint: Endpoint; target: PortTarget | null }> = (
  board,
  { endpoint, target },
  ctx,
) => {
  const edge = board.edges.get(endpoint.edge);
  const other = endpoint.end === 'from' ? edge?.toNode : edge?.fromNode;
  if (!edge || !target || target.node === other) return { ok: true, board, label: 'Reconnect' };
  return updateEdges(
    board,
    {
      updates: [
        {
          id: edge.id,
          set: {
            [`${endpoint.end}Node`]: target.node,
            [`${endpoint.end}Side`]: target.side ?? null,
          },
        },
      ],
    },
    ctx,
  );
};
