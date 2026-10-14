// @vitest-environment jsdom
import { BlockNoteEditor } from '@blocknote/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { anchorAt } from '@/engine/commentAnchor';
import { markdownToBlocksNow } from './markdown';
import { cerebroSchema, type CerebroEditor } from './MarkdownEditor';
import { readerText } from './readerText';

/**
 * Reader text (M70.1), read off a headless editor with the app's schema: the
 * text a comment quotes, and the map between it and the doc's positions.
 */

let editor: CerebroEditor;

beforeEach(() => {
  editor = BlockNoteEditor.create({ schema: cerebroSchema }) as CerebroEditor;
});

function load(md: string) {
  editor.replaceBlocks(editor.document, markdownToBlocksNow(editor, md));
  return readerText(editor.prosemirrorState.doc);
}

const docText = (from: number, to: number) =>
  editor.prosemirrorState.doc.textBetween(from, to, '\n', (leaf) =>
    leaf.type.name === 'hardBreak' ? '\n' : '',
  );

describe('readerText', () => {
  it('joins blocks with a newline', () => {
    const { spans } = load('# Plan\n\nFirst paragraph.\n\n- An item\n');
    expect(spans.text).toBe('Plan\nFirst paragraph.\nAn item');
    expect(spans.blocks).toEqual([
      [0, 4],
      [5, 21],
      [22, 29],
    ]);
  });

  it('leaves a code fence out', () => {
    const { spans } = load('Before.\n\n```ts\nconst x = 1;\n```\n\nAfter.\n');
    expect(spans.text).toBe('Before.\nAfter.');
  });

  it('spells a wikilink chip as written, as one atom', () => {
    const { spans } = load('See [[kickoff]] notes.\n');
    expect(spans.text).toBe('See [[kickoff]] notes.');
    expect(spans.atoms).toEqual([[4, 15]]);
  });

  it('reads table cells and toggle children in document order', () => {
    const { spans } = load(
      '| Who | When |\n| --- | --- |\n| Ana | Monday |\n\n:::toggle Open questions\nWho owns it?\n:::\n\nEnd.\n',
    );
    expect(spans.text).toBe('Who\nWhen\nAna\nMonday\nOpen questions\nWho owns it?\nEnd.');
  });

  it('round-trips posAt: the doc text between two positions is the reader slice', () => {
    const md =
      'Ship **the new** [pricing page](https://example.com) today.\n\nSee [[kickoff]] now.\n';
    const { spans, posAt } = load(md);
    const { text } = spans;
    for (const [s, e] of [
      [0, 4],
      [5, 12],
      [9, 26],
      [text.indexOf('now'), text.indexOf('now') + 3],
    ]) {
      expect(docText(posAt(s, 'start'), posAt(e, 'end'))).toBe(text.slice(s, e));
    }
  });

  it('maps a selection across bold and a link to its reader text', () => {
    const { spans, offsetsOf } = load(
      'Ship **the new** [pricing page](https://example.com) today.\n',
    );
    // "new" starts inside the bold run; "today" ends just before the period.
    const doc = editor.prosemirrorState.doc;
    let from = -1;
    let to = -1;
    doc.descendants((node, pos) => {
      if (!node.isText) return true;
      const t = node.text ?? '';
      if (from < 0 && t.includes('new')) from = pos + t.indexOf('new');
      if (t.includes('today')) to = pos + t.indexOf('today') + 'today'.length;
      return false;
    });
    const range = offsetsOf(from, to);
    expect(range).toMatchObject({ ok: true });
    if (!range.ok) return;
    expect(spans.text.slice(range.start, range.end)).toBe('new pricing page today');
  });

  it('refuses a cross-block selection as an anchor, and a selection in code as outside_text', () => {
    const { spans, offsetsOf } = load('First block.\n\nSecond block.\n\n```\ncode here\n```\n');
    const doc = editor.prosemirrorState.doc;
    const at: Record<string, number> = {};
    doc.descendants((node, pos) => {
      if (node.isText) at[node.text ?? ''] = pos;
      return true;
    });
    const across = offsetsOf(at['First block.'] + 6, at['Second block.'] + 6);
    expect(across.ok).toBe(true);
    if (across.ok) {
      expect(anchorAt(spans, across.start, across.end)).toEqual({
        ok: false,
        reason: 'spans_blocks',
      });
    }
    expect(offsetsOf(at['code here'] + 1, at['code here'] + 4)).toEqual({
      ok: false,
      reason: 'outside_text',
    });
  });

  it('keeps offsets right after an emoji', () => {
    const { spans, posAt, offsetsOf } = load('😀 We ship on Thursdays.\n');
    const s = spans.text.indexOf('Thursdays');
    const e = s + 'Thursdays'.length;
    expect(docText(posAt(s, 'start'), posAt(e, 'end'))).toBe('Thursdays');
    expect(offsetsOf(posAt(s, 'start'), posAt(e, 'end'))).toEqual({ ok: true, start: s, end: e });
  });

  it('lands a chip-splitting offset on the chip edge its side asks for', () => {
    const { posAt } = load('See [[kickoff]] notes.\n');
    expect(posAt(6, 'start')).toBe(posAt(4, 'start'));
    expect(posAt(6, 'end')).toBe(posAt(15, 'end'));
  });
});
