import { expect, it } from 'vitest';
import { createBoard } from './board';
import { eraseHits } from './erase';
it('a fast sweep hits a narrow card between its endpoints', () => {
  const board = createBoard({
    nodes: [
      { id: 'a', type: 'text', text: '', shape: 'rectangle', x: 50, y: 0, width: 20, height: 20 },
    ],
  });
  expect([...eraseHits(board, { x: 0, y: 10 }, { x: 150, y: 10 })]).toEqual(['n:a']);
});
it('a group interior survives while its border can be erased', () => {
  const board = createBoard({
    nodes: [{ id: 'g', type: 'group', x: 0, y: 0, width: 200, height: 200 }],
  });
  expect(eraseHits(board, { x: 50, y: 100 }, { x: 150, y: 100 }).size).toBe(0);
  expect([...eraseHits(board, { x: -20, y: 100 }, { x: 20, y: 100 })]).toEqual(['n:g']);
});
it('the sweep finds a stroke and a connection and leaves the source board unchanged', () => {
  const board = createBoard({
    nodes: [
      { id: 'a', type: 'group', x: 0, y: 0, width: 20, height: 20 },
      { id: 'b', type: 'group', x: 100, y: 0, width: 20, height: 20 },
    ],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
    ink: [
      {
        id: 'i',
        x: 50,
        y: 100,
        width: 20,
        height: 1,
        points: [0, 0, 500, 200, 0, 500],
        size: 4,
        simulated: true,
      },
    ],
  });
  const hits = eraseHits(board, { x: 60, y: -20 }, { x: 60, y: 120 });
  expect(hits.has('e:e')).toBe(true);
  expect(hits.has('i:i')).toBe(true);
  expect(board.ink.size).toBe(1);
  expect(board.edges.size).toBe(1);
});
