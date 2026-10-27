// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { BlockNoteEditor } from '@blocknote/core';
import { cerebroSchema, type CerebroEditor } from './MarkdownEditor';
import { markdownToBlocksNow } from './markdown';
import { mapSourceRange } from './sourceReveal';
import { sourceUtf8Length } from '@/engine/sourceLocation';
function setup(body: string) {
  const editor = BlockNoteEditor.create({ schema: cerebroSchema }) as CerebroEditor;
  editor.replaceBlocks(editor.document, markdownToBlocksNow(editor, body));
  return editor;
}
function range(body: string, quote: string, at = body.indexOf(quote)) {
  const start = sourceUtf8Length(body.slice(0, at));
  return { start, end: start + sourceUtf8Length(quote) };
}
describe('raw backlink occurrence selection', () => {
  it('backlink_opens_the_recorded_occurrence rather than the first repeated chip', () => {
    const body = 'Before [[target|same]] and [[target|same]] after.';
    const editor = setup(body);
    const first = mapSourceRange(body, range(body, '[[target|same]]'), editor);
    const second = mapSourceRange(
      body,
      range(body, '[[target|same]]', body.lastIndexOf('[[target|same]]')),
      editor,
    );
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.from).toBeGreaterThan(first!.to);
    expect(second!.to - second!.from).toBe(1);
    expect(editor.prosemirrorState.doc.nodeAt(second!.from)?.type.name).toBe('wikilink');
    expect(editor.prosemirrorState.doc.nodeAt(second!.from)?.attrs).toMatchObject({
      target: 'target',
      alias: 'same',
    });
  });
  it('maps a Unicode raw link and keeps a projected H1 before it', () => {
    const body = '# Café 😀\n\n😀 [[Target#Notes|café]] here.';
    const editor = setup(body);
    const mapped = mapSourceRange(body, range(body, '[[Target#Notes|café]]'), editor);
    expect(mapped).not.toBeNull();
    expect(editor.prosemirrorState.doc.nodeAt(mapped!.from)?.attrs).toMatchObject({
      target: 'Target#Notes',
      alias: 'café',
    });
  });
  it('maps unlinked text after a chip through actual PM positions', () => {
    const body = 'Before [[target|linked]] and Mention after.';
    const editor = setup(body);
    const mapped = mapSourceRange(body, range(body, 'Mention'), editor);
    expect(mapped).not.toBeNull();
    expect(editor.prosemirrorState.doc.textBetween(mapped!.from, mapped!.to)).toBe('Mention');
  });
  it('validates trimmed target and alias props against the installed loader', () => {
    const body = 'Before [[ target#Notes | alias ]] after.';
    const editor = setup(body);
    const mapped = mapSourceRange(body, range(body, '[[ target#Notes | alias ]]'), editor);
    expect(mapped).not.toBeNull();
    expect(editor.prosemirrorState.doc.nodeAt(mapped!.from)?.attrs).toMatchObject({
      target: 'target#Notes',
      alias: 'alias',
    });
  });
  it('refuses a changed chip even when displayed plain words still match', () => {
    const body = 'Before [[target|same]] after.';
    expect(
      mapSourceRange(body, range(body, '[[target|same]]'), setup(body.replace('target', 'other'))),
    ).toBeNull();
  });
  it('refuses partial chip markup and standalone page-card carriers', () => {
    const body = 'Before [[target|alias]] after.';
    expect(mapSourceRange(body, range(body, 'target'), setup(body))).toBeNull();
    const standalone = '[[target|alias]]';
    expect(mapSourceRange(standalone, range(standalone, standalone), setup(standalone))).toBeNull();
  });
});
