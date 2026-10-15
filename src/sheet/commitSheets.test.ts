import { BlockNoteEditor } from '@blocknote/core';
import { undoDepth } from 'prosemirror-history';
import { afterEach, describe, expect, it } from 'vitest';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
import { cerebroSchema, type CerebroEditor } from '@/editor/MarkdownEditor';
import { commitSheetEdits } from './commitSheets';
function setup() {
  const editor = BlockNoteEditor.create({
    schema: cerebroSchema,
    initialContent: [
      { id: 's1', type: 'sheet', props: { source: '1' } },
      { id: 's2', type: 'sheet', props: { source: '=Sheet1!A1' } },
      { id: 'p', type: 'paragraph', content: 'Before' },
    ],
  }) as CerebroEditor;
  const host = document.createElement('div');
  document.body.append(host);
  editor.mount(host);
  cleanups.push(() => {
    editor.unmount();
    host.remove();
  });
  return editor;
}
const source = (editor: CerebroEditor, id = 's1') =>
  (editor.getBlock(id)?.props as { source: string }).source;
describe('sheet commits share page history', () => {
  it('one or two changed fences take one isolated step, then redo', () => {
    const editor = setup();
    const before = undoDepth(editor.prosemirrorState);
    commitSheetEdits(editor, [
      { id: 's1', source: '2' },
      { id: 's2', source: '=Sheet1!A2' },
    ]);
    expect(undoDepth(editor.prosemirrorState)).toBe(before + 1);
    editor.undo();
    expect(source(editor)).toBe('1');
    expect(source(editor, 's2')).toBe('=Sheet1!A1');
    editor.redo();
    expect(source(editor)).toBe('2');
    expect(source(editor, 's2')).toBe('=Sheet1!A2');
  });
  it('unchanged cells add no step and a disappeared target prevents every change', () => {
    const editor = setup();
    const before = undoDepth(editor.prosemirrorState);
    expect(commitSheetEdits(editor, [{ id: 's1', source: '1' }])).toBe(false);
    expect(undoDepth(editor.prosemirrorState)).toBe(before);
    expect(() =>
      commitSheetEdits(editor, [
        { id: 's1', source: '2' },
        { id: 'missing', source: 'x' },
      ]),
    ).toThrow();
    expect(source(editor)).toBe('1');
  });
  it('typing then a sheet commit within the history delay undo separately', () => {
    const editor = setup();
    editor.updateBlock('p', { content: 'Typed' });
    commitSheetEdits(editor, [{ id: 's1', source: '2' }]);
    editor.undo();
    expect(source(editor)).toBe('1');
    expect(JSON.stringify(editor.getBlock('p')?.content)).toContain('Typed');
    editor.undo();
    expect(JSON.stringify(editor.getBlock('p')?.content)).toContain('Before');
  });
  it('a sheet commit then typing within the history delay undo separately', () => {
    const editor = setup();
    commitSheetEdits(editor, [{ id: 's1', source: '2' }]);
    editor.updateBlock('p', { content: 'Typed' });
    editor.undo();
    expect(source(editor)).toBe('2');
    expect(JSON.stringify(editor.getBlock('p')?.content)).toContain('Before');
    editor.undo();
    expect(source(editor)).toBe('1');
  });
});
