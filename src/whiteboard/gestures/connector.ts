import { addCards, addEdges } from '@/engine/scene/commands';
import { defaultBox } from '@/engine/scene/draw';
import type { Point } from '@/engine/scene/figure';
import type { Command } from '@/engine/scene/model';
import type { PortTarget } from '@/engine/scene/ports';

/** Compose the new-card and connection commands before the editor records
 * either, so a refused edge cannot leave an orphan card or a second undo. */
export const connectCards: Command<{
  from: PortTarget;
  to: PortTarget | null;
  point: Point;
  line: boolean;
  color?: string | null;
  cardColor?: string | null;
}> = (board, payload, context) => {
  const { from, point, line } = payload;
  let to = payload.to,
    next = board,
    selected: `n:${string}` | null = null;
  if (to?.node === from.node) return { ok: true, board, label: 'Connect cards' };
  if (to === null) {
    const added = addCards(
      board,
      {
        cards: [
          {
            type: 'text',
            text: '',
            shape: 'rectangle',
            ...defaultBox(point, 'text'),
            ...(payload.cardColor ? { color: payload.cardColor } : {}),
          },
        ],
      },
      context,
    );
    if (!added.ok) return added;
    next = added.board;
    const id = [...next.nodes.keys()].find((id) => !board.nodes.has(id))!;
    to = { node: id };
    selected = `n:${id}`;
  }
  const connected = addEdges(
    next,
    {
      edges: [
        {
          fromNode: from.node,
          toNode: to.node,
          ...(from.side ? { fromSide: from.side } : {}),
          ...(to.side ? { toSide: to.side } : {}),
          ...(line ? { toEnd: 'none' as const } : {}),
          ...(payload.color ? { color: payload.color } : {}),
        },
      ],
    },
    context,
  );
  return connected.ok
    ? { ...connected, label: 'Connect cards', ...(selected ? { selection: [selected] } : {}) }
    : connected;
};
