import { describe, expect, it } from 'vitest';
import { createBoard, orderedEdges, orderedInk, orderedNodes } from './board';
import {
  BOARD_CLIPBOARD_TYPE,
  FRAGMENT_KIND,
  copyFragment,
  parseFragment,
  pasteFragment,
  serializeFragment,
} from './fragments';
import { FRAGMENT_MAX_CHARS, FRAGMENT_MAX_ITEMS } from './limits';
import type { Board, BoardNode, FileFacts } from './model';

const facts: FileFacts = {
  extra: new Map([['x-extra', [1, 2]]]),
  keyOrder: ['id', 'x-extra', 'type'],
};
const text = (id: string, x = 0, y = 0) =>
  ({ id, type: 'text', text: id, shape: 'diamond', x, y, width: 10, height: 10 }) as BoardNode;

function board(): Board {
  return createBoard({
    nodes: [{ ...text('a', 0, 0), facts }, text('b', 100, 0), text('c', 200, 0)],
    edges: [
      { id: 'ab', fromNode: 'a', toNode: 'b', facts },
      { id: 'bc', fromNode: 'b', toNode: 'c' },
    ],
    ink: [
      {
        id: 's',
        x: 0,
        y: 50,
        width: 4,
        height: 4,
        points: [0, 0, 1000],
        size: 2,
        simulated: false,
      },
    ],
  });
}

function counter(prefix: string) {
  let n = 0;
  return () => `${prefix}${++n}`;
}

describe('copyFragment', () => {
  it('keeps only connections with both ends, and counts the rest', () => {
    const { fragment, report } = copyFragment(board(), ['n:a', 'n:b', 'i:s']);
    expect(fragment.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(fragment.edges.map((e) => e.id)).toEqual(['ab']);
    expect(fragment.ink.map((s) => s.id)).toEqual(['s']);
    expect(report.droppedEdges).toBe(1);
  });

  it('counts a chosen connection whose cards were not chosen', () => {
    expect(copyFragment(board(), ['e:ab']).report.droppedEdges).toBe(1);
  });
});

describe('pasteFragment', () => {
  it('remaps card, connection and stroke ids, re-points connections and offsets the boxes', () => {
    const before = board();
    const { fragment } = copyFragment(before, ['n:a', 'n:b', 'i:s']);
    const result = pasteFragment(before, fragment, { createId: counter('p'), offset: 24 });
    if (!result.ok) throw new Error(result.refusal.message);
    const after = result.board;
    expect(after.nodes.get('p1')).toMatchObject({ x: 24, y: 24, text: 'a', facts });
    expect(after.nodes.get('p2')).toMatchObject({ x: 124, y: 24 });
    expect(after.edges.get('p3')).toMatchObject({ fromNode: 'p1', toNode: 'p2', facts });
    expect(after.ink.get('p4')).toMatchObject({ x: 24, y: 74 });
    expect(result.selection).toEqual(['n:p1', 'n:p2', 'e:p3', 'i:p4']);
    // Pasted items land on top of their kind.
    expect(
      orderedNodes(after)
        .slice(-2)
        .map((n) => n.id),
    ).toEqual(['p1', 'p2']);
    expect(orderedEdges(after).at(-1)?.id).toBe('p3');
    expect(orderedInk(after).at(-1)?.id).toBe('p4');
  });

  it('refuses a duplicate id from the factory', () => {
    const before = board();
    const { fragment } = copyFragment(before, ['n:a', 'n:b']);
    const result = pasteFragment(before, fragment, { createId: () => 'same', offset: 0 });
    expect(result.ok ? null : result.refusal.code).toBe('id');
    const clash = pasteFragment(before, fragment, { createId: counter('c'), offset: 0 });
    expect(clash.ok).toBe(true);
    const taken = pasteFragment(before, fragment, { createId: () => 'c', offset: 0 });
    expect(taken.ok ? null : taken.refusal.message).toBe(
      'The id factory gave a card id c, which is already in use.',
    );
  });
});

describe('serialize and parse', () => {
  it('round-trips, extras included', () => {
    const { fragment } = copyFragment(board(), ['n:a', 'n:b', 'i:s']);
    const text = serializeFragment(fragment);
    expect(JSON.parse(text).kind).toBe(FRAGMENT_KIND);
    const back = parseFragment(text);
    expect(back?.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(back?.nodes[0].facts?.extra.get('x-extra')).toEqual([1, 2]);
    expect(back?.nodes[0].facts?.keyOrder).toEqual(['id', 'x-extra', 'type']);
    expect(back?.edges[0]).toMatchObject({ fromNode: 'a', toNode: 'b' });
    expect(back?.ink[0].points).toEqual([0, 0, 1000]);
    expect(BOARD_CLIPBOARD_TYPE).toBe('application/x-cerebro-board');
  });

  const wrap = (body: Record<string, unknown>) =>
    JSON.stringify({ kind: FRAGMENT_KIND, version: 1, nodes: [], edges: [], ink: [], ...body });
  const card = {
    id: 'a',
    type: 'text',
    text: '',
    shape: 'rectangle',
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  };

  it('refuses text over 2,000,000 characters', () => {
    expect(parseFragment(wrap({ pad: 'x'.repeat(FRAGMENT_MAX_CHARS) }))).toBeNull();
  });

  it('refuses over 5,000 items', () => {
    const many = Array.from({ length: FRAGMENT_MAX_ITEMS + 1 }, (_, i) => ({
      ...card,
      id: `n${i}`,
    }));
    expect(parseFragment(wrap({ nodes: many }))).toBeNull();
    expect(parseFragment(wrap({ nodes: many.slice(1) }))?.nodes).toHaveLength(FRAGMENT_MAX_ITEMS);
  });

  it('refuses a foreign kind, a newer version, an invalid item and broken JSON', () => {
    expect(parseFragment(wrap({ nodes: [card] }))?.nodes).toHaveLength(1);
    expect(parseFragment(wrap({ kind: 'excalidraw', nodes: [card] }))).toBeNull();
    expect(parseFragment(wrap({ version: 2, nodes: [card] }))).toBeNull();
    expect(parseFragment(wrap({ nodes: [{ ...card, x: 0.5 }] }))).toBeNull();
    expect(parseFragment(wrap({ nodes: [{ ...card, color: 'var(--x)' }] }))).toBeNull();
    expect(parseFragment(wrap({ nodes: [card, card] }))).toBeNull();
    expect(
      parseFragment(wrap({ edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }], nodes: [card] })),
    ).toBeNull();
    expect(
      parseFragment(wrap({ nodes: [{ ...card, facts: { extra: 'no', keyOrder: [] } }] })),
    ).toBeNull();
    expect(parseFragment('{"kind":')).toBeNull();
    expect(parseFragment(42)).toBeNull();
  });

  it('keeps only the fields a board holds', () => {
    const back = parseFragment(wrap({ nodes: [{ ...card, sneaky: 1, z: 'zz' }] }));
    expect(back?.nodes[0]).not.toHaveProperty('sneaky');
    expect(back?.nodes[0].z).not.toBe('zz');
  });
});
