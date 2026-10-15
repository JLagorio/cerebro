import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createBoard } from '@/engine/scene/board';
import { createSceneEditor } from '@/engine/scene/editor';
import { readCanvas, writeCanvas } from '@/engine/scene/jsonCanvas';
import { useUiStore } from '@/stores/uiStore';
import { createBoardState } from './boardState';
import { textEditing, type BoardEditing } from './gestures/text';
import { settleBoardText } from './pendingText';
import { TextEditor } from './TextEditor';
vi.mock('@/mermaid/CanvasViewport', () => ({
  useCanvasTransform: () => ({ scale: 2, offset: { x: 30, y: 50 } }),
}));
const seed = () => {
  const parsed = readCanvas(
    JSON.stringify({
      nodes: [
        {
          id: 'a',
          type: 'text',
          text: 'Original',
          x: 10,
          y: 20,
          width: 200,
          height: 80,
          vendor: { kept: true },
        },
        { id: 'g', type: 'group', label: 'Group', x: 0, y: 0, width: 400, height: 200 },
      ],
      edges: [],
    }),
  );
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.board;
};
function setup(kind: 'draft' | 'node' | 'group' = 'node', strict = false) {
  const editor = createSceneEditor(seed(), { createId: () => 'new' });
  const state = createBoardState(editor);
  const stop = state.connect();
  const editing: BoardEditing =
    kind === 'draft'
      ? {
          kind: 'draft',
          id: 'draft',
          card: {
            type: 'text',
            shape: 'rectangle',
            text: '',
            x: 10,
            y: 20,
            width: 250,
            height: 60,
          },
        }
      : textEditing(editor.board, kind === 'group' ? 'g' : 'a')!;
  state.setState({ editing });
  const execute = vi.spyOn(editor, 'execute'),
    focus = vi.fn();
  const content = <TextEditor editor={editor} state={state} editing={editing} focus={focus} />;
  const rendered = render(strict ? <StrictMode>{content}</StrictMode> : content);
  return {
    ...rendered,
    editor,
    state,
    execute,
    focus,
    stop,
    input: screen.getByTestId('wb-text-editor') as HTMLTextAreaElement,
  };
}
afterEach(async () => {
  cleanup();
  await act(async () => {
    await Promise.resolve();
  });
  vi.restoreAllMocks();
});
it('places the raw editor under the camera transform and commits verbatim once', () => {
  const { input, editor, execute } = setup();
  expect(input.style.left).toBe('50px');
  expect(input.style.top).toBe('90px');
  expect(input.style.width).toBe('400px');
  const text = '# Plan\n- first\n- second\n';
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
  fireEvent.pointerDown(document.body);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(JSON.parse(writeCanvas(editor.board)).nodes[0]).toMatchObject({
    text,
    vendor: { kept: true },
  });
  act(() => {
    expect(editor.undo()?.label).toBeTruthy();
  });
  expect(editor.board.nodes.get('a')).toMatchObject({ text: 'Original' });
  expect(editor.canUndo()).toBe(false);
});
it('an unchanged card and an empty draft create no history', async () => {
  const first = setup();
  fireEvent.keyDown(first.input, { key: 'Escape' });
  expect(first.editor.canUndo()).toBe(false);
  first.unmount();
  await act(async () => {
    await Promise.resolve();
  });
  const draft = setup('draft');
  fireEvent.change(draft.input, { target: { value: '  \n ' } });
  fireEvent.keyDown(draft.input, { key: 'Escape' });
  expect(draft.editor.board.nodes.size).toBe(2);
  expect(draft.execute).not.toHaveBeenCalled();
});
it('a non-empty draft inserts once and a cleared existing card stays', async () => {
  const draft = setup('draft');
  fireEvent.change(draft.input, { target: { value: ' New\n' } });
  fireEvent.keyDown(draft.input, { key: 'Escape' });
  expect(draft.editor.board.nodes.get('new')).toMatchObject({ text: ' New\n' });
  expect(draft.execute).toHaveBeenCalledTimes(1);
  draft.unmount();
  await act(async () => {
    await Promise.resolve();
  });
  const existing = setup();
  fireEvent.change(existing.input, { target: { value: '' } });
  fireEvent.pointerDown(document.body);
  expect(JSON.parse(writeCanvas(existing.editor.board)).nodes[0]).toMatchObject({
    text: '',
    vendor: { kept: true },
  });
});
it('the one-line label variant removes an empty group label', () => {
  const { input, editor } = setup('group');
  expect(input.tagName).toBe('INPUT');
  expect(input.getAttribute('aria-label')).toBe('Group label');
  fireEvent.change(input, { target: { value: '' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(editor.board.nodes.get('g')).not.toHaveProperty('label');
  act(() => {
    expect(editor.undo()).not.toBeNull();
  });
  expect(editor.board.nodes.get('g')).toHaveProperty('label', 'Group');
});
it('IME composition never ends an edit', () => {
  const { input, execute } = setup();
  fireEvent.change(input, { target: { value: '日本語' } });
  fireEvent.keyDown(input, { key: 'Enter', metaKey: true, isComposing: true });
  fireEvent.keyDown(input, { key: 'Process' });
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
  expect(execute).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(execute).toHaveBeenCalledTimes(1);
});
it('an external removal closes the draft and never resurrects the card', () => {
  const toast = vi.spyOn(useUiStore.getState(), 'toast');
  const { editor, input, state, execute } = setup();
  fireEvent.change(input, { target: { value: 'unsaved' } });
  act(() => editor.applyExternal(createBoard({ nodes: [], edges: [] }), 'Outside'));
  expect(state.getState().editing).toBeNull();
  expect(toast).toHaveBeenCalledWith(
    'This card was removed outside the whiteboard. Its text edit was closed.',
  );
  act(() => settleBoardText(editor));
  expect(execute).not.toHaveBeenCalled();
  expect(editor.board.nodes.size).toBe(0);
});
it('StrictMode replay keeps a draft open; Save settles it exactly once', async () => {
  const { editor, input, state, execute } = setup('draft', true);
  await act(async () => {
    await Promise.resolve();
  });
  expect(state.getState().editing).not.toBeNull();
  fireEvent.change(input, { target: { value: 'saved while typing' } });
  act(() => {
    settleBoardText(editor);
    settleBoardText(editor);
  });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(editor.board.nodes.get('new')).toMatchObject({ text: 'saved while typing' });
});
it('real unmount settles the latest draft once', async () => {
  const { input, editor, unmount, execute } = setup('draft', true);
  fireEvent.change(input, { target: { value: 'last keystroke' } });
  unmount();
  await act(async () => {
    await Promise.resolve();
  });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(editor.board.nodes.get('new')).toMatchObject({ text: 'last keystroke' });
});
