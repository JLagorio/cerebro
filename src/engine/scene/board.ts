import { isDurableColor } from './colors';
import { inkProblem } from './ink';
import { MAX_COORD, MAX_ID_CHARS, MIN_SIZE } from './limits';
import type {
  Board,
  BoardEdge,
  BoardNode,
  Box,
  CommandReport,
  CommandResult,
  FileFacts,
  InkStroke,
  Item,
  ItemKey,
  ItemKind,
  Refusal,
} from './model';
import { compareKeys, isOrderKey, keysAt, orderKeys } from './order';

/**
 * Boards (M68.1): building one, reading it in order, and the two checks. A
 * board read from a file is taken as it is: a connection whose card is gone,
 * or a colour Cerebro can't draw, stays and is reported by `problemsOf`.
 * `checkSet` is strict, but only about what a change sets, never about what
 * it carries, so a loaded oddity rides along untouched until someone sets it.
 */

export const EMPTY_BOARD: Board = { nodes: new Map(), edges: new Map(), ink: new Map() };

type Unordered<T extends { z: string }> = T extends unknown
  ? Omit<T, 'z'> & { readonly z?: string }
  : never;

export interface BoardInput {
  readonly nodes?: Iterable<Unordered<BoardNode>>;
  readonly edges?: Iterable<Unordered<BoardEdge>>;
  readonly ink?: Iterable<Unordered<InkStroke>>;
  readonly facts?: FileFacts;
  readonly cerebro?: FileFacts;
}

function ordered<T extends { id: string; z?: string }>(
  items: Iterable<T>,
): Map<string, T & { z: string }> {
  const list: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    // A repeated id keeps its first item: the codec refuses a file that has one.
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    list.push(item);
  }
  const present = list.flatMap((item) => (item.z === undefined ? [] : [item.z])).sort(compareKeys);
  const missing = list.filter((item) => item.z === undefined).length;
  const top = present.at(-1) ?? null;
  const fresh = (top === null ? null : keysAt([top], 1, missing)) ?? orderKeys(missing);
  let next = 0;
  const out = new Map<string, T & { z: string }>();
  for (const item of list) {
    const z = item.z ?? fresh[next++];
    out.set(item.id, { ...item, z } as T & { z: string });
  }
  return out;
}

/** A board from items in file order; an item without `z` gets one above the rest, in the order given. */
export function createBoard(input: BoardInput = {}): Board {
  const board: {
    nodes: Map<string, BoardNode>;
    edges: Map<string, BoardEdge>;
    ink: Map<string, InkStroke>;
    facts?: FileFacts;
    cerebro?: FileFacts;
  } = {
    nodes: ordered(input.nodes ?? []) as Map<string, BoardNode>,
    edges: ordered(input.edges ?? []) as Map<string, BoardEdge>,
    ink: ordered(input.ink ?? []) as Map<string, InkStroke>,
  };
  if (input.facts !== undefined) board.facts = input.facts;
  if (input.cerebro !== undefined) board.cerebro = input.cerebro;
  return board;
}

export function itemKey(kind: ItemKind, id: string): ItemKey {
  return `${kind}:${id}`;
}

export function parseItemKey(key: string): { kind: ItemKind; id: string } | null {
  const kind = key.slice(0, 1);
  if (key.charAt(1) !== ':' || (kind !== 'n' && kind !== 'e' && kind !== 'i')) return null;
  return { kind, id: key.slice(2) };
}

export function getItem(board: Board, key: ItemKey): Item | undefined {
  const parsed = parseItemKey(key);
  if (parsed === null) return undefined;
  if (parsed.kind === 'n') return board.nodes.get(parsed.id);
  if (parsed.kind === 'e') return board.edges.get(parsed.id);
  return board.ink.get(parsed.id);
}

function byZ<T extends { id: string; z: string }>(items: Iterable<T>): T[] {
  return [...items].sort((a, b) => compareKeys(a.z, b.z) || compareKeys(a.id, b.id));
}

/** Back to front; equal keys fall back to id order. */
export function orderedNodes(board: Board): BoardNode[] {
  return byZ(board.nodes.values());
}
export function orderedEdges(board: Board): BoardEdge[] {
  return byZ(board.edges.values());
}
export function orderedInk(board: Board): InkStroke[] {
  return byZ(board.ink.values());
}

export type PaintEntry =
  | { readonly key: ItemKey; readonly kind: 'n'; readonly item: BoardNode }
  | { readonly key: ItemKey; readonly kind: 'e'; readonly item: BoardEdge }
  | { readonly key: ItemKey; readonly kind: 'i'; readonly item: InkStroke };

/** What a renderer draws, back to front: cards, then connections, then ink. */
export function paintOrder(board: Board): PaintEntry[] {
  return [
    ...orderedNodes(board).map((item) => ({
      key: itemKey('n', item.id),
      kind: 'n' as const,
      item,
    })),
    ...orderedEdges(board).map((item) => ({
      key: itemKey('e', item.id),
      kind: 'e' as const,
      item,
    })),
    ...orderedInk(board).map((item) => ({ key: itemKey('i', item.id), kind: 'i' as const, item })),
  ];
}

function inside(inner: Box, outer: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * The cards and strokes whose box lies wholly inside the group's box, nested
 * groups and what they hold included, in paint order. Not the group itself;
 * empty when `groupId` names no group.
 */
export function membersOf(board: Board, groupId: string): ItemKey[] {
  const group = board.nodes.get(groupId);
  if (group === undefined || group.type !== 'group') return [];
  return [
    ...orderedNodes(board)
      .filter((node) => node.id !== groupId && inside(node, group))
      .map((node) => itemKey('n', node.id)),
    ...orderedInk(board)
      .filter((stroke) => inside(stroke, group))
      .map((stroke) => itemKey('i', stroke.id)),
  ];
}

/** The box around every card and stroke; null for a board with neither. */
export function boardBounds(board: Board): Box | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of [...board.nodes.values(), ...board.ink.values()]) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export type Problem =
  | { readonly kind: 'dangling-edge'; readonly key: ItemKey; readonly ends: 'from' | 'to' | 'both' }
  | { readonly kind: 'undrawable-color'; readonly key: ItemKey; readonly color: string };

/** What a loaded board holds that Cerebro keeps but can't use, in paint order. */
export function problemsOf(board: Board): Problem[] {
  const out: Problem[] = [];
  for (const entry of paintOrder(board)) {
    if (entry.kind === 'e') {
      const from = board.nodes.has(entry.item.fromNode);
      const to = board.nodes.has(entry.item.toNode);
      if (!from || !to) {
        out.push({
          kind: 'dangling-edge',
          key: entry.key,
          ends: !from && !to ? 'both' : !from ? 'from' : 'to',
        });
      }
    }
    const color = entry.item.color;
    if (color !== undefined && !isDurableColor(color)) {
      out.push({ kind: 'undrawable-color', key: entry.key, color: String(color) });
    }
  }
  return out;
}

const CARD_TYPES = new Set(['text', 'file', 'link', 'group']);
const SHAPES = new Set(['rectangle', 'ellipse', 'diamond']);
const SIDES = new Set(['top', 'right', 'bottom', 'left']);
const ENDS = new Set(['none', 'arrow']);
const BACKGROUND_STYLES = new Set(['cover', 'ratio', 'repeat']);

const refuse = (code: Refusal['code'], message: string): Refusal => ({ code, message });

function idProblem(what: string, id: unknown, key: string): Refusal | null {
  if (typeof id !== 'string' || id !== key) {
    return refuse('id', `${what}'s id doesn't match where it is stored.`);
  }
  const chars = [...id].length;
  if (chars < 1 || chars > MAX_ID_CHARS) {
    return refuse('id', `${what}'s id must be 1 to ${MAX_ID_CHARS} characters (it has ${chars}).`);
  }
  return null;
}

function boxProblem(what: string, box: Box): Refusal | null {
  for (const field of ['x', 'y', 'width', 'height'] as const) {
    const value: unknown = box[field];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return refuse('box', `${what}: ${field} must be a whole number (got ${String(value)}).`);
    }
  }
  if (Math.abs(box.x) > MAX_COORD || Math.abs(box.y) > MAX_COORD) {
    return refuse('box', `${what} lies further than ${MAX_COORD} from the origin.`);
  }
  if (
    box.width < MIN_SIZE ||
    box.height < MIN_SIZE ||
    box.width > MAX_COORD ||
    box.height > MAX_COORD
  ) {
    return refuse(
      'box',
      `${what}: width and height must be from ${MIN_SIZE} to ${MAX_COORD} (got ${box.width} × ${box.height}).`,
    );
  }
  return null;
}

function boxChanged(a: Box, b: Box): boolean {
  return a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height;
}

/** True when `field` is new or differs from what the item had. */
function sets<T extends object>(item: T, prev: T | undefined, field: keyof T): boolean {
  return prev === undefined || prev[field] !== item[field];
}

function colorProblem<T extends { color?: string }>(
  what: string,
  item: T,
  prev: T | undefined,
): Refusal | null {
  if (item.color === undefined || !sets(item, prev, 'color')) return null;
  if (isDurableColor(item.color)) return null;
  return refuse(
    'color',
    `${what}: ${JSON.stringify(item.color)} isn't a colour a board keeps; use a preset 1–6 or a hex colour.`,
  );
}

function zProblem<T extends { z: string }>(
  what: string,
  item: T,
  prev: T | undefined,
): Refusal | null {
  if (!sets(item, prev, 'z') || isOrderKey(item.z)) return null;
  return refuse('value', `${what} has a malformed order key.`);
}

function optionalString(what: string, field: string, value: unknown): Refusal | null {
  if (value === undefined || typeof value === 'string') return null;
  return refuse('value', `${what}: ${field} must be text.`);
}

function inVocab(
  what: string,
  field: string,
  value: unknown,
  vocab: Set<string>,
  optional: boolean,
): Refusal | null {
  if (optional && value === undefined) return null;
  if (typeof value === 'string' && vocab.has(value)) return null;
  return refuse(
    'vocab',
    `${what}: ${field} ${value === undefined ? 'is missing' : JSON.stringify(value) + ' is unknown'}; it is one of ${[...vocab].join(', ')}.`,
  );
}

function factsProblem(what: string, facts: unknown): Refusal | null {
  if (facts === undefined) return null;
  const f = facts as FileFacts;
  if (typeof f === 'object' && f !== null && f.extra instanceof Map && Array.isArray(f.keyOrder))
    return null;
  return refuse('value', `${what} carries malformed file facts.`);
}

function nodeProblem(id: string, node: BoardNode, before: BoardNode | undefined): Refusal | null {
  const what = `Card ${id}`;
  // A card that changes type is checked as a new one.
  const prev = before !== undefined && before.type === node.type ? before : undefined;
  const fresh = prev === undefined;
  if (fresh && before === undefined) {
    const problem = idProblem(what, node.id, id);
    if (problem) return problem;
  }
  if (!CARD_TYPES.has(node.type)) {
    return inVocab(what, 'type', node.type, CARD_TYPES, false);
  }
  const problem =
    zProblem(what, node, prev) ??
    (fresh || boxChanged(node, prev) ? boxProblem(what, node) : null) ??
    colorProblem(what, node, prev) ??
    (fresh || node.facts !== prev.facts ? factsProblem(what, node.facts) : null) ??
    (fresh || node.cardFacts !== prev.cardFacts ? factsProblem(what, node.cardFacts) : null);
  if (problem) return problem;
  switch (node.type) {
    case 'text': {
      const p = prev as typeof node | undefined;
      if (sets(node, p, 'text') && typeof node.text !== 'string') {
        return refuse('value', `${what}: text must be text.`);
      }
      return sets(node, p, 'shape') ? inVocab(what, 'shape', node.shape, SHAPES, false) : null;
    }
    case 'file': {
      const p = prev as typeof node | undefined;
      if (sets(node, p, 'file') && (typeof node.file !== 'string' || node.file === '')) {
        return refuse('value', `${what}: file must name a path.`);
      }
      return sets(node, p, 'subpath') ? optionalString(what, 'subpath', node.subpath) : null;
    }
    case 'link': {
      const p = prev as typeof node | undefined;
      if (sets(node, p, 'url') && typeof node.url !== 'string') {
        return refuse('value', `${what}: url must be text.`);
      }
      return null;
    }
    case 'group': {
      const p = prev as typeof node | undefined;
      return (
        (sets(node, p, 'label') ? optionalString(what, 'label', node.label) : null) ??
        (sets(node, p, 'background')
          ? optionalString(what, 'background', node.background)
          : null) ??
        (sets(node, p, 'backgroundStyle')
          ? inVocab(what, 'backgroundStyle', node.backgroundStyle, BACKGROUND_STYLES, true)
          : null)
      );
    }
  }
}

function edgeProblem(
  id: string,
  edge: BoardEdge,
  prev: BoardEdge | undefined,
  after: Board,
): Refusal | null {
  const what = `Connection ${id}`;
  if (prev === undefined) {
    const problem = idProblem(what, edge.id, id);
    if (problem) return problem;
  }
  for (const end of ['fromNode', 'toNode'] as const) {
    if (!sets(edge, prev, end)) continue;
    const target: unknown = edge[end];
    if (typeof target !== 'string' || !after.nodes.has(target)) {
      return refuse(
        'end',
        `${what} must join two cards, and there is no card ${typeof target === 'string' ? target : '(none)'}.`,
      );
    }
  }
  return (
    zProblem(what, edge, prev) ??
    colorProblem(what, edge, prev) ??
    (sets(edge, prev, 'fromSide') ? inVocab(what, 'fromSide', edge.fromSide, SIDES, true) : null) ??
    (sets(edge, prev, 'toSide') ? inVocab(what, 'toSide', edge.toSide, SIDES, true) : null) ??
    (sets(edge, prev, 'fromEnd') ? inVocab(what, 'fromEnd', edge.fromEnd, ENDS, true) : null) ??
    (sets(edge, prev, 'toEnd') ? inVocab(what, 'toEnd', edge.toEnd, ENDS, true) : null) ??
    (sets(edge, prev, 'label') ? optionalString(what, 'label', edge.label) : null) ??
    (sets(edge, prev, 'facts') ? factsProblem(what, edge.facts) : null)
  );
}

function strokeProblem(id: string, stroke: InkStroke, prev: InkStroke | undefined): Refusal | null {
  const what = `Ink stroke ${id}`;
  if (prev === undefined) {
    const problem = idProblem(what, stroke.id, id);
    if (problem) return problem;
  }
  const problem =
    zProblem(what, stroke, prev) ??
    (prev === undefined || boxChanged(stroke, prev) ? boxProblem(what, stroke) : null) ??
    colorProblem(what, stroke, prev) ??
    (sets(stroke, prev, 'facts') ? factsProblem(what, stroke.facts) : null);
  if (problem) return problem;
  const inkChanged =
    prev === undefined ||
    boxChanged(stroke, prev) ||
    stroke.points !== prev.points ||
    stroke.size !== prev.size ||
    stroke.simulated !== prev.simulated;
  if (!inkChanged) return null;
  const words = inkProblem(stroke);
  return words === null ? null : refuse('ink', `${what}: ${words}.`);
}

/**
 * Whether the change from `before` to `after` sets only what a board may
 * hold, as a refusal in words or null. Checked for each item a change adds
 * or alters, and only for the fields it sets: an id 1–128 characters, a box
 * of whole numbers within MAX_COORD and at least MIN_SIZE wide and high, a
 * durable colour, connection ends that exist, values in vocabulary and ink
 * within its caps. A change may never leave a connection without a card it
 * had: removing a card means removing its connections in the same change.
 */
export function checkSet(before: Board, after: Board): Refusal | null {
  for (const [id, node] of after.nodes) {
    const prev = before.nodes.get(id);
    if (prev === node) continue;
    const problem = nodeProblem(id, node, prev);
    if (problem) return problem;
  }
  for (const [id, edge] of after.edges) {
    const prev = before.edges.get(id);
    if (prev !== edge) {
      const problem = edgeProblem(id, edge, prev, after);
      if (problem) return problem;
    }
    for (const end of [edge.fromNode, edge.toNode]) {
      if (!after.nodes.has(end) && before.nodes.has(end)) {
        return refuse('end', `Removing card ${end} would leave connection ${id} with one end.`);
      }
    }
  }
  for (const [id, stroke] of after.ink) {
    const prev = before.ink.get(id);
    if (prev === stroke) continue;
    const problem = strokeProblem(id, stroke, prev);
    if (problem) return problem;
  }
  return null;
}

/** `count` ascending keys above every item in `items`, for new items put on top. */
export function frontKeys(items: ReadonlyMap<string, { z: string }>, count: number): string[] {
  let top: string | null = null;
  for (const { z } of items.values()) {
    if (isOrderKey(z) && (top === null || z > top)) top = z;
  }
  return (top === null ? null : keysAt([top], 1, count)) ?? orderKeys(count);
}

/** `count` new ids from the caller's factory, or a refusal when one is already taken. */
export function takeIds(
  createId: () => string,
  existing: ReadonlyMap<string, unknown>,
  count: number,
  what: string,
): string[] | Refusal {
  const ids: string[] = [];
  const taken = new Set<string>();
  for (let i = 0; i < count; i += 1) {
    const id = createId();
    if (existing.has(id) || taken.has(id)) {
      return refuse('id', `The id factory gave ${what} id ${id}, which is already in use.`);
    }
    taken.add(id);
    ids.push(id);
  }
  return ids;
}

function sameMap<T>(a: ReadonlyMap<string, T>, b: ReadonlyMap<string, T>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, item] of a) if (b.get(id) !== item) return false;
  return true;
}

/** Whether two boards hold the same items and facts, by identity. */
export function sameBoard(a: Board, b: Board): boolean {
  return (
    a === b ||
    (a.facts === b.facts &&
      a.cerebro === b.cerebro &&
      sameMap(a.nodes, b.nodes) &&
      sameMap(a.edges, b.edges) &&
      sameMap(a.ink, b.ink))
  );
}

/**
 * A command's ending: the same board when nothing changed, a refusal when
 * the change sets something `checkSet` refuses, else the new board.
 */
export function settle(
  before: Board,
  after: Board,
  label: string,
  extra: { selection?: readonly ItemKey[]; report?: CommandReport } = {},
): CommandResult {
  if (sameBoard(before, after)) {
    return {
      ok: true,
      board: before,
      label,
      ...(extra.selection ? { selection: extra.selection } : {}),
    };
  }
  const refusal = checkSet(before, after);
  if (refusal) return { ok: false, refusal };
  return { ok: true, board: after, label, ...extra };
}

/** A refusal as a command result. */
export function refused(code: Refusal['code'], message: string): CommandResult {
  return { ok: false, refusal: refuse(code, message) };
}
