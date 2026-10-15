import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EMPTY_BOARD } from '@/engine/scene/board';
import { createSceneEditor } from '@/engine/scene/editor';
import { BoardCanvas } from './BoardCanvas';
import { createBoardState } from './boardState';
import { Toolbar } from './Toolbar';
afterEach(cleanup);
it('offers nine named, pressed-state tools and returns focus to the board', () => {
  const state = createBoardState(createSceneEditor(EMPTY_BOARD, { createId: () => 'new' }));
  const focus = vi.fn();
  render(<Toolbar state={state} focus={focus} />);
  expect(screen.getAllByTestId('wb-tool')).toHaveLength(9);
  expect(screen.getByRole('button', { name: 'Select' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Pencil' }));
  expect(state.getState().tool).toBe('pencil');
  expect(screen.getByRole('button', { name: 'Pencil' }).getAttribute('aria-pressed')).toBe('true');
  expect(focus).toHaveBeenCalledOnce();
});
it('an immutable scene has no creation toolbar', () => {
  render(<BoardCanvas source={EMPTY_BOARD} cameraKey="readonly" name="Read only" />);
  expect(screen.queryByTestId('wb-toolbar')).toBeNull();
});
