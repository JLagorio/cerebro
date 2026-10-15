import {
  EMPTY_BOARD,
  checkSet,
  createBoard,
  frontKeys,
  itemKey,
  orderedEdges,
  orderedInk,
  orderedNodes,
  parseItemKey,
  refused,
  settle,
  takeIds,
} from './board';
import { FRAGMENT_MAX_CHARS, FRAGMENT_MAX_ITEMS } from './limits';
import type {
  Board,
  BoardEdge,
  BoardNode,
  CommandReport,
  CommandResult,
  FileFacts,
  InkStroke,
  ItemKey,
  RawJson,
} from './model';

/**
 * Board fragments (M68.1): what a copy holds and a paste puts back. A copy
 * takes the chosen cards and strokes, and the connections whose two ends it
 * took; a paste gives every item a new id from the caller, re-points the
 * connections, shifts the boxes and lays the items on top, carrying their
 * file facts. On the clipboard a fragment is JSON of kind
 * `cerebro-board-fragment`, version 1, under BOARD_CLIPBOARD_TYPE (M68.4c).
 */

export const FRAGMENT_KIND = 'cerebro-board-fragment';
export const FRAGMENT_VERSION = 1;
export const BOARD_CLIPBOARD_TYPE = 'application/x-cerebro-board';

/** Items back to front within each kind. */
export interface Fragment {
  readonly nodes: readonly BoardNode[];
  readonly edges: readonly BoardEdge[];
  readonly ink: readonly InkStroke[];
}

/** The chosen cards and strokes, and each connection whose two ends were both chosen. */
export function copyFragment(
  board: Board,
  keys: Iterable<ItemKey>,
): { fragment: Fragment; report: { droppedEdges: number } } {
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const inkIds = new Set<string>();
  for (const key of keys) {
    const parsed = parseItemKey(key);
    if (parsed === null) continue;
    (parsed.kind === 'n' ? nodeIds : parsed.kind === 'e' ? edgeIds : inkIds).add(parsed.id);
  }
  const nodes = orderedNodes(board).filter((node) => nodeIds.has(node.id));
  const ink = orderedInk(board).filter((stroke) => inkIds.has(stroke.id));
  const taken = new Set(nodes.map((node) => node.id));
  const edges: BoardEdge[] = [];
  let droppedEdges = 0;
  for (const edge of orderedEdges(board)) {
    const from = taken.has(edge.fromNode);
    const to = taken.has(edge.toNode);
    if (from && to) edges.push(edge);
    else if (from || to || edgeIds.has(edge.id)) droppedEdges += 1;
  }
  return { fragment: { nodes, edges, ink }, report: { droppedEdges } };
}

function plainFacts(facts: FileFacts): { extra: [string, RawJson][]; keyOrder: string[] } {
  return { extra: [...facts.extra], keyOrder: [...facts.keyOrder] };
}

function plain(item: BoardNode | BoardEdge | InkStroke): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(item)) {
    if (field === 'z' || value === undefined) continue;
    out[field] =
      field === 'facts' || field === 'cardFacts' ? plainFacts(value as FileFacts) : value;
  }
  return out;
}

/** The fragment as clipboard JSON. Array order is the order within each kind. */
export function serializeFragment(fragment: Fragment): string {
  return JSON.stringify({
    kind: FRAGMENT_KIND,
    version: FRAGMENT_VERSION,
    nodes: fragment.nodes.map(plain),
    edges: fragment.edges.map(plain),
    ink: fragment.ink.map(plain),
  });
}

const NODE_FIELDS = [
  'id',
  'type',
  'x',
  'y',
  'width',
  'height',
  'color',
  'text',
  'shape',
  'file',
  'subpath',
  'url',
  'label',
  'background',
  'backgroundStyle',
  'facts',
  'cardFacts',
];
const EDGE_FIELDS = [
  'id',
  'fromNode',
  'fromSide',
  'fromEnd',
  'toNode',
  'toSide',
  'toEnd',
  'color',
  'label',
  'facts',
];
const INK_FIELDS = [
  'id',
  'x',
  'y',
  'width',
  'height',
  'color',
  'size',
  'simulated',
  'points',
  'facts',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A FileFacts back from its clipboard form; undefined when it isn't one. */
function readFacts(value: unknown): FileFacts | undefined {
  if (!isRecord(value) || !Array.isArray(value.extra) || !Array.isArray(value.keyOrder))
    return undefined;
  if (!value.keyOrder.every((key) => typeof key === 'string')) return undefined;
  const extra = new Map<string, RawJson>();
  for (const pair of value.extra) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string') return undefined;
    extra.set(pair[0], pair[1]);
  }
  return { extra, keyOrder: value.keyOrder as string[] };
}

/** The listed fields of a clipboard item, facts rebuilt; null when it isn't an object or its facts are malformed. */
function readItem(value: unknown, fields: readonly string[]): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    const raw = value[field];
    if (field === 'facts' || field === 'cardFacts') {
      const facts = readFacts(raw);
      if (facts === undefined) return null;
      out[field] = facts;
    } else {
      out[field] = raw;
    }
  }
  return out;
}

function readList(value: unknown, fields: readonly string[]): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  const out: Record<string, unknown>[] = [];
  for (const entry of value) {
    const item = readItem(entry, fields);
    if (item === null) return null;
    out.push(item);
  }
  return out;
}

/**
 * A fragment back from clipboard text, or null. Null for text over
 * FRAGMENT_MAX_CHARS, anything but this kind and version, more than
 * FRAGMENT_MAX_ITEMS items, a repeated id within a kind, or any item a board
 * would refuse to take (checkSet), connections to cards outside it included.
 */
export function parseFragment(text: unknown): Fragment | null {
  if (typeof text !== 'string' || text.length > FRAGMENT_MAX_CHARS) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.kind !== FRAGMENT_KIND || raw.version !== FRAGMENT_VERSION) return null;
  const nodes = readList(raw.nodes, NODE_FIELDS);
  const edges = readList(raw.edges, EDGE_FIELDS);
  const ink = readList(raw.ink, INK_FIELDS);
  if (nodes === null || edges === null || ink === null) return null;
  if (nodes.length + edges.length + ink.length > FRAGMENT_MAX_ITEMS) return null;
  for (const list of [nodes, edges, ink]) {
    if (list.some((item) => typeof item.id !== 'string')) return null;
    if (new Set(list.map((item) => item.id)).size !== list.length) return null;
  }
  const board = createBoard({
    nodes: nodes as unknown as BoardNode[],
    edges: edges as unknown as BoardEdge[],
    ink: ink as unknown as InkStroke[],
  });
  if (checkSet(EMPTY_BOARD, board) !== null) return null;
  return {
    nodes: nodes.map((item) => board.nodes.get(item.id as string) as BoardNode),
    edges: edges.map((item) => board.edges.get(item.id as string) as BoardEdge),
    ink: ink.map((item) => board.ink.get(item.id as string) as InkStroke),
  };
}

/**
 * The fragment pasted onto the board: every card, connection and stroke gets
 * a new id from `createId` (cards, then connections, then strokes), each
 * connection names its cards' new ids, every box shifts by `offset` and the
 * items go on top in the fragment's order. A connection whose card isn't in
 * the fragment stays behind and is counted. Refuses an id the factory gives
 * twice or one already in use, and an offset that isn't a whole number.
 */
export function pasteFragment(
  board: Board,
  fragment: Fragment,
  options: { createId: () => string; offset: number },
): CommandResult {
  const { createId, offset } = options;
  if (!Number.isInteger(offset)) {
    return refused('box', `A paste shifts by whole units (got ${offset}).`);
  }
  const nodeIds = takeIds(createId, board.nodes, fragment.nodes.length, 'a card');
  if (!Array.isArray(nodeIds)) return { ok: false, refusal: nodeIds };
  const renamed = new Map(fragment.nodes.map((node, i) => [node.id, nodeIds[i]]));
  const kept = fragment.edges.filter(
    (edge) => renamed.has(edge.fromNode) && renamed.has(edge.toNode),
  );
  const droppedEdges = fragment.edges.length - kept.length;
  const edgeIds = takeIds(createId, board.edges, kept.length, 'a connection');
  if (!Array.isArray(edgeIds)) return { ok: false, refusal: edgeIds };
  const inkIds = takeIds(createId, board.ink, fragment.ink.length, 'an ink stroke');
  if (!Array.isArray(inkIds)) return { ok: false, refusal: inkIds };

  const nodes = new Map(board.nodes);
  const edges = new Map(board.edges);
  const ink = new Map(board.ink);
  const selection: ItemKey[] = [];
  const nodeZ = frontKeys(board.nodes, fragment.nodes.length);
  fragment.nodes.forEach((node, i) => {
    const id = nodeIds[i];
    nodes.set(id, { ...node, id, z: nodeZ[i], x: node.x + offset, y: node.y + offset });
    selection.push(itemKey('n', id));
  });
  const edgeZ = frontKeys(board.edges, kept.length);
  kept.forEach((edge, i) => {
    const id = edgeIds[i];
    edges.set(id, {
      ...edge,
      id,
      z: edgeZ[i],
      fromNode: renamed.get(edge.fromNode) as string,
      toNode: renamed.get(edge.toNode) as string,
    });
    selection.push(itemKey('e', id));
  });
  const inkZ = frontKeys(board.ink, fragment.ink.length);
  fragment.ink.forEach((stroke, i) => {
    const id = inkIds[i];
    ink.set(id, { ...stroke, id, z: inkZ[i], x: stroke.x + offset, y: stroke.y + offset });
    selection.push(itemKey('i', id));
  });
  const count = selection.length;
  const report: CommandReport = droppedEdges > 0 ? { droppedEdges } : {};
  return settle(
    board,
    { ...board, nodes, edges, ink },
    count === 1 ? 'Paste 1 item' : `Paste ${count} items`,
    { selection, report },
  );
}
