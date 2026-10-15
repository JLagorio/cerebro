import { orderedEdges, orderedInk, orderedNodes } from './board';
import { writeCanvas } from './jsonCanvas';
import type { Board, FileFacts, Item, RawJson } from './model';
import { orderKeys } from './order';

/** Complete saved item bytes, including geometry and opaque extras. Search
 * text alone cannot distinguish a moved card from an unchanged one. z is
 * deliberately absent: the outside file supplies order independently. */
function itemBytes(item: Item | undefined): string | undefined {
  if (item === undefined) return undefined;
  return writeCanvas({
    nodes: new Map('type' in item ? [[item.id, item]] : []),
    edges: new Map('fromNode' in item ? [[item.id, item]] : []),
    ink: new Map('points' in item ? [[item.id, item]] : []),
  });
}
const rawBytes = (raw: RawJson | undefined) => JSON.stringify(raw);

export interface BoardMerge {
  readonly board: Board;
  readonly conflicts: number;
  readonly removedEdges: number;
}

/** Three-way, whole-item reconciliation. Disjoint edits survive; a conflict
 * keeps the person's open edit (including a deletion). Outside ordering wins,
 * with items that exist only in the open editor placed above it. */
export function mergeBoards(base: Board, mine: Board, theirs: Board): BoardMerge {
  let conflicts = 0;
  function choose<T>(before: T, local: T, outside: T, bytes: (value: T) => unknown): T {
    const a = bytes(before);
    const b = bytes(local);
    const c = bytes(outside);
    if (a === b) return outside;
    if (a === c || b === c) return local;
    conflicts += 1;
    return local;
  }
  function items<T extends Item>(
    before: ReadonlyMap<string, T>,
    local: ReadonlyMap<string, T>,
    outside: ReadonlyMap<string, T>,
    orderedOutside: readonly T[],
    orderedLocal: readonly T[],
  ): Map<string, T> {
    const ids = [...new Set([...orderedOutside, ...orderedLocal].map((item) => item.id))];
    const picked = ids.flatMap((id) => {
      const item = choose(before.get(id), local.get(id), outside.get(id), itemBytes);
      return item === undefined ? [] : [item];
    });
    const keys = orderKeys(picked.length);
    return new Map(
      picked.map((item, i) => [item.id, item.z === keys[i] ? item : { ...item, z: keys[i] }]),
    );
  }
  function facts(
    before: FileFacts | undefined,
    local: FileFacts | undefined,
    outside: FileFacts | undefined,
  ): FileFacts | undefined {
    if (local === undefined && outside === undefined) return undefined;
    const keys = [
      ...new Set([
        ...(outside?.extra.keys() ?? []),
        ...(local?.extra.keys() ?? []),
        ...(before?.extra.keys() ?? []),
      ]),
    ];
    const extra = new Map<string, RawJson>();
    for (const key of keys) {
      const value = choose(
        before?.extra.get(key),
        local?.extra.get(key),
        outside?.extra.get(key),
        rawBytes,
      );
      if (value !== undefined) extra.set(key, value);
    }
    const present = choose(
      before !== undefined,
      local !== undefined,
      outside !== undefined,
      (value) => value,
    );
    if (!present && extra.size === 0) return undefined;
    const keyOrder = [...new Set([...(outside?.keyOrder ?? []), ...(local?.keyOrder ?? [])])];
    return { extra, keyOrder };
  }
  const nodes = items(
    base.nodes,
    mine.nodes,
    theirs.nodes,
    orderedNodes(theirs),
    orderedNodes(mine),
  );
  const edges = items(
    base.edges,
    mine.edges,
    theirs.edges,
    orderedEdges(theirs),
    orderedEdges(mine),
  );
  const ink = items(base.ink, mine.ink, theirs.ink, orderedInk(theirs), orderedInk(mine));
  let removedEdges = 0;
  for (const [id, edge] of edges) {
    // A connection already dangling in the base is kept. Only losing a card
    // in this merge causes a connection to be removed.
    const lost = [edge.fromNode, edge.toNode].some(
      (end) =>
        !nodes.has(end) && (base.nodes.has(end) || mine.nodes.has(end) || theirs.nodes.has(end)),
    );
    if (lost) {
      edges.delete(id);
      removedEdges += 1;
    }
  }
  const top = facts(base.facts, mine.facts, theirs.facts);
  const cerebro = facts(base.cerebro, mine.cerebro, theirs.cerebro);
  return {
    board: { nodes, edges, ink, ...(top ? { facts: top } : {}), ...(cerebro ? { cerebro } : {}) },
    conflicts,
    removedEdges,
  };
}
