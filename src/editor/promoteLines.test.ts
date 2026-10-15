// @vitest-environment jsdom
import { BlockNoteEditor } from '@blocknote/core';
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { undoDepth } from 'prosemirror-history';
import { makeEntry } from '@/test/factories';
import { cerebroSchema, type CerebroEditor } from './MarkdownEditor';
import { blocksToMarkdownNow, markdownToBlocksNow } from './markdown';
import { linkPromotedLines, promotable, readChecklistLine } from './promoteLines';

let editor: CerebroEditor;
beforeEach(() => {
  editor = BlockNoteEditor.create({ schema: cerebroSchema }) as CerebroEditor;
});
afterEach(() => {
  act(() => editor.unmount());
  document.body.replaceChildren();
});
const load = (text: string) => {
  editor.replaceBlocks(editor.document, markdownToBlocksNow(editor, text));
  return editor.document;
};

describe('checklist line snapshots', () => {
  it('reads title labels, first date, extra dates, deduped people and plain-text chip carriers', () => {
    const entries = [makeEntry({ path: 'docs/guide.md', title: 'Deployment guide' })];
    const blocks = load(
      '- [x] Ship [[guide]] and [[guide|the handbook]] 📅 2026-10-20 @[[maya]] @[[maya]] 📅 2026-10-21 [^proof]\n',
    );
    const line = readChecklistLine(blocks[0], entries)!;
    expect(line).toMatchObject({
      checked: true,
      title: 'Ship Deployment guide and the handbook',
      due: { start: '2026-10-20' },
      extraDates: [{ start: '2026-10-21' }],
      people: ['maya'],
      flattened: true,
      onlyLink: false,
    });
    expect(line.text).toContain('[[guide|the handbook]]');
    expect(line.text).toContain('@[[maya]]');
    expect(line.text).toContain('[^proof]');
  });

  it('reads hyperlink text and flags formatting flattened into the title', () => {
    const blocks = load('- [ ] **Ship** [the docs](https://example.com)\n');
    const line = readChecklistLine(blocks[0], [])!;
    expect(line.title).toBe('Ship the docs');
    expect(line.flattened).toBe(true);
    expect(line.text).toContain('[the docs](https://example.com)');
  });

  it('selects checklist blocks once, including children, and detects empty and link-only lines', () => {
    load('- [ ] Parent\n  - [ ] [[existing]]\n- [ ] Temporary\n\nParagraph\n');
    editor.updateBlock(editor.document[1], { content: [] });
    const blocks = editor.document;
    const lines = promotable(blocks, []);
    expect(lines).toHaveLength(3);
    expect(lines[1].onlyLink).toBe(true);
    expect(lines[2].title).toBe('');
    expect(readChecklistLine(blocks.at(-1)!, [])).toBeNull();
  });

  it('rewrites ready lines in one transaction and Undo restores both, with children intact', () => {
    const host = document.createElement('div');
    document.body.append(host);
    act(() => editor.mount(host));
    let blocks!: ReturnType<typeof load>;
    act(() => {
      blocks = load('- [ ] First\n  - Child stays here\n- [ ] Second\n');
    });
    const lines = promotable(blocks, []);
    const before = blocksToMarkdownNow(editor);
    const children = blocks[0].children;
    const depth = undoDepth(editor.prosemirrorState);
    let linked!: Set<string>;
    act(() => {
      linked = linkPromotedLines(
        editor,
        lines.map((line, i) => ({ line, path: `records/work-items/new-${i}.md` })),
      );
    });
    expect(linked).toEqual(new Set(lines.map((line) => line.blockId)));
    expect(undoDepth(editor.prosemirrorState)).toBe(depth + 1);
    expect(editor.getBlock(lines[0].blockId)?.children).toEqual(children);
    expect(blocksToMarkdownNow(editor)).toContain('* [[new-0]]');
    act(() => {
      expect(editor.undo()).toBe(true);
    });
    expect(blocksToMarkdownNow(editor)).toBe(before);
  });

  it('never overwrites a changed or removed checklist line', () => {
    const lines = promotable(load('- [ ] First\n- [ ] Second\n'), []);
    editor.updateBlock(lines[0].blockId, { content: 'Newer wording' });
    editor.removeBlocks([lines[1].blockId]);
    const before = blocksToMarkdownNow(editor);
    expect(
      linkPromotedLines(
        editor,
        lines.map((line) => ({ line, path: 'new.md' })),
      ),
    ).toEqual(new Set());
    expect(blocksToMarkdownNow(editor)).toBe(before);
  });
});
