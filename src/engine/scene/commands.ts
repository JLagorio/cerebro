import {
  frontKeys,
  itemKey,
  membersOf,
  orderedEdges,
  orderedInk,
  orderedNodes,
  parseItemKey,
  refused,
  settle,
  takeIds,
} from './board';
import { normalizeColor } from './colors';
import { copyFragment, pasteFragment, type Fragment } from './fragments';
import { scaleStroke } from './ink';
import { PASTE_OFFSET } from './limits';
import type {
  BoardEdge,
  BoardNode,
  Box,
  Command,
  CommandResult,
  InkStroke,
  ItemKey,
  NewCard,
  NewEdge,
  NewStroke,
} from './model';
import { keysAt, orderKeys } from './order';

/**
 * The scene's commands (M68.1). Each is pure: a board, a payload and the
 * caller's id factory in, a result out. A no-op answers with the same board
 * by reference; bad input answers with a refusal in words, never a throw;
 * nothing reads a clock or randomness. Every new board has passed `checkSet`
 * against the board it came from.
 */

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/** The item without file facts: a new item carries none. */
function withoutFacts<T extends object>(item: T): T {
  const out = { ...item } as Record<string, unknown>;
  delete out.facts;
  delete out.cardFacts;
  return out as T;
}

/** `color` as a command writes it: durable values normalized, anything else left for checkSet to refuse. */
function written<T extends { color?: string }>(item: T): T {
  if (item.color === undefined) return item;
  return { ...item, color: normalizeColor(item.color) ?? item.color };
}

function add<N, T extends { id: string; z: string }>(
  map: ReadonlyMap<string, T>,
  items: readonly N[],
  createId: () => string,
  what: string,
  build: (item: N, id: string, z: string) => T,
): Map<string, T> | CommandResult {
  const ids = takeIds(createId, map, items.length, what);
  if (!Array.isArray(ids)) return { ok: false, refusal: ids };
  const zs = frontKeys(map, items.length);
  const next = new Map(map);
  items.forEach((item, i) => next.set(ids[i], build(item, ids[i], zs[i])));
  return next;
}

export const addCards: Command<{ cards: readonly NewCard[] }> = (
  board,
  { cards },
  { createId },
) => {
  const nodes = add(board.nodes, cards, createId, 'a card', (card, id, z) =>
    written({ ...withoutFacts(card), id, z } as BoardNode),
  );
  if (!(nodes instanceof Map)) return nodes;
  const added = [...nodes.keys()].filter((id) => !board.nodes.has(id));
  return settle(board, { ...board, nodes }, `Add ${plural(cards.length, 'card', 'cards')}`, {
    selection: added.map((id) => itemKey('n', id)),
  });
};

export const addEdges: Command<{ edges: readonly NewEdge[] }> = (
  board,
  { edges },
  { createId },
) => {
  const next = add(board.edges, edges, createId, 'a connection', (edge, id, z) =>
    written({ ...withoutFacts(edge), id, z } as BoardEdge),
  );
  if (!(next instanceof Map)) return next;
  const added = [...next.keys()].filter((id) => !board.edges.has(id));
  return settle(
    board,
    { ...board, edges: next },
    `Add ${plural(edges.length, 'connection', 'connections')}`,
    { selection: added.map((id) => itemKey('e', id)) },
  );
};

export const addInk: Command<{ strokes: readonly NewStroke[] }> = (
  board,
  { strokes },
  { createId },
) => {
  const ink = add(board.ink, strokes, createId, 'an ink stroke', (stroke, id, z) =>
    written({ ...withoutFacts(stroke), id, z } as InkStroke),
  );
  if (!(ink instanceof Map)) return ink;
  const added = [...ink.keys()].filter((id) => !board.ink.has(id));
  return settle(board, { ...board, ink }, `Add ${plural(strokes.length, 'drawing', 'drawings')}`, {
    selection: added.map((id) => itemKey('i', id)),
  });
};

/** Each field an update may set, and whether null may clear it. */
type FieldRules = ReadonlyMap<string, 'required' | 'optional'>;

const CARD_FIELDS: Readonly<Record<BoardNode['type'], FieldRules>> = {
  text: new Map([
    ['text', 'required'],
    ['shape', 'required'],
    ['color', 'optional'],
  ]),
  file: new Map([
    ['file', 'required'],
    ['subpath', 'optional'],
    ['color', 'optional'],
  ]),
  link: new Map([
    ['url', 'required'],
    ['color', 'optional'],
  ]),
  group: new Map([
    ['label', 'optional'],
    ['background', 'optional'],
    ['backgroundStyle', 'optional'],
    ['color', 'optional'],
  ]),
};

const EDGE_FIELDS: FieldRules = new Map([
  ['fromNode', 'required'],
  ['toNode', 'required'],
  ['fromSide', 'optional'],
  ['toSide', 'optional'],
  ['fromEnd', 'optional'],
  ['toEnd', 'optional'],
  ['color', 'optional'],
  ['label', 'optional'],
]);

/** `item` with `set` applied (null clears), the same object when nothing differs, or a refusal. */
function patched<T extends object>(
  item: T,
  set: Readonly<Record<string, unknown>>,
  rules: FieldRules,
  what: string,
): T | CommandResult {
  const next = { ...item } as Record<string, unknown>;
  let changed = false;
  for (const [field, value] of Object.entries(set)) {
    const rule = rules.get(field);
    if (rule === undefined) {
      return refused('value', `${what} has no ${field} an update can set.`);
    }
    if (value === undefined) continue;
    if (value === null) {
      if (rule === 'required') return refused('value', `${what}'s ${field} can't be cleared.`);
      if (field in next) {
        delete next[field];
        changed = true;
      }
      continue;
    }
    const stored = field === 'color' ? (normalizeColor(value) ?? value) : value;
    if (next[field] !== stored) {
      next[field] = stored;
      changed = true;
    }
  }
  return changed ? (next as T) : item;
}

const isResult = (value: unknown): value is CommandResult =>
  typeof value === 'object' && value !== null && 'ok' in value;

export interface CardUpdate {
  readonly id: string;
  /** Fields to set; null clears an optional one. */
  readonly set: Readonly<Record<string, unknown>>;
}

export const updateCards: Command<{ updates: readonly CardUpdate[] }> = (board, { updates }) => {
  const nodes = new Map(board.nodes);
  for (const { id, set } of updates) {
    const node = nodes.get(id);
    if (node === undefined) return refused('missing', `There is no card ${id}.`);
    const next = patched(node, set, CARD_FIELDS[node.type], `A ${node.type} card`);
    if (isResult(next)) return next;
    nodes.set(id, next);
  }
  return settle(board, { ...board, nodes }, `Edit ${plural(updates.length, 'card', 'cards')}`);
};

export interface EdgeUpdate {
  readonly id: string;
  /** Fields to set; null clears an optional one. */
  readonly set: Readonly<Record<string, unknown>>;
}

export const updateEdges: Command<{ updates: readonly EdgeUpdate[] }> = (board, { updates }) => {
  const edges = new Map(board.edges);
  for (const { id, set } of updates) {
    const edge = edges.get(id);
    if (edge === undefined) return refused('missing', `There is no connection ${id}.`);
    const next = patched(edge, set, EDGE_FIELDS, 'A connection');
    if (isResult(next)) return next;
    edges.set(id, next);
  }
  return settle(
    board,
    { ...board, edges },
    `Edit ${plural(updates.length, 'connection', 'connections')}`,
  );
};

function split(keys: Iterable<ItemKey>): {
  nodes: Set<string>;
  edges: Set<string>;
  ink: Set<string>;
} {
  const out = { nodes: new Set<string>(), edges: new Set<string>(), ink: new Set<string>() };
  for (const key of keys) {
    const parsed = parseItemKey(key);
    if (parsed === null) continue;
    (parsed.kind === 'n' ? out.nodes : parsed.kind === 'e' ? out.edges : out.ink).add(parsed.id);
  }
  return out;
}

/**
 * Moves cards and strokes by whole units. A group carries every card and
 * stroke wholly inside it as the command finds them. Connections have no box
 * of their own and follow their cards.
 */
export const moveItems: Command<{ keys: readonly ItemKey[]; dx: number; dy: number }> = (
  board,
  { keys, dx, dy },
) => {
  if (!Number.isInteger(dx) || !Number.isInteger(dy)) {
    return refused('box', `Items move by whole units (got ${dx}, ${dy}).`);
  }
  const chosen = split(keys);
  for (const id of [...chosen.nodes]) {
    for (const member of split(membersOf(board, id)).nodes) chosen.nodes.add(member);
    for (const member of split(membersOf(board, id)).ink) chosen.ink.add(member);
  }
  const nodes = new Map(board.nodes);
  const ink = new Map(board.ink);
  let moved = 0;
  if (dx !== 0 || dy !== 0) {
    for (const id of chosen.nodes) {
      const node = nodes.get(id);
      if (node === undefined) continue;
      nodes.set(id, { ...node, x: node.x + dx, y: node.y + dy });
      moved += 1;
    }
    for (const id of chosen.ink) {
      const stroke = ink.get(id);
      if (stroke === undefined) continue;
      ink.set(id, { ...stroke, x: stroke.x + dx, y: stroke.y + dy });
      moved += 1;
    }
  }
  return settle(board, { ...board, nodes, ink }, `Move ${plural(moved, 'item', 'items')}`);
};

/** Gives cards and strokes new boxes; a stroke's points scale with its box. */
export const resizeItems: Command<{ boxes: readonly { key: ItemKey; box: Box }[] }> = (
  board,
  { boxes },
) => {
  const nodes = new Map(board.nodes);
  const ink = new Map(board.ink);
  for (const { key, box } of boxes) {
    const parsed = parseItemKey(key);
    if (parsed === null || parsed.kind === 'e') {
      return refused('value', 'Only cards and drawings have a size to change.');
    }
    const { x, y, width, height } = box;
    if (parsed.kind === 'n') {
      const node = nodes.get(parsed.id);
      if (node === undefined) return refused('missing', `There is no card ${parsed.id}.`);
      if (node.x === x && node.y === y && node.width === width && node.height === height) continue;
      nodes.set(parsed.id, { ...node, x, y, width, height });
    } else {
      const stroke = ink.get(parsed.id);
      if (stroke === undefined) return refused('missing', `There is no ink stroke ${parsed.id}.`);
      if (stroke.x === x && stroke.y === y && stroke.width === width && stroke.height === height) {
        continue;
      }
      ink.set(parsed.id, scaleStroke(stroke, { x, y, width, height }));
    }
  }
  return settle(board, { ...board, nodes, ink }, `Resize ${plural(boxes.length, 'item', 'items')}`);
};

/**
 * Deletes cards, connections and strokes. A connection needs both its cards,
 * so every connection naming a deleted card goes in the same result. A group
 * goes alone: what sits inside it stays.
 */
export const deleteItems: Command<{ keys: readonly ItemKey[] }> = (board, { keys }) => {
  const chosen = split(keys);
  const nodes = new Map(board.nodes);
  const edges = new Map(board.edges);
  const ink = new Map(board.ink);
  let deleted = 0;
  for (const id of chosen.nodes) if (nodes.delete(id)) deleted += 1;
  for (const id of chosen.ink) if (ink.delete(id)) deleted += 1;
  for (const id of chosen.edges) if (edges.delete(id)) deleted += 1;
  let removedEdges = 0;
  for (const [id, edge] of edges) {
    const lost =
      (board.nodes.has(edge.fromNode) && !nodes.has(edge.fromNode)) ||
      (board.nodes.has(edge.toNode) && !nodes.has(edge.toNode));
    if (lost) {
      edges.delete(id);
      removedEdges += 1;
    }
  }
  return settle(
    board,
    { ...board, nodes, edges, ink },
    `Delete ${plural(deleted, 'item', 'items')}`,
    { selection: [], ...(removedEdges > 0 ? { report: { removedEdges } } : {}) },
  );
};

export type ReorderTo = 'front' | 'back' | 'forward' | 'backward';

/** The ids in their new back-to-front order. */
function reordered(ids: readonly string[], chosen: ReadonlySet<string>, to: ReorderTo): string[] {
  const picked = ids.filter((id) => chosen.has(id));
  const others = ids.filter((id) => !chosen.has(id));
  if (to === 'front') return [...others, ...picked];
  if (to === 'back') return [...picked, ...others];
  const out = [...ids];
  if (to === 'forward') {
    for (let i = out.length - 2; i >= 0; i -= 1) {
      if (chosen.has(out[i]) && !chosen.has(out[i + 1]))
        [out[i], out[i + 1]] = [out[i + 1], out[i]];
    }
  } else {
    for (let i = 1; i < out.length; i += 1) {
      if (chosen.has(out[i]) && !chosen.has(out[i - 1]))
        [out[i], out[i - 1]] = [out[i - 1], out[i]];
    }
  }
  return out;
}

/**
 * New keys for one kind so its items sit in `order`: only the chosen items
 * get one, slotted between the unchosen keys. Should the unchosen keys tie or
 * be malformed (a hand-built board), every item of the kind is renumbered.
 */
function rekey<T extends { id: string; z: string }>(
  map: ReadonlyMap<string, T>,
  order: readonly string[],
  chosen: ReadonlySet<string>,
): Map<string, T> {
  const next = new Map(map);
  const otherKeys = order.filter((id) => !chosen.has(id)).map((id) => (map.get(id) as T).z);
  const runs: { at: number; ids: string[] }[] = [];
  let before = 0;
  for (const id of order) {
    if (!chosen.has(id)) {
      before += 1;
      continue;
    }
    const last = runs.at(-1);
    if (last !== undefined && last.at === before) last.ids.push(id);
    else runs.push({ at: before, ids: [id] });
  }
  for (const run of runs) {
    const keys = keysAt(otherKeys, run.at, run.ids.length);
    if (keys === null) {
      const all = orderKeys(order.length);
      order.forEach((id, i) => next.set(id, { ...(map.get(id) as T), z: all[i] }));
      return next;
    }
    run.ids.forEach((id, i) => next.set(id, { ...(map.get(id) as T), z: keys[i] }));
  }
  return next;
}

function reorderKind<T extends { id: string; z: string }>(
  map: ReadonlyMap<string, T>,
  sorted: readonly T[],
  chosen: ReadonlySet<string>,
  to: ReorderTo,
): ReadonlyMap<string, T> {
  const present = new Set([...chosen].filter((id) => map.has(id)));
  if (present.size === 0) return map;
  const ids = sorted.map((item) => item.id);
  const order = reordered(ids, present, to);
  if (order.every((id, i) => id === ids[i])) return map;
  return rekey(map, order, present);
}

/** Brings items to the front or back, or one step forward or backward, within their own kind. */
export const reorderItems: Command<{ keys: readonly ItemKey[]; to: ReorderTo }> = (
  board,
  { keys, to },
) => {
  const chosen = split(keys);
  const nodes = reorderKind(board.nodes, orderedNodes(board), chosen.nodes, to);
  const edges = reorderKind(board.edges, orderedEdges(board), chosen.edges, to);
  const ink = reorderKind(board.ink, orderedInk(board), chosen.ink, to);
  const words = {
    front: 'Bring to front',
    back: 'Send to back',
    forward: 'Bring forward',
    backward: 'Send backward',
  };
  return settle(board, { ...board, nodes, edges, ink }, words[to]);
};

/** Copies items and pastes them PASTE_OFFSET along, as one result. */
export const duplicateItems: Command<{ keys: readonly ItemKey[] }> = (
  board,
  { keys },
  { createId },
) => {
  const { fragment, report } = copyFragment(board, keys);
  const result = pasteFragment(board, fragment, { createId, offset: PASTE_OFFSET });
  if (!result.ok) return result;
  const count = fragment.nodes.length + fragment.edges.length + fragment.ink.length;
  return {
    ...result,
    label: `Duplicate ${plural(count, 'item', 'items')}`,
    ...(report.droppedEdges > 0 ? { report: { droppedEdges: report.droppedEdges } } : {}),
  };
};

/** Pastes a fragment (fragments.ts `pasteFragment`), PASTE_OFFSET along unless told otherwise. */
export const pasteItems: Command<{ fragment: Fragment; offset?: number }> = (
  board,
  { fragment, offset },
  { createId },
) => pasteFragment(board, fragment, { createId, offset: offset ?? PASTE_OFFSET });
