import { beforeEach, expect, it, vi } from 'vitest';
import { createBoard } from '@/engine/scene/board';
import { createSceneEditor } from '@/engine/scene/editor';
import { updateCards } from '@/engine/scene/commands';
import { BOARD_CLIPBOARD_TYPE } from '@/engine/scene/fragments';
import { createBoardClipboard, resetBoardClipboard } from './clipboard';
function setup() {
  const board = createBoard({
    nodes: [
      {
        id: 'a',
        type: 'text',
        shape: 'rectangle',
        text: '# First',
        x: 0,
        y: 0,
        width: 100,
        height: 60,
      },
      {
        id: 'b',
        type: 'text',
        shape: 'rectangle',
        text: 'Second',
        x: 200,
        y: 0,
        width: 100,
        height: 60,
      },
    ],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
  });
  let id = 0;
  const editor = createSceneEditor(board, { createId: () => `new${++id}` }),
    toast = vi.fn();
  return {
    editor,
    board,
    toast,
    clipboard: createBoardClipboard(editor, () => ({ x: 500, y: 300 }), toast),
  };
}
const event = (
  values: Record<string, string> = {},
  target: EventTarget | null = null,
  files: File[] = [],
) => {
  const data = new Map(Object.entries(values));
  return {
    clipboardData: {
      getData: (key: string) => data.get(key) ?? '',
      setData: (key: string, value: string) => {
        data.set(key, value);
      },
      types: Object.keys(values),
      files: files as unknown as FileList,
    },
    target,
    preventDefault: vi.fn(),
    data,
  };
};
beforeEach(resetBoardClipboard);
it('copy carries both types; paste remaps the internal edge and offsets repetitions by24 then48', () => {
  const { editor, clipboard } = setup();
  editor.select(['n:a', 'n:b']);
  const copied = event();
  clipboard.copy(copied);
  expect(copied.data.get('text/plain')).toBe('# First\n\nSecond');
  expect(copied.data.has(BOARD_CLIPBOARD_TYPE)).toBe(true);
  clipboard.paste(copied);
  expect(editor.board.nodes.get('new1')?.x).toBe(24);
  expect(editor.board.edges.get('new3')).toMatchObject({ fromNode: 'new1', toNode: 'new2' });
  clipboard.paste(copied);
  expect(editor.board.nodes.get('new4')?.x).toBe(48);
  expect(editor.undo()).not.toBeNull();
  expect(editor.board.nodes.size).toBe(4);
});
it('matching plain text restores the custom fragment across boards and cut is one undo', () => {
  const { editor, clipboard } = setup();
  editor.select(['n:a', 'n:b']);
  const copied = event();
  clipboard.cut(copied);
  expect(editor.board.nodes.size).toBe(0);
  expect(editor.board.edges.size).toBe(0);
  editor.undo();
  expect(editor.board.nodes.size).toBe(2);
  expect(editor.canUndo()).toBe(false);
  const other = setup();
  other.clipboard.paste(event({ 'text/plain': copied.data.get('text/plain')! }));
  expect(other.editor.board.edges.size).toBe(2);
});
it('plain text creates one centered card; malformed fragments and images paste nothing', () => {
  const { editor, clipboard, toast } = setup();
  clipboard.paste(event({ 'text/plain': 'one\ntwo' }));
  expect(editor.board.nodes.get('new1')).toMatchObject({
    x: 375,
    y: 268,
    width: 250,
    height: 64,
    text: 'one\ntwo',
  });
  const before = editor.board;
  clipboard.paste(
    event({ [BOARD_CLIPBOARD_TYPE]: '{broken', 'text/plain': 'fallback must not land' }),
  );
  clipboard.paste(event({}, null, [new File(['png'], 'image.png', { type: 'image/png' })]));
  expect(editor.board).toBe(before);
  expect(toast).toHaveBeenCalledTimes(2);
});
it('input/editor events and a failed clipboard write cannot cut selected items', () => {
  const { editor, clipboard, board } = setup();
  editor.select(['n:a']);
  const input = document.createElement('textarea'),
    typed = event({ 'text/plain': 'typed' }, input);
  clipboard.copy(typed);
  clipboard.cut(typed);
  clipboard.paste(typed);
  expect(typed.preventDefault).not.toHaveBeenCalled();
  expect(editor.board).toBe(board);
  const failed = event();
  failed.clipboardData.setData = () => {
    throw new Error('unavailable');
  };
  clipboard.cut(failed);
  expect(editor.board).toBe(board);
});
it('an image clipboard cannot accidentally paste a prior empty-text shape fallback', () => {
  const { editor, clipboard, toast } = setup();
  editor.execute(updateCards, { updates: [{ id: 'a', set: { text: '' } }] });
  editor.select(['n:a']);
  const copied = event();
  clipboard.copy(copied);
  clipboard.paste(event({ 'image/png': '' }));
  expect(editor.board.nodes.size).toBe(2);
  expect(toast).toHaveBeenCalledWith('Image paste is not available here.');
});
