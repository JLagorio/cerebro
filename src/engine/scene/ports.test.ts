import { expect, it } from 'vitest';
import { createBoard } from './board';
import { freeRoute, portAt, portPoints } from './ports';
const board = createBoard({
  nodes: [
    { id: 'g', type: 'group', label: 'Group', x: -100, y: -100, width: 500, height: 400 },
    { id: 'a', type: 'text', shape: 'rectangle', text: '', x: 0, y: 0, width: 100, height: 80 },
    { id: 'b', type: 'text', shape: 'ellipse', text: '', x: 200, y: 0, width: 100, height: 80 },
  ],
  edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
});
it('ports sit fourteen screen pixels beyond each side and keep the resize band free', () => {
  expect(portPoints(board.nodes.get('a')!, 2)).toEqual([
    { side: 'top', point: { x: 50, y: -7 } },
    { side: 'right', point: { x: 107, y: 40 } },
    { side: 'bottom', point: { x: 50, y: 87 } },
    { side: 'left', point: { x: -7, y: 40 } },
  ]);
  expect(portAt(board, { x: 107, y: 40 }, 2)).toEqual({ node: 'a', side: 'right' });
  expect(portAt(board, { x: 100, y: 40 }, 2)).toEqual({ node: 'a' });
});
it('a port wins over a connection; interiors omit a side and groups keep their interior free', () => {
  expect(portAt(board, { x: 114, y: 40 })).toEqual({ node: 'a', side: 'right' });
  expect(portAt(board, { x: 50, y: 40 })).toEqual({ node: 'a' });
  expect(portAt(board, { x: 300, y: 250 })).toBeNull();
  expect(portAt(board, { x: -50, y: -90 })).toEqual({ node: 'g' });
  expect(portAt(board, { x: 210, y: 5 })).toBeNull();
});
it('preview routes use real side anchors and an unbound pointer without mutating the board', () => {
  const from = { node: 'a', side: 'right' as const };
  const free = freeRoute(board, from, { x: 500, y: 300 })!;
  expect(free.from).toEqual({ x: 100, y: 40 });
  expect(free.to).toEqual({ x: 500, y: 300 });
  expect(freeRoute(board, from, { x: 0, y: 0 }, { node: 'b', side: 'left' })?.to).toEqual({
    x: 200,
    y: 40,
  });
  expect(board.nodes.size).toBe(3);
  expect(board.edges.size).toBe(1);
  expect(freeRoute(board, { node: 'gone' }, { x: 0, y: 0 })).toBeNull();
});
