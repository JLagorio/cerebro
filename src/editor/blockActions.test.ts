// @vitest-environment jsdom
import { BlockNoteEditor } from '@blocknote/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cerebroSchema, type CerebroEditor } from './MarkdownEditor';
import { blocksToMarkdownNow, markdownToBlocksNow } from './markdown';
import { canConvertBlock, duplicateBlock, duplicationProblem, moveBlock } from './blockActions';
import type { AnyBlock } from './reconcile';
import { act } from '@testing-library/react';
import { NodeSelection, Selection, TextSelection } from 'prosemirror-state';

let editor: CerebroEditor;
beforeEach(() => {
  editor = BlockNoteEditor.create({ schema: cerebroSchema }) as CerebroEditor;
  const host = document.createElement('div');
  document.body.append(host);
  act(() => editor.mount(host));
});
afterEach(() => {
  act(() => editor.unmount());
  document.body.replaceChildren();
});

const ids = (blocks: readonly AnyBlock[]): string[] =>
  blocks.flatMap((block) => [block.id!, ...ids(block.children ?? [])]);
const load = (body: string) =>
  editor.replaceBlocks(editor.document, markdownToBlocksNow(editor, body));

describe('carried block actions', () => {
  it('duplicates nested content with fresh identifiers, preserves marks and reopens faithfully', () => {
    load('* **Parent**\n\n  * Nested [[kickoff]]\n\nTail.\n');
    const original = editor.document[0];
    duplicateBlock(editor, original.id);
    const all = ids(editor.document);
    expect(new Set(all).size).toBe(all.length);
    const saved = blocksToMarkdownNow(editor);
    expect(saved.match(/\*\*Parent\*\*/g)).toHaveLength(2);
    expect(saved.match(/Nested \[\[kickoff\]\]/g)).toHaveLength(2);
    load(saved);
    expect(blocksToMarkdownNow(editor)).toBe(saved);
  });

  it('moves a subtree as one undo step without consuming the preceding edit', () => {
    load('First.\n\n* Parent\n\n  * Child\n\nLast.\n');
    const id = editor.document[1].id;
    editor.updateBlock(editor.document[0], { content: 'First, edited.' });
    editor.setTextCursorPosition(id, 'start');
    editor.transact((tr) => tr.setSelection(TextSelection.create(tr.doc, tr.selection.from + 2)));
    const before = blocksToMarkdownNow(editor);
    moveBlock(editor, id, 1);
    expect(editor.getTextCursorPosition().block.id).toBe(id);
    expect(editor.prosemirrorState.selection.$from.parentOffset).toBe(2);
    expect(blocksToMarkdownNow(editor).indexOf('Last.')).toBeLessThan(
      blocksToMarkdownNow(editor).indexOf('Parent'),
    );
    editor.undo();
    expect(blocksToMarkdownNow(editor)).toBe(before);
    expect(editor.document[1].id).toBe(id);
  });

  it('does not offer a duplicate with a colliding sheet name, including nested sheets', () => {
    load('```cerebro-sheet\n---\nformat: 1\nname: Budget\n---\nA,2\n```\n');
    const sheet = editor.document[0];
    expect(duplicationProblem(sheet)).toMatch(/unique workbook name/);
    expect(duplicationProblem({ type: 'column', children: [sheet] })).toMatch(
      /unique workbook name/,
    );
    const before = blocksToMarkdownNow(editor);
    duplicateBlock(editor, sheet.id);
    expect(blocksToMarkdownNow(editor)).toBe(before);
    expect(canConvertBlock(sheet)).toBe(false);
  });

  for (const [kind, carrier] of [
    ['image', '![Caption](attachments/image.png)'],
    ['database', '```cerebro-database\ndatabase: Work item\nview: all\n```'],
    ['sheet', '```cerebro-sheet\n---\nformat: 1\nname: Budget\n---\nA,2\n```'],
  ]) {
    it(`retains the selected ${kind} block as a NodeSelection when moving and undoing`, () => {
      load(`First.\n\n${carrier}\n\nLast.\n`);
      const block = editor.document[1];
      editor.updateBlock(editor.document[0], { content: 'First, edited.' });
      editor.setTextCursorPosition(block.id, 'start');
      expect(editor.prosemirrorState.selection).toBeInstanceOf(NodeSelection);
      const before = blocksToMarkdownNow(editor);
      moveBlock(editor, block.id, 1);
      expect(editor.prosemirrorState.selection).toBeInstanceOf(NodeSelection);
      expect(editor.getTextCursorPosition().block.id).toBe(block.id);
      editor.undo();
      expect(blocksToMarkdownNow(editor)).toBe(before);
      expect(editor.prosemirrorState.selection).toBeInstanceOf(NodeSelection);
      expect(editor.getTextCursorPosition().block.id).toBe(block.id);
    });
  }

  it('retains a whole-block NodeSelection anchored before its container through move and undo', () => {
    load('First.\n\n![Caption](attachments/image.png)\n\nLast.\n');
    const block = editor.document[1];
    editor.updateBlock(editor.document[0], { content: 'First, edited.' });
    editor.transact((tr) => {
      tr.doc.descendants((node, position) => {
        if (node.attrs.id === block.id) {
          tr.setSelection(NodeSelection.create(tr.doc, position));
          return false;
        }
      });
    });
    expect((editor.prosemirrorState.selection as NodeSelection).node.attrs.id).toBe(block.id);
    const before = blocksToMarkdownNow(editor);
    moveBlock(editor, block.id, 1);
    expect(editor.prosemirrorState.selection).toBeInstanceOf(NodeSelection);
    expect((editor.prosemirrorState.selection as NodeSelection).node.attrs.id).toBe(block.id);
    editor.undo();
    expect(blocksToMarkdownNow(editor)).toBe(before);
    expect(editor.prosemirrorState.selection).toBeInstanceOf(NodeSelection);
    expect((editor.prosemirrorState.selection as NodeSelection).node.attrs.id).toBe(block.id);
  });

  it('preserves a rectangular CellSelection and its selected cells through table move and undo', () => {
    load('First.\n\n| A | B |\n| --- | --- |\n| C | D |\n\nLast.\n');
    const table = editor.document[1];
    editor.updateBlock(editor.document[0], { content: 'First, edited.' });
    const positions: number[] = [];
    editor.transact((tr) => {
      tr.doc.descendants((node, position) => {
        if (node.type.spec.tableRole === 'cell' || node.type.spec.tableRole === 'header_cell')
          positions.push(position);
      });
      tr.setSelection(
        Selection.fromJSON(tr.doc, { type: 'cell', anchor: positions[0], head: positions.at(-1) }),
      );
    });
    const selected = editor.prosemirrorState.selection;
    expect(selected.constructor.name).toBe('CellSelection');
    const before = blocksToMarkdownNow(editor);
    const selectionBefore = selected.toJSON();
    const selectedText = selected
      .content()
      .content.textBetween(0, selected.content().content.size, '\n');
    moveBlock(editor, table.id, 1);
    const moved = editor.prosemirrorState.selection;
    expect(moved.constructor.name).toBe('CellSelection');
    expect(moved.content().content.textBetween(0, moved.content().content.size, '\n')).toBe(
      selectedText,
    );
    expect(moved.toJSON()).not.toEqual(selectionBefore);
    editor.undo();
    expect(blocksToMarkdownNow(editor)).toBe(before);
    expect(editor.prosemirrorState.selection.toJSON()).toEqual(selectionBefore);
  });
});
