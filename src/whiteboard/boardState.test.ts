import { expect, it } from 'vitest';
import { createBoard } from '@/engine/scene/board';
import { deleteItems } from '@/engine/scene/commands';
import { createSceneEditor } from '@/engine/scene/editor';
import { createBoardState } from './boardState';
it('selection and hover reconcile after a deletion without storing view state in history', () => {
  const editor = createSceneEditor(
    createBoard({
      nodes: [
        {
          id: 'a',
          type: 'text',
          text: 'A',
          shape: 'rectangle',
          x: 0,
          y: 0,
          width: 100,
          height: 80,
        },
      ],
    }),
    { createId: () => '' },
  );
  const state = createBoardState(editor);
  const stop = state.connect();
  state.getState().select(['n:a']);
  state.setState({ hover: 'n:a' });
  expect(editor.canUndo()).toBe(false);
  editor.execute(deleteItems, { keys: ['n:a'] });
  expect(state.getState().selection.size).toBe(0);
  expect(state.getState().hover).toBeNull();
  stop();
});
it('throwing or corrupt preference storage keeps both defaults and never blocks a live toggle', () => {
  const storage = {
    getItem: () => {
      throw new Error('off');
    },
    setItem: () => {
      throw new Error('off');
    },
  };
  const editor = createSceneEditor(createBoard(), { createId: () => '' });
  const state = createBoardState(editor, storage);
  expect(state.getState().snap).toEqual({ grid: true, objects: true });
  expect(() => state.getState().setSnap({ grid: false, objects: false })).not.toThrow();
  expect(state.getState().snap.grid).toBe(false);
  expect(
    createBoardState(editor, { getItem: () => '{', setItem: () => {} }).getState().snap.grid,
  ).toBe(true);
});
