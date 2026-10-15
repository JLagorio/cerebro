import { itemKey, parseItemKey } from './board';
import type { Board, BoardEdge, BoardNode, FileFacts, InkStroke, Item, ItemKey } from './model';

/**
 * Per-item history (M68.1). A step records only the items a change touched,
 * by identity, each as it was before and after (absent on the side where it
 * didn't exist), plus the board's own facts when they changed. Undo and redo
 * apply an item only while it still holds the side they leave, so an undo
 * never overwrites a later change; they name the items they skipped. Nor
 * does either ever leave a connection without one of its cards.
 */

export interface StepItem {
  readonly key: ItemKey;
  readonly before?: Item;
  readonly after?: Item;
}

export interface BoardFacts {
  readonly facts?: FileFacts;
  readonly cerebro?: FileFacts;
}

export interface Step {
  readonly label: string;
  readonly items: readonly StepItem[];
  readonly board?: { readonly before: BoardFacts; readonly after: BoardFacts };
}

function diff<T extends Item>(
  kind: 'n' | 'e' | 'i',
  before: ReadonlyMap<string, T>,
  after: ReadonlyMap<string, T>,
  out: StepItem[],
): void {
  for (const [id, was] of before) {
    const now = after.get(id);
    if (now !== was)
      out.push({ key: itemKey(kind, id), before: was, ...(now ? { after: now } : {}) });
  }
  for (const [id, now] of after) {
    if (!before.has(id)) out.push({ key: itemKey(kind, id), after: now });
  }
}

const factsOf = (board: Board): BoardFacts => ({
  ...(board.facts ? { facts: board.facts } : {}),
  ...(board.cerebro ? { cerebro: board.cerebro } : {}),
});

/** The step from `before` to `after`, or null when they hold the same items and facts. */
export function stepBetween(before: Board, after: Board, label: string): Step | null {
  const items: StepItem[] = [];
  diff('n', before.nodes, after.nodes, items);
  diff('e', before.edges, after.edges, items);
  diff('i', before.ink, after.ink, items);
  const factsChanged = before.facts !== after.facts || before.cerebro !== after.cerebro;
  if (items.length === 0 && !factsChanged) return null;
  return {
    label,
    items,
    ...(factsChanged ? { board: { before: factsOf(before), after: factsOf(after) } } : {}),
  };
}

export interface Applied {
  readonly board: Board;
  /** The items left alone because they changed since, or because applying them would strand a connection. */
  readonly skipped: readonly ItemKey[];
  /** True when the board's own facts changed since and were left alone. */
  readonly factsSkipped: boolean;
}

/** Undoes or redoes `step` on `board`, item by item (see the file comment). */
export function applyStep(board: Board, step: Step, direction: 'undo' | 'redo'): Applied {
  const leave = direction === 'undo' ? 'after' : 'before';
  const enter = direction === 'undo' ? 'before' : 'after';
  const nodes = new Map(board.nodes);
  const edges = new Map(board.edges);
  const ink = new Map(board.ink);
  const skipped: ItemKey[] = [];
  const removedNodes = new Map<string, { key: ItemKey; was: BoardNode }>();

  const byKind = { n: [] as StepItem[], e: [] as StepItem[], i: [] as StepItem[] };
  for (const item of step.items) {
    const parsed = parseItemKey(item.key);
    if (parsed !== null) byKind[parsed.kind].push(item);
  }
  const idOf = (key: ItemKey) => key.slice(2);

  for (const item of byKind.n) {
    const id = idOf(item.key);
    const current = nodes.get(id);
    if (current !== item[leave]) {
      skipped.push(item.key);
      continue;
    }
    const target = item[enter] as BoardNode | undefined;
    if (target === undefined) {
      nodes.delete(id);
      if (current !== undefined) removedNodes.set(id, { key: item.key, was: current });
    } else nodes.set(id, target);
  }
  for (const item of byKind.e) {
    const id = idOf(item.key);
    if (edges.get(id) !== item[leave]) {
      skipped.push(item.key);
      continue;
    }
    const target = item[enter] as BoardEdge | undefined;
    if (target === undefined) edges.delete(id);
    else if (nodes.has(target.fromNode) && nodes.has(target.toNode)) edges.set(id, target);
    else skipped.push(item.key);
  }
  for (const item of byKind.i) {
    const id = idOf(item.key);
    if (ink.get(id) !== item[leave]) {
      skipped.push(item.key);
      continue;
    }
    const target = item[enter] as InkStroke | undefined;
    if (target === undefined) ink.delete(id);
    else ink.set(id, target);
  }
  // A card this step would remove stays while a connection still names it.
  for (const edge of edges.values()) {
    for (const end of [edge.fromNode, edge.toNode]) {
      const removed = removedNodes.get(end);
      if (removed === undefined) continue;
      nodes.set(end, removed.was);
      removedNodes.delete(end);
      skipped.push(removed.key);
    }
  }

  let next: Board = { ...board, nodes, edges, ink };
  let factsSkipped = false;
  if (step.board !== undefined) {
    const from = step.board[leave];
    const to = step.board[enter];
    if (board.facts === from.facts && board.cerebro === from.cerebro) {
      const { facts: _facts, cerebro: _cerebro, ...rest } = next;
      next = { ...rest, ...to };
    } else factsSkipped = true;
  }
  return { board: next, skipped, factsSkipped };
}
