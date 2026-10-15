import { describe, expect, it } from 'vitest';
import { createBoard, orderedNodes } from './board';
import { readCanvas, writeCanvas } from './jsonCanvas';
import { mergeBoards } from './merge';
import type { Board, BoardNode } from './model';

const card = (id: string, text = id, x = 0): BoardNode => ({
  id,
  z: 'a0',
  type: 'text',
  text,
  shape: 'rectangle',
  x,
  y: 0,
  width: 100,
  height: 60,
});
const board = (...nodes: BoardNode[]) =>
  createBoard({ nodes: nodes.map(({ z: _z, ...node }) => node) });
const read = (text: string) => {
  const result = readCanvas(text);
  if (!result.ok) throw new Error(result.message);
  return result.board;
};
const node = (b: Board, id: string) => b.nodes.get(id);

describe('mergeBoards', () => {
  it('keeps disjoint whole-card edits, including geometry rather than only text', () => {
    const base = board(card('a'), card('b'));
    const result = mergeBoards(
      base,
      board(card('a', 'mine', 30), card('b')),
      board(card('a'), card('b', 'outside', 50)),
    );
    expect(node(result.board, 'a')).toMatchObject({ text: 'mine', x: 30 });
    expect(node(result.board, 'b')).toMatchObject({ text: 'outside', x: 50 });
    expect(result.conflicts).toBe(0);
  });
  it('keeps mine for a simultaneous conflict, and equal edits are not conflicts', () => {
    const base = board(card('a'));
    expect(mergeBoards(base, board(card('a', 'mine')), board(card('a', 'theirs')))).toMatchObject({
      conflicts: 1,
    });
    const equal = mergeBoards(base, board(card('a', 'same')), board(card('a', 'same')));
    expect(equal.conflicts).toBe(0);
    expect(node(equal.board, 'a')).toMatchObject({ text: 'same' });
  });
  it.each(['mine', 'theirs'] as const)('takes an uncontested deletion from %s', (side) => {
    const base = board(card('a'));
    expect(
      mergeBoards(base, side === 'mine' ? board() : base, side === 'theirs' ? board() : base).board
        .nodes.size,
    ).toBe(0);
  });
  it('a local deletion wins a conflicting outside edit and a local edit wins an outside deletion', () => {
    const base = board(card('a'));
    expect(mergeBoards(base, board(), board(card('a', 'outside')))).toMatchObject({ conflicts: 1 });
    expect(mergeBoards(base, board(), board(card('a', 'outside'))).board.nodes.size).toBe(0);
    const result = mergeBoards(base, board(card('a', 'mine')), board());
    expect(node(result.board, 'a')).toMatchObject({ text: 'mine' });
    expect(result.conflicts).toBe(1);
  });
  it('merges both additions and follows outside order with mine-only items on top', () => {
    const result = mergeBoards(
      board(card('a')),
      board(card('a'), card('mine')),
      board(card('outside'), card('a')),
    );
    expect(orderedNodes(result.board).map((n) => n.id)).toEqual(['outside', 'a', 'mine']);
    expect(result.conflicts).toBe(0);
    expect(
      mergeBoards(board(), board(card('same', 'mine')), board(card('same', 'theirs'))).conflicts,
    ).toBe(1);
  });
  it('removes connections whose cards the merge lost but keeps pre-existing dangling connections', () => {
    const base = createBoard({
      nodes: [card('a'), card('b')],
      edges: [
        { id: 'ab', fromNode: 'a', toNode: 'b' },
        { id: 'old', fromNode: 'a', toNode: 'gone' },
      ],
    });
    const theirs = { ...base, nodes: new Map([['a', node(base, 'a')!]]) };
    const result = mergeBoards(base, base, theirs);
    expect([...result.board.edges.keys()]).toEqual(['old']);
    expect(result.removedEdges).toBe(1);
  });
  it('keeps unknown raw numbers and independently merges board and cerebro members', () => {
    const base = read('{"nodes":[],"a":1e100,"b":2,"cerebro":{"version":1,"left":1,"right":2}}');
    const mine = read('{"nodes":[],"a":3e100,"b":2,"cerebro":{"version":1,"left":3,"right":2}}');
    const theirs = read('{"nodes":[],"a":1e100,"b":4,"cerebro":{"version":1,"left":1,"right":4}}');
    const result = mergeBoards(base, mine, theirs);
    const bytes = writeCanvas(result.board);
    expect(bytes).toContain('"a": 3e100');
    expect(bytes).toContain('"b": 4');
    expect(bytes).toContain('"left": 3');
    expect(bytes).toContain('"right": 4');
    expect(result.conflicts).toBe(0);
  });
  it('counts a conflict in an opaque board member and preserves mine', () => {
    const result = mergeBoards(read('{"extra":1}'), read('{"extra":2}'), read('{"extra":3}'));
    expect(result.conflicts).toBe(1);
    expect(writeCanvas(result.board)).toContain('"extra": 2');
  });
  it('compares unknown card keys and card extras, not just known model fields', () => {
    const source = (n: number) =>
      read(
        `{"nodes":[{"id":"a","type":"text","text":"A","x":0,"y":0,"width":10,"height":10,"opaque":${n}}]}`,
      );
    expect(mergeBoards(source(1), source(2), source(3)).conflicts).toBe(1);
    expect(writeCanvas(mergeBoards(source(1), source(2), source(3)).board)).toContain('"opaque":2');
  });
});
