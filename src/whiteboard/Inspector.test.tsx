import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createBoard } from '@/engine/scene/board';
import { createSceneEditor } from '@/engine/scene/editor';
import { claimsKey, claimsOf } from '@/lib/keys/claims';
import { chooseOption, optionLabels } from '@/test/chooseOption';
import { Inspector } from './Inspector';
import { createBoardState } from './boardState';
import { pendingBoardDrafts, settleBoardText } from './pendingText';
if (typeof window.PointerEvent === 'undefined')
  window.PointerEvent = MouseEvent as unknown as typeof window.PointerEvent;
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});
function setup() {
  const board = createBoard({
    nodes: [
      { id: 'a', type: 'text', shape: 'rectangle', text: 'A', x: 0, y: 0, width: 100, height: 60 },
      {
        id: 'b',
        type: 'text',
        shape: 'rectangle',
        text: 'B',
        x: 210,
        y: 80,
        width: 120,
        height: 80,
      },
      {
        id: 'c',
        type: 'text',
        shape: 'rectangle',
        text: 'C',
        x: 400,
        y: 180,
        width: 80,
        height: 60,
      },
    ],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
  });
  const editor = createSceneEditor(board, { createId: () => 'new' }),
    state = createBoardState(editor);
  state.connect();
  render(<Inspector editor={editor} state={state} />);
  return {
    editor,
    board,
    state,
    select: (
      ...keys: Parameters<typeof editor.select>[0] extends Iterable<infer K> ? K[] : never
    ) => act(() => state.getState().select(keys)),
  };
}
it('sections follow selection, mixed values stay words, and one position edit is one step', () => {
  const { editor, select } = setup();
  expect(screen.getByText('Nothing selected')).toBeTruthy();
  select('n:a', 'n:b');
  const x = screen.getByRole('textbox', { name: 'X' });
  expect(x).toHaveProperty('placeholder', 'Mixed');
  expect(x).toHaveProperty('value', '');
  fireEvent.blur(x);
  expect(editor.canUndo()).toBe(false);
  fireEvent.change(x, { target: { value: '25' } });
  fireEvent.keyDown(x, { key: 'Enter' });
  fireEvent.blur(x);
  expect(editor.board.nodes.get('a')?.x).toBe(25);
  expect(editor.board.nodes.get('b')?.x).toBe(25);
  act(() => editor.undo());
  expect(editor.board.nodes.get('b')?.x).toBe(210);
  expect(editor.canUndo()).toBe(false);
  select('e:e');
  expect(screen.getByRole('textbox', { name: 'X' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Start' }).getAttribute('data-value')).toBe('none');
  expect(screen.getByRole('button', { name: 'End' }).getAttribute('data-value')).toBe('arrow');
});
it('a shape is the design system select: a pick is one step, and mixed is its placeholder', () => {
  const { editor, select } = setup();
  select('n:a');
  const shape = screen.getByRole('button', { name: 'Shape' });
  expect(shape.getAttribute('data-value')).toBe('rectangle');
  chooseOption(shape, 'Ellipse');
  expect(editor.board.nodes.get('a')).toMatchObject({ shape: 'ellipse' });
  expect(editor.board.nodes.get('b')).toMatchObject({ shape: 'rectangle' });
  select('n:a', 'n:b');
  const mixed = screen.getByRole('button', { name: 'Shape' });
  // Mixed is a state, not a choice: the trigger says it, the list never does.
  expect(mixed.getAttribute('data-value')).toBe('');
  expect(mixed.textContent).toBe('Mixed');
  expect(optionLabels(mixed)).toEqual(['Rectangle', 'Ellipse', 'Diamond']);
  act(() => editor.undo());
  expect(editor.board.nodes.get('a')).toMatchObject({ shape: 'rectangle' });
  expect(editor.canUndo()).toBe(false);
});
it("the board's bare keys stand down on a select, as they did on a native one", () => {
  const { select } = setup();
  select('e:e');
  for (const name of ['Start', 'End']) {
    const claims = claimsOf(screen.getByRole('button', { name }));
    for (const key of ['ArrowDown', 'Enter', ' ', 'Backspace', 'r'])
      expect(
        claimsKey(claims, { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }),
      ).toBe(true);
    // Undo still reaches the board.
    expect(
      claimsKey(claims, {
        key: 'z',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe(false);
  }
});
it('a colour is one durable edit and becomes the next-card session default; None removes it', () => {
  const { editor, select, state } = setup();
  select('n:a', 'n:b');
  fireEvent.click(screen.getByRole('button', { name: 'Green' }));
  expect(editor.board.nodes.get('a')?.color).toBe('4');
  expect(state.getState().colors.card).toBe('4');
  const hex = screen.getByRole('textbox', { name: 'Hex colour' });
  fireEvent.change(hex, { target: { value: '#ABC' } });
  fireEvent.keyDown(hex, { key: 'Enter' });
  fireEvent.blur(hex);
  expect(editor.board.nodes.get('b')?.color).toBe('#aabbcc');
  act(() => editor.undo());
  expect(editor.board.nodes.get('b')?.color).toBe('4');
  fireEvent.click(screen.getByRole('button', { name: 'None' }));
  expect(editor.board.nodes.get('a')).not.toHaveProperty('color');
  act(() => editor.undo());
  expect(editor.board.nodes.get('a')?.color).toBe('4');
});
it('align and distribute each record one complete layout', () => {
  const { editor, select, board } = setup();
  select('n:a', 'n:b', 'n:c');
  fireEvent.click(screen.getByRole('button', { name: 'Align left' }));
  expect([...editor.board.nodes.values()].map((n) => n.x)).toEqual([0, 0, 0]);
  act(() => editor.undo());
  expect(editor.board.nodes).toEqual(board.nodes);
  fireEvent.click(screen.getByRole('button', { name: 'Distribute horizontal' }));
  expect([...editor.board.nodes.values()].map((n) => n.x)).toEqual([0, 190, 400]);
  act(() => editor.undo());
  expect(editor.canUndo()).toBe(false);
});
it('scrubbing previews relative to the start and commits once; Escape and outside apply retire it', () => {
  const { editor, select } = setup();
  select('n:a');
  const commit = vi.spyOn(editor, 'commit');
  const label = screen.getByRole('button', { name: 'Adjust X' });
  fireEvent.pointerDown(label, { button: 0, clientX: 10 });
  fireEvent.pointerMove(window, { clientX: 20 });
  fireEvent.pointerMove(window, { clientX: 50 });
  expect(editor.board.nodes.get('a')?.x).toBe(0);
  fireEvent.pointerUp(window);
  expect(editor.board.nodes.get('a')?.x).toBe(40);
  expect(commit).toHaveBeenCalledOnce();
  fireEvent.pointerDown(label, { button: 0, clientX: 10 });
  fireEvent.pointerMove(window, { clientX: 30 });
  fireEvent.keyDown(window, { key: 'Escape' });
  fireEvent.pointerUp(window);
  expect(editor.board.nodes.get('a')?.x).toBe(40);
  expect(commit).toHaveBeenCalledOnce();
  fireEvent.pointerDown(label, { button: 0, clientX: 10 });
  fireEvent.pointerMove(window, { clientX: 30 });
  act(() => editor.applyExternal(createBoard(), 'Outside'));
  fireEvent.pointerMove(window, { clientX: 100 });
  fireEvent.pointerUp(window);
  expect(editor.board.nodes.size).toBe(0);
  expect(commit).toHaveBeenCalledOnce();
});
it('uncommitted fields do not spill into a newly selected record and storage failure is harmless', () => {
  const { editor, select } = setup();
  select('n:a');
  fireEvent.change(screen.getByRole('textbox', { name: 'X' }), { target: { value: '900' } });
  select('n:c');
  fireEvent.blur(screen.getByRole('textbox', { name: 'X' }));
  expect(editor.board.nodes.get('c')?.x).toBe(400);
  expect(editor.canUndo()).toBe(false);
  const broken = createBoardState(editor, {
    getItem() {
      throw new Error('disabled');
    },
    setItem() {
      throw new Error('disabled');
    },
  });
  expect(broken.getState().inspectorOpen).toBe(true);
  expect(() => broken.getState().setInspectorOpen(false)).not.toThrow();
});

it('prepares a retained field against its original target without overwriting newer geometry', () => {
  const { editor, select } = setup();
  select('n:a');
  fireEvent.change(screen.getByRole('textbox', { name: 'X' }), { target: { value: '900' } });
  select('n:c');
  const a = editor.board.nodes.get('a')!;
  act(() =>
    editor.applyExternal(
      { ...editor.board, nodes: new Map(editor.board.nodes).set('a', { ...a, y: 123 }) },
      'Outside',
    ),
  );
  act(() => {
    expect(settleBoardText(editor)).toBe(true);
  });
  expect(editor.board.nodes.get('a')).toMatchObject({ x: 900, y: 123 });
  expect(editor.board.nodes.get('c')?.x).toBe(400);
  expect(pendingBoardDrafts(editor)).toEqual([]);
});
it('does not drop a pending colour when its original target disappears', () => {
  const { editor, select } = setup();
  select('n:a');
  fireEvent.change(screen.getByRole('textbox', { name: 'Hex colour' }), {
    target: { value: '#abc' },
  });
  select('n:c');
  const nodes = new Map(editor.board.nodes);
  nodes.delete('a');
  act(() => editor.applyExternal({ ...editor.board, nodes, edges: new Map() }, 'Outside'));
  act(() => {
    expect(settleBoardText(editor)).toBe(false);
  });
  expect(pendingBoardDrafts(editor)).toEqual([{ id: expect.any(String), text: '#abc' }]);
  expect(editor.board.nodes.get('c')).not.toHaveProperty('color');
});
