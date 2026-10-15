import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createBoard } from '@/engine/scene/board';
import { createSceneEditor } from '@/engine/scene/editor';
import { createBoardState } from './boardState';
import { PortsOverlay } from './PortsOverlay';
vi.mock('@/mermaid/CanvasViewport', () => ({
  useCanvasTransform: () => ({ scale: 2, offset: { x: 20, y: 30 } }),
}));
afterEach(cleanup);
it('shows four screen-sized ports and the nearest halo, then hides for another gesture', () => {
  const board = createBoard({
    nodes: [
      { id: 'a', type: 'text', shape: 'rectangle', text: '', x: 0, y: 0, width: 100, height: 80 },
    ],
  });
  const state = createBoardState(createSceneEditor(board, { createId: () => 'new' }));
  state.setState({ hover: 'n:a', port: { node: 'a', side: 'right' } });
  render(<PortsOverlay board={board} state={state} />);
  expect(screen.getAllByTestId('wb-port')).toHaveLength(4);
  expect(screen.getAllByTestId('wb-port')[0].getAttribute('r')).toBe('2');
  expect(screen.getByTestId('wb-port-halo').getAttribute('r')).toBe('6');
  act(() => state.setState({ interactionActive: true }));
  expect(screen.queryByTestId('wb-ports')).toBeNull();
});
