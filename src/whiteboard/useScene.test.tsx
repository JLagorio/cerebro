import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { createBoard, EMPTY_BOARD } from '@/engine/scene/board';
import { createSceneEditor } from '@/engine/scene/editor';
import type { SceneEditor } from '@/engine/scene/editor';
import { useScene } from './useScene';
afterEach(cleanup);
it('takes a read-only board directly and resubscribes when the source changes', () => {
  const next = createBoard({ nodes: [] });
  const { result, rerender } = renderHook(({ source }) => useScene(source), {
    initialProps: { source: EMPTY_BOARD },
  });
  expect(result.current).toBe(EMPTY_BOARD);
  rerender({ source: next });
  expect(result.current).toBe(next);
});
it('catches a board changed between rendering and subscription', () => {
  const next = createBoard({
    nodes: [
      { id: 'a', type: 'text', shape: 'rectangle', text: 'New', x: 0, y: 0, width: 20, height: 20 },
    ],
  });
  const editor = createSceneEditor(EMPTY_BOARD, { createId: () => '' });
  let changed = false;
  const source: SceneEditor = {
    ...editor,
    get board() {
      return editor.board;
    },
    subscribe(listener) {
      if (!changed) {
        changed = true;
        editor.applyExternal(next, 'Outside');
      }
      return editor.subscribe(listener);
    },
  };
  const { result } = renderHook(() => useScene(source));
  expect(result.current).toBe(next);
});
it('applies preview replacements and removals to each item kind without touching the board', () => {
  const board = createBoard({
    nodes: [
      { id: 'a', type: 'text', shape: 'rectangle', text: 'A', x: 0, y: 0, width: 20, height: 20 },
    ],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'a' }],
    ink: [
      {
        id: 'i',
        x: 0,
        y: 0,
        width: 20,
        height: 20,
        points: [0, 0, 500],
        size: 4,
        simulated: false,
      },
    ],
  });
  const editor = createSceneEditor(board, { createId: () => '' });
  const { result } = renderHook(() => useScene(editor));
  act(() => {
    editor.begin('Preview');
    editor.preview(
      new Map([
        ['n:a', null],
        ['e:e', null],
        ['i:i', { ...board.ink.get('i')!, x: 100 }],
      ]),
    );
  });
  expect(result.current.nodes.size).toBe(0);
  expect(result.current.edges.size).toBe(0);
  expect(result.current.ink.get('i')?.x).toBe(100);
  expect(editor.board).toBe(board);
});
