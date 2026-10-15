import type { Board, NewCard } from '@/engine/scene/model';
export type BoardEditing =
  | { kind: 'draft'; id: string; card: Extract<NewCard, { type: 'text' }> }
  | { kind: 'node'; id: string; initial: string; label: boolean }
  | { kind: 'edge'; id: string; initial: string; label: true };
export function textEditing(board: Board, id: string, edge = false): BoardEditing | null {
  if (edge) {
    const connection = board.edges.get(id);
    return connection ? { kind: 'edge', id, initial: connection.label ?? '', label: true } : null;
  }
  const node = board.nodes.get(id);
  return node?.type === 'text'
    ? { kind: 'node', id, initial: node.text, label: false }
    : node?.type === 'group'
      ? { kind: 'node', id, initial: node.label ?? '', label: true }
      : null;
}
