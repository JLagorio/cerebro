import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useUiStore } from '@/stores/uiStore';
import { copyChartSvg, saveChartSvg, saveChartPng, copyChartPng } from '@/views/chartExport';
import { BoardActions } from './BoardActions';
import { createBoard } from '@/engine/scene/board';
import { createSceneEditor } from '@/engine/scene/editor';
import { addCards } from '@/engine/scene/commands';
import { createBoardState } from './boardState';
vi.mock('@/views/chartExport', () => ({
  copyChartSvg: vi.fn(),
  copyChartPng: vi.fn(),
  saveChartSvg: vi.fn(),
  saveChartPng: vi.fn(),
}));
const toast = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useUiStore.setState({ toast });
});
it('Undo and Redo follow history; snapping changes only the stored view preference', async () => {
  const editor = createSceneEditor(createBoard(), { createId: () => 'card' });
  const state = createBoardState(editor);
  const stop = state.connect();
  const host = document.createElement('div');
  render(<BoardActions hostRef={{ current: host }} name="Plan" session={{ editor, state }} />);
  const undo = screen.getByRole<HTMLButtonElement>('button', { name: 'Undo in whiteboard' });
  const redo = screen.getByRole<HTMLButtonElement>('button', { name: 'Redo in whiteboard' });
  expect(undo.disabled).toBe(true);
  expect(redo.disabled).toBe(true);
  act(() => {
    editor.execute(addCards, {
      cards: [
        { type: 'text', shape: 'rectangle', text: 'Card', x: 0, y: 0, width: 100, height: 80 },
      ],
    });
  });
  expect(undo.disabled).toBe(false);
  await userEvent.click(undo);
  expect(editor.board.nodes.size).toBe(0);
  expect(redo.disabled).toBe(false);
  await userEvent.click(redo);
  expect(editor.board.nodes.size).toBe(1);
  const board = editor.board;
  await userEvent.click(screen.getByRole('button', { name: 'Whiteboard snapping' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Snap to grid' }));
  expect(state.getState().snap).toEqual({ grid: false, objects: true });
  expect(JSON.parse(localStorage.getItem('cerebro.whiteboard.snap')!)).toEqual({
    grid: false,
    objects: true,
  });
  expect(editor.board).toBe(board);
  expect(editor.canRedo()).toBe(false);
  stop();
});
afterEach(cleanup);
async function choose(label: string) {
  await userEvent.click(screen.getByRole('button', { name: 'Export whiteboard' }));
  await userEvent.click(screen.getByRole('menuitem', { name: label }));
}
function setup() {
  const host = document.createElement('div');
  host.innerHTML = '<svg data-testid="wb-scene"></svg>';
  render(<BoardActions hostRef={{ current: host }} name="Plan" />);
  return host;
}
it('copies the complete SVG and reports a failed PNG copy without throwing', async () => {
  const host = setup();
  vi.mocked(copyChartSvg).mockResolvedValue();
  await choose('Copy SVG');
  await waitFor(() => expect(toast).toHaveBeenCalledWith('SVG copied'));
  expect(copyChartSvg).toHaveBeenCalledWith(host.firstChild, host);
  vi.mocked(copyChartPng).mockRejectedValue(new Error('denied'));
  await choose('Copy PNG');
  await waitFor(() => expect(toast).toHaveBeenCalledWith('Copy PNG failed'));
});
it('names saved exports and says nothing for a cancelled native save', async () => {
  setup();
  vi.mocked(saveChartSvg).mockResolvedValue(null);
  await choose('Save SVG…');
  await waitFor(() => expect(saveChartSvg).toHaveBeenCalled());
  expect(vi.mocked(saveChartSvg).mock.calls[0][2]).toBe('Plan.svg');
  expect(toast).not.toHaveBeenCalled();
  vi.mocked(saveChartPng).mockResolvedValue('/tmp/Plan.png');
  await choose('Save PNG…');
  await waitFor(() => expect(toast).toHaveBeenCalledWith('PNG saved'));
  expect(vi.mocked(saveChartPng).mock.calls[0][2]).toBe('Plan.png');
});
