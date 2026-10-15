import { describe, expect, it } from 'vitest';
import {
  EMPTY_BOARD,
  boardBounds,
  checkSet,
  createBoard,
  itemKey,
  membersOf,
  orderedNodes,
  paintOrder,
  parseItemKey,
  problemsOf,
} from './board';
import type { Board, BoardEdge, BoardNode, InkStroke } from './model';

const text = (id: string, x: number, y: number, w = 100, h = 50, over: Partial<BoardNode> = {}) =>
  ({
    id,
    type: 'text',
    text: id,
    shape: 'rectangle',
    x,
    y,
    width: w,
    height: h,
    ...over,
  }) as BoardNode;
const group = (id: string, x: number, y: number, w: number, h: number) =>
  ({ id, type: 'group', x, y, width: w, height: h }) as BoardNode;
const edge = (id: string, fromNode: string, toNode: string, over: Partial<BoardEdge> = {}) => ({
  id,
  fromNode,
  toNode,
  ...over,
});
const ink = (id: string, x: number, y: number, over: Partial<InkStroke> = {}) => ({
  id,
  x,
  y,
  width: 10,
  height: 10,
  points: [0, 0, 500],
  size: 4,
  simulated: true,
  ...over,
});

describe('createBoard and order', () => {
  it('assigns z in the given order and paints cards, then connections, then ink', () => {
    const board = createBoard({
      nodes: [text('b', 0, 0), text('a', 0, 0)],
      edges: [edge('e', 'a', 'b')],
      ink: [ink('s', 0, 0)],
    });
    expect(orderedNodes(board).map((n) => n.id)).toEqual(['b', 'a']);
    expect(paintOrder(board).map((p) => p.key)).toEqual(['n:b', 'n:a', 'e:e', 'i:s']);
  });

  it('puts an item without z above the ones that have one', () => {
    const board = createBoard({ nodes: [text('x', 0, 0), { ...text('y', 0, 0), z: 'a5' }] });
    expect(orderedNodes(board).map((n) => n.id)).toEqual(['y', 'x']);
  });

  it('keys items by kind, so ids repeat safely across kinds', () => {
    expect(itemKey('n', 'a:b')).toBe('n:a:b');
    expect(parseItemKey('n:a:b')).toEqual({ kind: 'n', id: 'a:b' });
    expect(parseItemKey('x:a')).toBeNull();
    expect(parseItemKey('n')).toBeNull();
    const board = createBoard({ nodes: [text('__proto__', 0, 0)] });
    expect(board.nodes.get('__proto__')?.id).toBe('__proto__');
  });
});

describe('membersOf', () => {
  const board = createBoard({
    nodes: [
      group('outer', 0, 0, 500, 500),
      group('inner', 50, 50, 200, 200),
      text('deep', 60, 60, 50, 50),
      text('half', 450, 450, 100, 100),
      text('away', 900, 900),
    ],
    ink: [ink('in', 10, 10), ink('out', 495, 10)],
  });

  it('takes nested groups and their cards and strokes, and leaves a half-overlapping card out', () => {
    expect(membersOf(board, 'outer')).toEqual(['n:inner', 'n:deep', 'i:in']);
    expect(membersOf(board, 'inner')).toEqual(['n:deep']);
    expect(membersOf(board, 'deep')).toEqual([]);
    expect(membersOf(board, 'nothing')).toEqual([]);
  });

  it('bounds every card and stroke', () => {
    expect(boardBounds(board)).toEqual({ x: 0, y: 0, width: 1000, height: 950 });
    expect(boardBounds(EMPTY_BOARD)).toBeNull();
  });
});

describe('problemsOf', () => {
  it('reports each dangling end', () => {
    const board = createBoard({
      nodes: [text('a', 0, 0)],
      edges: [
        edge('from', 'gone', 'a'),
        edge('to', 'a', 'gone'),
        edge('both', 'x', 'y'),
        edge('ok', 'a', 'a'),
      ],
    });
    expect(problemsOf(board)).toEqual([
      { kind: 'dangling-edge', key: 'e:from', ends: 'from' },
      { kind: 'dangling-edge', key: 'e:to', ends: 'to' },
      { kind: 'dangling-edge', key: 'e:both', ends: 'both' },
    ]);
  });

  it('reports an undrawable colour on a card, a connection and a stroke', () => {
    const board = createBoard({
      nodes: [
        text('a', 0, 0, 10, 10, { color: 'var(--x)' }),
        text('b', 0, 0, 10, 10, { color: '#abc' }),
      ],
      edges: [edge('e', 'a', 'b', { color: 'red' })],
      ink: [ink('s', 0, 0, { color: 'blue' })],
    });
    expect(problemsOf(board)).toEqual([
      { kind: 'undrawable-color', key: 'n:a', color: 'var(--x)' },
      { kind: 'undrawable-color', key: 'e:e', color: 'red' },
      { kind: 'undrawable-color', key: 'i:s', color: 'blue' },
    ]);
  });
});

describe('checkSet', () => {
  const loaded = createBoard({
    nodes: [text('a', 0, 0, 10, 10, { color: 'var(--x)' }), text('b', 50, 0)],
    edges: [edge('ab', 'a', 'b'), edge('dangling', 'a', 'gone')],
  });
  const withNode = (board: Board, node: BoardNode): Board => ({
    ...board,
    nodes: new Map(board.nodes).set(node.id, node),
  });

  it('lets a moved card keep a loaded var(--x) colour, and a loaded dangling connection ride along', () => {
    const a = loaded.nodes.get('a') as BoardNode;
    expect(checkSet(loaded, withNode(loaded, { ...a, x: 5 }))).toBeNull();
  });

  it('refuses setting var(--x)', () => {
    const b = loaded.nodes.get('b') as BoardNode;
    expect(checkSet(loaded, withNode(loaded, { ...b, color: 'var(--x)' }))).toMatchObject({
      code: 'color',
    });
  });

  it('refuses a fractional box, a size under 1 and a box past the coordinate cap', () => {
    const b = loaded.nodes.get('b') as BoardNode;
    expect(checkSet(loaded, withNode(loaded, { ...b, x: 1.5 }))?.message).toBe(
      'Card b: x must be a whole number (got 1.5).',
    );
    expect(checkSet(loaded, withNode(loaded, { ...b, width: 0 }))?.code).toBe('box');
    expect(checkSet(loaded, withNode(loaded, { ...b, y: -1_000_000_001 }))?.code).toBe('box');
  });

  it('refuses an id over 128 characters and an unknown shape', () => {
    const long = 'x'.repeat(129);
    expect(checkSet(EMPTY_BOARD, createBoard({ nodes: [text(long, 0, 0)] }))?.code).toBe('id');
    expect(checkSet(EMPTY_BOARD, createBoard({ nodes: [text('é'.repeat(128), 0, 0)] }))).toBeNull();
    expect(
      checkSet(
        EMPTY_BOARD,
        createBoard({ nodes: [text('a', 0, 0, 10, 10, { shape: 'star' } as never)] }),
      )?.code,
    ).toBe('vocab');
  });

  it('refuses a removal that strands a connection, and a connection added to a missing card', () => {
    const nodes = new Map(loaded.nodes);
    nodes.delete('b');
    expect(checkSet(loaded, { ...loaded, nodes })?.message).toBe(
      'Removing card b would leave connection ab with one end.',
    );
    const edges = new Map(loaded.edges).set('new', {
      id: 'new',
      z: 'a5',
      fromNode: 'a',
      toNode: 'nope',
    });
    expect(checkSet(loaded, { ...loaded, edges })?.code).toBe('end');
  });
});
