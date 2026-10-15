import { addCards } from '@/engine/scene/commands';
import type { Board, NewCard, TextCard } from '@/engine/scene/model';
export function draftCard(
  board: Board,
  id: string,
  card: Extract<NewCard, { type: 'text' }>,
): TextCard | null {
  const result = addCards(board, { cards: [card] }, { createId: () => id });
  return result.ok ? (result.board.nodes.get(id) as TextCard) : null;
}
