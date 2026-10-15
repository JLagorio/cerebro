import { expect, it } from 'vitest';
import { createBoard } from './board';
import { colorItems, common, MIXED, sectionsFor, selectedBoxes, sizeInk } from './inspect';
import { createSceneEditor } from './editor';
it('common separates mixed and missing values without borrowing zero', () => {
  expect(common([])).toBeUndefined();
  expect(common([undefined, undefined])).toBeUndefined();
  expect(common([0, 0])).toBe(0);
  expect(common([0, undefined])).toBe(MIXED);
  expect(common(['mixed', 'mixed'])).toBe('mixed');
});
it('a mixed selection changes durable colour together and ink width leaves other items untouched', () => {
  const board = createBoard({
    nodes: [
      { id: 'a', type: 'text', shape: 'rectangle', text: '', x: 0, y: 0, width: 20, height: 20 },
    ],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'a' }],
    ink: [
      {
        id: 'i',
        x: 0,
        y: 0,
        width: 20,
        height: 20,
        size: 2,
        simulated: true,
        points: [0, 0, 500, 200, 200, 500],
      },
    ],
  });
  const editor = createSceneEditor(board, { createId: () => 'unused' });
  const keys = ['n:a', 'e:e', 'i:i'] as const;
  expect(editor.execute(colorItems, { keys, color: '#AbC' }).ok).toBe(true);
  expect(
    [
      ...editor.board.nodes.values(),
      ...editor.board.edges.values(),
      ...editor.board.ink.values(),
    ].map((item) => item.color),
  ).toEqual(['#aabbcc', '#aabbcc', '#aabbcc']);
  const painted = editor.board;
  editor.execute(colorItems, { keys, color: '#aabbcc' });
  expect(editor.board).toBe(painted);
  expect(editor.execute(colorItems, { keys, color: 'var(--paint)' }).ok).toBe(false);
  expect(editor.board).toBe(painted);
  editor.execute(sizeInk, { keys, size: 32 });
  expect(editor.board.ink.get('i')?.size).toBe(32);
  expect(editor.board.nodes).toBe(painted.nodes);
  expect(editor.board.edges).toBe(painted.edges);
  const resized = editor.board;
  expect(editor.execute(sizeInk, { keys, size: 33 }).ok).toBe(false);
  expect(editor.board).toBe(resized);
  editor.execute(colorItems, { keys, color: null });
  expect(
    [
      ...editor.board.nodes.values(),
      ...editor.board.edges.values(),
      ...editor.board.ink.values(),
    ].every((item) => !('color' in item)),
  ).toBe(true);
  editor.undo();
  editor.undo();
  editor.undo();
  expect(editor.board).toEqual(board);
  expect(editor.canUndo()).toBe(false);
});
it('sections and layout counts follow capabilities and ignore missing selection keys', () => {
  const board = createBoard({
    nodes: [
      { id: 'a', type: 'text', shape: 'rectangle', text: '', x: 0, y: 0, width: 20, height: 20 },
      { id: 'b', type: 'file', file: 'a.md', x: 40, y: 0, width: 20, height: 20 },
      { id: 'g', type: 'group', x: 0, y: 0, width: 100, height: 100 },
    ],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
  });
  expect(sectionsFor(board, ['e:e'])).toMatchObject({
    count: 1,
    position: false,
    connection: true,
    align: 0,
  });
  expect(sectionsFor(board, ['n:a', 'n:b', 'n:g', 'e:e', 'n:gone'])).toEqual({
    count: 4,
    position: true,
    color: true,
    shape: true,
    ink: false,
    group: true,
    connection: true,
    pointer: true,
    align: 3,
    distribute: 3,
  });
  expect(selectedBoxes(board, ['n:a', 'e:e'])).toHaveLength(1);
});
