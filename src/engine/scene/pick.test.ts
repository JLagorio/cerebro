import { expect, it } from 'vitest';
import { createBoard } from './board';
import { hitAt, marqueeHits, selectionBox, segmentDistance } from './pick';
const a = {
  id: 'a',
  type: 'text' as const,
  shape: 'rectangle' as const,
  text: 'A',
  x: 0,
  y: 0,
  width: 100,
  height: 80,
};
it('picks the top card, with ellipse/diamond corners left empty', () => {
  const board = createBoard({ nodes: [a, { ...a, id: 'b', shape: 'ellipse' }] });
  expect(hitAt(board, { x: 50, y: 40 })).toBe('n:b');
  expect(hitAt(board, { x: 1, y: 1 })).toBe('n:a');
  expect(hitAt(createBoard({ nodes: [{ ...a, shape: 'diamond' }] }), { x: 1, y: 1 })).toBeNull();
});
it('visible connections win over cards and dangling connections never hit', () => {
  const board = createBoard({
    nodes: [a, { ...a, id: 'b', x: 200 }],
    edges: [
      { id: 'e', fromNode: 'a', toNode: 'b' },
      { id: 'lost', fromNode: 'no', toNode: 'b' },
    ],
  });
  expect(hitAt(board, { x: 150, y: 40 })).toBe('e:e');
  expect(hitAt(board, { x: 150, y: 48 }, 2)).toBeNull();
  expect(hitAt(board, { x: 150, y: 48 }, 0.5)).toBe('e:e');
});
it('a group owns only its label and border while ink follows its samples', () => {
  const board = createBoard({
    nodes: [{ id: 'g', type: 'group', label: 'Group', x: 0, y: 0, width: 400, height: 300 }],
    ink: [
      {
        id: 'i',
        x: 100,
        y: 100,
        width: 100,
        height: 100,
        points: [0, 0, 500, 1000, 1000, 500],
        size: 4,
        simulated: false,
      },
    ],
  });
  expect(hitAt(board, { x: 30, y: 20 })).toBe('n:g');
  expect(hitAt(board, { x: 399, y: 120 })).toBe('n:g');
  expect(hitAt(board, { x: 300, y: 150 })).toBeNull();
  expect(hitAt(board, { x: 150, y: 150 })).toBe('i:i');
  expect(hitAt(board, { x: 110, y: 190 })).toBeNull();
});
it('marquees intersect cards but must enclose groups, and selections have no edge-only box', () => {
  const board = createBoard({
    nodes: [
      { id: 'g', type: 'group', x: -10, y: -10, width: 300, height: 120 },
      a,
      { ...a, id: 'b', x: 150 },
    ],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
  });
  expect(marqueeHits(board, { x: 20, y: 10, width: 150, height: 50 })).toEqual(['n:a', 'n:b']);
  expect(marqueeHits(board, { x: -20, y: -20, width: 400, height: 200 })).toEqual([
    'n:g',
    'n:a',
    'n:b',
  ]);
  expect(selectionBox(board, ['e:e'])).toBeNull();
  expect(selectionBox(board, ['n:a', 'n:b'])).toEqual({ x: 0, y: 0, width: 250, height: 80 });
  expect(segmentDistance({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
});
