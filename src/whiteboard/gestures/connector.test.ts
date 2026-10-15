import { expect, it } from 'vitest';
import { createBoard } from '@/engine/scene/board';
import { createSceneEditor } from '@/engine/scene/editor';
import { connectCards } from './connector';
it('a refused connection never leaves the proposed new card or an undo step behind', () => {
  const board = createBoard({
    nodes: [
      { id: 'a', type: 'text', shape: 'rectangle', text: '', x: 0, y: 0, width: 100, height: 80 },
    ],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'a' }],
  });
  let calls = 0;
  const editor = createSceneEditor(board, { createId: () => (++calls === 1 ? 'new-card' : 'e') });
  expect(
    editor.execute(connectCards, {
      from: { node: 'a' },
      to: null,
      point: { x: 400, y: 200 },
      line: false,
    }).ok,
  ).toBe(false);
  expect(editor.board).toBe(board);
  expect(editor.canUndo()).toBe(false);
});
