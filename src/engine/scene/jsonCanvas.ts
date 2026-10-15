import {
  createBoard,
  EMPTY_BOARD,
  orderedEdges,
  orderedInk,
  orderedNodes,
  problemsOf,
  type Problem,
} from './board';
import { CANVAS_FORMAT as F } from './format';
import {
  hasLoneSurrogate,
  parseJson,
  rawValue,
  utf8Length,
  type JsonObject,
  type JsonValue,
  type RawValue,
} from './json';
import { inkProblem } from './ink';
import type {
  Board,
  BoardEdge,
  BoardNode,
  Box,
  DistributiveOmit,
  FileFacts,
  InkStroke,
} from './model';

export { EMPTY_BOARD } from './board';
export type CanvasProblem =
  Problem | { readonly kind: 'orphan-card-extras'; readonly count: number };
export type CanvasReason =
  'too_large' | 'not_text' | 'not_json' | 'not_board' | 'version' | 'invalid';
export type CanvasRead =
  | { readonly ok: true; readonly board: Board; readonly problems: readonly CanvasProblem[] }
  | { readonly ok: false; readonly reason: CanvasReason; readonly message: string };

class Unreadable extends Error {
  constructor(
    readonly reason: CanvasReason,
    message: string,
  ) {
    super(message);
  }
}
const fail = (reason: CanvasReason, message: string): never => {
  throw new Unreadable(reason, message);
};
function object(value: JsonValue | undefined, what: string): JsonObject {
  if (value?.kind !== 'object') return fail('not_board', `${what} must be an object.`);
  if ([...value.members.keys()].some(hasLoneSurrogate))
    return fail('not_board', `${what} must have valid text keys.`);
  return value;
}
function list(value: JsonValue | undefined, what: string): readonly JsonValue[] {
  if (value === undefined) return [];
  if (value.kind !== 'array') return fail('not_board', `${what} must be an array.`);
  return value.items;
}
function text(value: JsonValue | undefined, what: string): string {
  if (value?.kind !== 'string' || hasLoneSurrogate(value.value))
    return fail('invalid', `${what} must be valid text.`);
  return value.value;
}
function integer(value: JsonValue | undefined, what: string, min: number, max: number): number {
  if (
    value?.kind !== 'number' ||
    !/^-?(?:0|[1-9][0-9]*)$/.test(value.raw) ||
    !Number.isSafeInteger(value.value) ||
    value.value < min ||
    value.value > max
  )
    return fail('invalid', `${what} must be a whole-number literal from ${min} to ${max}.`);
  return value.value === 0 ? 0 : value.value;
}
function idOf(o: JsonObject, what: string, seen: Set<string>): string {
  const id = text(o.members.get('id'), `${what} id`);
  if (id.length === 0 || [...id].length > F.limits.max_id_chars)
    fail('invalid', `${what} id must have 1 to ${F.limits.max_id_chars} characters.`);
  if (seen.has(id)) fail('invalid', `${what} id ${id} is repeated.`);
  seen.add(id);
  return id;
}
function boxOf(o: JsonObject, what: string): Box {
  const n = F.limits.max_coord;
  return {
    x: integer(o.members.get('x'), `${what}: x`, -n, n),
    y: integer(o.members.get('y'), `${what}: y`, -n, n),
    width: integer(o.members.get('width'), `${what}: width`, 1, n),
    height: integer(o.members.get('height'), `${what}: height`, 1, n),
  };
}
function optional(
  o: JsonObject,
  key: string,
  what: string,
  allowed?: readonly string[],
): string | undefined {
  const v = o.members.get(key);
  if (v === undefined) return undefined;
  const s = text(v, `${what}: ${key}`);
  if (allowed !== undefined && !allowed.includes(s))
    fail('invalid', `${what}: ${key} must be one of ${allowed.join(', ')}.`);
  return s;
}
function factsOf(o: JsonObject, known: readonly string[]): FileFacts {
  return {
    keyOrder: [...o.members.keys()],
    extra: new Map(
      [...o.members].filter(([k]) => !known.includes(k)).map(([k, v]) => [k, rawValue(v)]),
    ),
  };
}

/** Read without repairing, writing or discarding unknown keys. */
export function readCanvas(source: string): CanvasRead {
  if (utf8Length(source) > F.limits.max_bytes)
    return {
      ok: false,
      reason: 'too_large',
      message: `This whiteboard is over the ${F.limits.max_bytes} byte limit.`,
    };
  if (hasLoneSurrogate(source))
    return { ok: false, reason: 'not_text', message: 'This whiteboard is not valid UTF-8 text.' };
  const input = source.startsWith('\uFEFF') ? source.slice(1) : source;
  if (/^[ \t\r\n]*$/.test(input)) return { ok: true, board: EMPTY_BOARD, problems: [] };
  let parsed: JsonValue;
  try {
    parsed = parseJson(input, F.limits.max_depth);
  } catch {
    return { ok: false, reason: 'not_json', message: "This whiteboard isn't valid JSON." };
  }
  try {
    const top = object(parsed, 'A whiteboard');
    const nodes = list(top.members.get('nodes'), 'Whiteboard nodes');
    const edges = list(top.members.get('edges'), 'Whiteboard edges');
    const cerebroValue = top.members.get('cerebro');
    const cerebro =
      cerebroValue === undefined ? undefined : object(cerebroValue, 'Whiteboard extras');
    if (cerebro !== undefined) {
      const version = cerebro.members.get('version');
      if (
        version?.kind !== 'number' ||
        !Number.isSafeInteger(version.value) ||
        !F.cerebro_versions.includes(version.value)
      ) {
        fail(
          'version',
          `This whiteboard uses an unsupported Cerebro version${version?.kind === 'number' ? ` (${version.raw})` : ''}.`,
        );
      }
    }
    const cardsValue = cerebro?.members.get('cards');
    const cards = cardsValue === undefined ? undefined : object(cardsValue, 'Card extras');
    const strokes = list(cerebro?.members.get('ink'), 'Whiteboard ink');
    if (
      nodes.length > F.limits.max_nodes ||
      edges.length > F.limits.max_edges ||
      strokes.length > F.limits.max_strokes
    )
      fail(
        'too_large',
        'This whiteboard has more cards, connections or ink strokes than the limit.',
      );
    const nodeIds = new Set<string>();
    const nodeRows = nodes.map((value): DistributiveOmit<BoardNode, 'z'> => {
      const o = object(value, 'A card');
      const id = idOf(o, 'card', nodeIds);
      const what = `card ${id}`;
      const type = text(o.members.get('type'), `${what}: type`);
      if (!F.vocab.node_types.includes(type))
        fail('invalid', `${what}: type must be one of ${F.vocab.node_types.join(', ')}.`);
      const kind = type as BoardNode['type'];
      const base = {
        id,
        ...boxOf(o, what),
        ...(o.members.has('color')
          ? { color: text(o.members.get('color'), `${what}: color`) }
          : {}),
        facts: factsOf(o, F.key_order[kind]),
      };
      const extraValue = cards?.members.get(id);
      const extra = extraValue === undefined ? undefined : object(extraValue, `${what} extras`);
      const shape =
        extra === undefined ? undefined : optional(extra, 'shape', what, F.vocab.shapes);
      const cardFacts =
        extra === undefined
          ? {}
          : { cardFacts: factsOf(extra, kind === 'text' ? F.key_order.card : []) };
      switch (kind) {
        case 'text':
          return {
            ...base,
            ...cardFacts,
            type: kind,
            text: text(o.members.get('text'), `${what}: text`),
            shape: shape ?? 'rectangle',
          } as Omit<Extract<BoardNode, { type: 'text' }>, 'z'>;
        case 'file': {
          const file = text(o.members.get('file'), `${what}: file`);
          if (!file) fail('invalid', `${what}: file must name a path.`);
          const subpath = optional(o, 'subpath', what);
          return {
            ...base,
            ...cardFacts,
            type: kind,
            file,
            ...(subpath === undefined ? {} : { subpath }),
          } as Omit<Extract<BoardNode, { type: 'file' }>, 'z'>;
        }
        case 'link':
          return {
            ...base,
            ...cardFacts,
            type: kind,
            url: text(o.members.get('url'), `${what}: url`),
          } as Omit<Extract<BoardNode, { type: 'link' }>, 'z'>;
        case 'group': {
          const values = Object.fromEntries(
            ['label', 'background', 'backgroundStyle'].flatMap((k) => {
              const v = optional(
                o,
                k,
                what,
                k === 'backgroundStyle' ? F.vocab.background_styles : undefined,
              );
              return v === undefined ? [] : [[k, v]];
            }),
          );
          return { ...base, ...cardFacts, type: kind, ...values };
        }
      }
    });
    const edgeIds = new Set<string>();
    const edgeRows = edges.map((value): Omit<BoardEdge, 'z'> => {
      const o = object(value, 'A connection');
      const id = idOf(o, 'connection', edgeIds);
      const what = `connection ${id}`;
      const values = Object.fromEntries(
        ['fromSide', 'toSide', 'fromEnd', 'toEnd', 'color', 'label'].flatMap((k) => {
          const allowed = k.endsWith('Side')
            ? F.vocab.sides
            : k.endsWith('End')
              ? F.vocab.ends
              : undefined;
          const v = optional(o, k, what, allowed);
          return v === undefined ? [] : [[k, v]];
        }),
      );
      return {
        id,
        fromNode: text(o.members.get('fromNode'), `${what}: fromNode`),
        toNode: text(o.members.get('toNode'), `${what}: toNode`),
        ...values,
        facts: factsOf(o, F.key_order.edge),
      };
    });
    const strokeIds = new Set<string>();
    const inkRows = strokes.map((value): Omit<InkStroke, 'z'> => {
      const o = object(value, 'An ink stroke');
      const id = idOf(o, 'ink stroke', strokeIds);
      const what = `ink stroke ${id}`;
      const simulated = o.members.get('simulated');
      if (simulated?.kind !== 'boolean')
        return fail('invalid', `${what}: simulated must be true or false.`);
      const points = list(o.members.get('points'), `${what}: points`).map((v) =>
        integer(v, `${what}: point`, 0, F.limits.max_coord * 10),
      );
      const color = optional(o, 'color', what);
      const row = {
        id,
        ...boxOf(o, what),
        size: integer(o.members.get('size'), `${what}: size`, 1, F.limits.max_ink_size),
        simulated: simulated.value,
        points,
        ...(color === undefined ? {} : { color }),
        facts: factsOf(o, F.key_order.stroke),
      };
      const problem = inkProblem({ ...row, z: '' });
      if (problem !== null) fail('invalid', `${what}: ${problem}.`);
      return row;
    });
    let orphanCount = 0;
    for (const [id, value] of cards?.members ?? []) {
      const extra = object(value, `card ${id} extras`);
      optional(extra, 'shape', `card ${id}`, F.vocab.shapes);
      if (!nodeIds.has(id)) orphanCount += 1;
    }
    const board = createBoard({
      nodes: nodeRows,
      edges: edgeRows,
      ink: inkRows,
      facts: factsOf(top, F.key_order.board),
      ...(cerebro === undefined ? {} : { cerebro: factsOf(cerebro, F.key_order.cerebro) }),
    });
    const problems: CanvasProblem[] = problemsOf(board);
    if (orphanCount) problems.push({ kind: 'orphan-card-extras', count: orphanCount });
    return { ok: true, board, problems };
  } catch (error) {
    if (error instanceof Unreadable)
      return { ok: false, reason: error.reason, message: error.message };
    throw error;
  }
}

type Pair = readonly [string, string];
const encode = (v: unknown): string => JSON.stringify(v);
function rawText(value: unknown): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('canvasRaw' in value) ||
    typeof value.canvasRaw !== 'string'
  )
    throw new Error('A whiteboard extra lost its raw JSON.');
  return parseJson((value as RawValue).canvasRaw, F.limits.max_depth).raw;
}
/** Original order first, then newly gained known keys in the artifact's order. */
function pairs(
  facts: FileFacts | undefined,
  known: readonly Pair[],
  order: readonly string[],
): Pair[] {
  const values = new Map<string, string>();
  for (const [k, v] of facts?.extra ?? []) values.set(k, rawText(v));
  for (const [k, v] of known) values.set(k, v);
  const keys = [...new Set([...(facts?.keyOrder ?? []), ...order, ...values.keys()])];
  return keys.filter((k) => values.has(k)).map((k) => [k, values.get(k)!]);
}
const compact = (entries: readonly Pair[]): string =>
  `{${entries.map(([k, v]) => `${encode(k)}:${v}`).join(',')}}`;
function encodedItem(item: BoardNode | BoardEdge | InkStroke, order: readonly string[]): string {
  const fields = new Map(Object.entries(item));
  return compact(
    pairs(
      item.facts,
      order.flatMap((k) => (fields.has(k) ? [[k, encode(fields.get(k))] as Pair] : [])),
      order,
    ),
  );
}
function multiline(entries: readonly Pair[], level: number): string {
  if (entries.length === 0) return '{}';
  const pad = F.layout.indent.repeat(level);
  return `{\n${entries.map(([k, v]) => `${pad}${encode(k)}: ${v}`).join(',\n')}\n${F.layout.indent.repeat(level - 1)}}`;
}
function array(rows: readonly string[], level: number): string {
  return rows.length === 0
    ? '[]'
    : `[\n${rows.map((v) => F.layout.indent.repeat(level) + v).join(',\n')}\n${F.layout.indent.repeat(level - 1)}]`;
}

/** Canonical layout; unknown values keep their minified tokens exactly. */
export function writeCanvas(board: Board): string {
  const nodes = orderedNodes(board);
  const edges = orderedEdges(board);
  const ink = orderedInk(board);
  const known: Pair[] = [];
  if (nodes.length || board.facts === undefined || board.facts.keyOrder.includes('nodes'))
    known.push([
      'nodes',
      array(
        nodes.map((n) => encodedItem(n, F.key_order[n.type])),
        2,
      ),
    ]);
  if (edges.length || board.facts === undefined || board.facts.keyOrder.includes('edges'))
    known.push([
      'edges',
      array(
        edges.map((e) => encodedItem(e, F.key_order.edge)),
        2,
      ),
    ]);
  const cards: Pair[] = nodes.flatMap((n) => {
    const shape: Pair[] =
      n.type === 'text' && n.shape !== 'rectangle' ? [['shape', encode(n.shape)]] : [];
    return n.cardFacts !== undefined || shape.length
      ? [[n.id, compact(pairs(n.cardFacts, shape, F.key_order.card))] as Pair]
      : [];
  });
  if (board.cerebro !== undefined || cards.length || ink.length) {
    const extras: Pair[] = [['version', String(F.cerebro_versions[0])]];
    if (cards.length || board.cerebro?.keyOrder.includes('cards'))
      extras.push(['cards', multiline(cards, 3)]);
    if (ink.length || board.cerebro?.keyOrder.includes('ink'))
      extras.push([
        'ink',
        array(
          ink.map((i) => encodedItem(i, F.key_order.stroke)),
          3,
        ),
      ]);
    known.push(['cerebro', multiline(pairs(board.cerebro, extras, F.key_order.cerebro), 2)]);
  }
  const output = multiline(pairs(board.facts, known, F.key_order.board), 1);
  return output + (F.layout.trailing_newline ? '\n' : '');
}

export function itemText(node: BoardNode): string {
  return node.type === 'text' ? node.text : node.type === 'group' ? (node.label ?? '') : '';
}
export const textsOf = (board: Board): string[] =>
  orderedNodes(board).map(itemText).filter(Boolean);
export const fileRefsOf = (board: Board): { file: string; subpath?: string }[] =>
  orderedNodes(board).flatMap((n) =>
    n.type === 'file'
      ? [{ file: n.file, ...(n.subpath === undefined ? {} : { subpath: n.subpath }) }]
      : [],
  );
export const searchTextOf = (board: Board): string => textsOf(board).join('\n');
export function fileLinkTarget(file: string, subpath?: string): string {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const stem = name.replace(/\.md$/i, '');
  const target =
    /^project\.md$/i.test(name) && file.includes('/')
      ? file.slice(0, file.lastIndexOf('/')).split('/').at(-1)!
      : stem;
  return (
    target +
    (subpath === undefined || subpath === ''
      ? ''
      : subpath.startsWith('#')
        ? subpath
        : `#${subpath}`)
  );
}
