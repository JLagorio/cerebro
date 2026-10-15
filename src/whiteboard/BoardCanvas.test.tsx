import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EMPTY_BOARD } from '@/engine/scene/board';
import { BoardCanvas } from './BoardCanvas';
import { createRef } from 'react';
import type { BoardCanvasHandle } from './BoardCanvas';
import { createSceneEditor } from '@/engine/scene/editor';
import { readCamera, writeCamera } from './camera';
vi.mock('./BoardActions', () => ({ BoardActions: () => null }));
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('loads a saved camera and stores the last change once after500ms', () => {
  writeCamera('one', { scale: 1.5, offset: { x: 20, y: 40 } });
  const save = vi.spyOn(window.localStorage, 'setItem');
  const { unmount } = render(<BoardCanvas source={EMPTY_BOARD} name="One" cameraKey="one" />);
  expect(screen.getByTestId('canvas-plane').style.transform).toBe(
    'translate(20px, 40px) scale(1.5)',
  );
  fireEvent.wheel(screen.getByTestId('canvas-viewport'), { deltaX: 10, deltaY: 20 });
  fireEvent.wheel(screen.getByTestId('canvas-viewport'), { deltaY: 30 });
  act(() => vi.advanceTimersByTime(499));
  expect(save).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(save).toHaveBeenCalledTimes(1);
  expect(readCamera('one')).toEqual({ scale: 1.5, offset: { x: 10, y: -10 } });
  unmount();
  expect(save).toHaveBeenCalledTimes(1);
});
it('flushes an outstanding camera on unmount and keeps path identities separate', () => {
  const { rerender, unmount } = render(
    <BoardCanvas source={EMPTY_BOARD} name="One" cameraKey="one" />,
  );
  fireEvent.wheel(screen.getByTestId('canvas-viewport'), { deltaY: 70 });
  rerender(<BoardCanvas source={EMPTY_BOARD} name="Two" cameraKey="two" />);
  expect(readCamera('one')?.offset.y).toBe(-70);
  expect(screen.getByTestId('canvas-plane').style.transform).toBe('translate(0px, 0px) scale(1)');
  unmount();
  expect(readCamera('two')?.offset.y).toBe(0);
});
it('height mode ignores saved camera, lets the wheel pass and never stores a camera', () => {
  writeCamera('embed', { scale: 2, offset: { x: 20, y: 30 } });
  const save = vi.spyOn(window.localStorage, 'setItem');
  const { unmount } = render(
    <BoardCanvas source={EMPTY_BOARD} name="Embed" cameraKey="embed" height={360} />,
  );
  expect(screen.getByTestId('wb-board').style.height).toBe('360px');
  const event = new WheelEvent('wheel', { deltaY: 50, bubbles: true, cancelable: true });
  fireEvent(screen.getByTestId('canvas-viewport'), event);
  expect(event.defaultPrevented).toBe(false);
  expect(screen.getByTestId('canvas-plane').style.transform).toBe('translate(0px, 0px) scale(1)');
  expect(screen.queryByTestId('wb-input')).toBeNull();
  act(() => vi.advanceTimersByTime(1000));
  unmount();
  expect(save).not.toHaveBeenCalled();
});
it('the host handle inserts one exact pointer at the viewport centre and Undo removes it', () => {
  const editor = createSceneEditor(EMPTY_BOARD, { createId: () => 'new-card' });
  const ref = createRef<BoardCanvasHandle>();
  render(<BoardCanvas ref={ref} source={editor} name="One" cameraKey="insert" />);
  vi.spyOn(screen.getByTestId('canvas-viewport'), 'getBoundingClientRect').mockReturnValue({
    x: 20,
    y: 40,
    left: 20,
    top: 40,
    right: 820,
    bottom: 640,
    width: 800,
    height: 600,
    toJSON: () => ({}),
  });
  expect(ref.current?.viewportCentre()).toEqual({ x: 400, y: 300 });
  act(() => {
    expect(
      ref.current?.insertCard({ kind: 'file', file: 'gone/page.md', subpath: '#Raw heading' }),
    ).toBe(true);
  });
  expect(editor.board.nodes.get('new-card')).toMatchObject({
    type: 'file',
    file: 'gone/page.md',
    subpath: '#Raw heading',
    x: 240,
    y: 240,
    width: 320,
    height: 120,
  });
  act(() => editor.undo());
  expect(editor.board.nodes.size).toBe(0);
  expect(editor.canUndo()).toBe(false);
});
