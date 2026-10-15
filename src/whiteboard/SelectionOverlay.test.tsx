import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { createBoard } from '@/engine/scene/board';
import { createSceneEditor } from '@/engine/scene/editor';
import { CanvasViewport } from '@/mermaid/CanvasViewport';
import { createBoardState } from './boardState';
import { SelectionOverlay } from './SelectionOverlay';
afterEach(cleanup);
function setup(edgeOnly = false) {
  const board = createBoard({
    nodes: [
      {
        id: 'a',
        type: 'text',
        shape: 'rectangle',
        text: 'A',
        x: 10,
        y: 20,
        width: 100,
        height: 80,
      },
      {
        id: 'b',
        type: 'text',
        shape: 'rectangle',
        text: 'B',
        x: 210,
        y: 20,
        width: 100,
        height: 80,
      },
    ],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
  });
  const editor = createSceneEditor(board, { createId: () => 'unused' });
  const state = createBoardState(editor);
  state.getState().select(new Set([edgeOnly ? 'e:e' : 'n:a']));
  state.setState({
    hover: 'n:b',
    marquee: { x: 0, y: 0, width: 40, height: 50 },
    guides: [{ axis: 'x', position: 10, from: 0, to: 100 }],
  });
  render(
    <CanvasViewport initialTransform={{ scale: 2, offset: { x: 30, y: 40 } }}>
      <SelectionOverlay board={board} state={state} />
    </CanvasViewport>,
  );
}
it('positions handles in world space while their size and outlines stay constant on screen', () => {
  setup();
  const overlay = screen.getByTestId('wb-selection');
  expect(overlay.querySelector('g')?.getAttribute('transform')).toBe('translate(30 40) scale(2)');
  const handles = screen.getAllByTestId('wb-handle');
  expect(handles).toHaveLength(8);
  const corner = handles.find((item) => item.getAttribute('data-handle') === 'nw')!;
  expect(corner.getAttribute('x')).toBe('8.25');
  expect(corner.getAttribute('y')).toBe('18.25');
  expect(corner.getAttribute('width')).toBe('3.5');
  expect(corner.getAttribute('stroke-width')).toBe('0.5');
  expect(screen.getByTestId('wb-guide').getAttribute('x1')).toBe('10');
  expect(screen.getByTestId('wb-marquee').getAttribute('width')).toBe('40');
});
it('selected connections draw their route without resize handles', () => {
  setup(true);
  expect(screen.queryAllByTestId('wb-handle')).toHaveLength(0);
  expect(screen.getByTestId('wb-selection').querySelector('path')?.getAttribute('d')).toContain(
    'C',
  );
});
