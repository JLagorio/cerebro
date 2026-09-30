// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { citationPasteHandler, insertCitation } from './citationInput';
import { blocksToMarkdown, markdownToBlocks } from './markdown';
import { MarkdownEditor, type CerebroEditor } from './MarkdownEditor';

/**
 * Typing a citation (M52.1). Every case ends on the bytes: a chip made live has
 * to be the chip the next load would read out of the same file, so each one
 * saves, and then reads the saved text back.
 */

async function open(markdown: string): Promise<CerebroEditor> {
  const onReady = vi.fn<(info: { editor: CerebroEditor }) => void>();
  render(<MarkdownEditor markdown={markdown} onChange={vi.fn()} onReady={onReady} />);
  await waitFor(() => expect(onReady).toHaveBeenCalled());
  return onReady.mock.calls[0][0].editor;
}

/** Type as the browser does: each character offered to `handleTextInput` first. */
function type(editor: CerebroEditor, text: string): void {
  const view = editor.prosemirrorView;
  for (const ch of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp('handleTextInput', (f) =>
      f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)),
    );
    if (handled !== true) view.dispatch(view.state.tr.insertText(ch, from, to));
  }
}

/** Put the cursor at the end of the block whose text starts with `starts`. */
function caretAtEnd(editor: CerebroEditor, starts: string): void {
  const block = editor.document.find((b) =>
    JSON.stringify(b.content ?? '').includes(`"text":"${starts}`),
  );
  if (block === undefined) throw new Error(`no block starting "${starts}"`);
  editor.setTextCursorPosition(block, 'end');
}

const citations = (editor: CerebroEditor) =>
  JSON.stringify(editor.document).match(/"type":"citation","props":\{[^}]*\}/g) ?? [];

/** What the file says, and that reading it back gives the same file. */
async function saved(editor: CerebroEditor): Promise<string> {
  const md = await blocksToMarkdown(editor);
  expect(await blocksToMarkdown(editor, await markdownToBlocks(editor, md))).toBe(md);
  return md;
}

/** The chips the next load reads out of `md`. */
const reloaded = async (editor: CerebroEditor, md: string) =>
  JSON.stringify(await markdownToBlocks(editor, md)).match(
    /"type":"citation","props":\{[^}]*\}/g,
  ) ?? [];

/** Press Enter as the keyboard does — through the editor's key handlers. */
function enter(editor: CerebroEditor): void {
  const view = editor.prosemirrorView;
  view.someProp('handleKeyDown', (f) => f(view, new KeyboardEvent('keydown', { key: 'Enter' })));
}

describe('typing a citation', () => {
  // A marker's `[` opens the link menu, which measures where the `[` is: jsdom
  // has no layout, and its rect has no `toJSON` for BlockNote to call.
  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      ...{ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 },
      toJSON: () => ({}),
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('closes a marker into a chip as its ] lands, and saves it as the marker', async () => {
    const editor = await open('A claim.\n');
    caretAtEnd(editor, 'A claim.');
    type(editor, '[^kr-sync] More.');
    expect(citations(editor)).toEqual(['"type":"citation","props":{"id":"kr-sync","def":""}']);
    expect(await saved(editor)).toBe('A claim.[^kr-sync] More.\n');
  });

  it('closes one in a heading and a list item too — only a paragraph line can be a definition', async () => {
    const editor = await open('# Title\n\n* item\n');
    caretAtEnd(editor, 'Title');
    type(editor, ' [^a]');
    caretAtEnd(editor, 'item');
    type(editor, ' [^b]');
    expect(citations(editor)).toHaveLength(2);
    expect(await saved(editor)).toBe('# Title [^a]\n\n* item [^b]\n');
  });

  /* Each of these is read as text by the parser, so each stays text here —
     a chip made now would disagree with the page reopened. */
  it('leaves a marker typed in emphasis, inline code, or a code block as text', async () => {
    const editor = await open('Styled:\n\nCode:\n\n```text\nfenced\n```\n');
    const view = editor.prosemirrorView;
    const typeMarked = (mark: 'italic' | 'bold' | 'code', text: string) => {
      view.dispatch(view.state.tr.addStoredMark(view.state.schema.marks[mark].create()));
      type(editor, text);
    };
    caretAtEnd(editor, 'Styled:');
    type(editor, ' ');
    typeMarked('italic', 'a claim[^styled] more');
    caretAtEnd(editor, 'Code:');
    type(editor, ' ');
    typeMarked('code', '[^code]');
    caretAtEnd(editor, 'fenced');
    type(editor, ' [^fenced]');
    expect(citations(editor)).toEqual([]);
    expect(await saved(editor)).toBe(
      'Styled: *a claim[^styled] more*\n\nCode: `[^code]`\n\n```text\nfenced [^fenced]\n```\n',
    );
  });

  it('does not take the ] of a wikilink being typed', async () => {
    const editor = await open('See\n');
    caretAtEnd(editor, 'See');
    type(editor, ' [[^odd]]');
    expect(citations(editor)).toEqual([]);
  });

  /* `[^id]` opening a paragraph line is a reference unless a `:` follows it,
     so its `]` makes the reference chip at once, and a `:` typed next makes
     that chip the definition (M52.4 — it used to wait for the next character,
     and a line left as `[^a]` stayed text until a reload made it a chip). */
  it('makes a line-opening marker a chip at once, and a : after it a definition', async () => {
    const editor = await open('Body.[^a]\n\nlast\n');
    caretAtEnd(editor, 'last');
    // A new paragraph, empty, so the marker opens its line.
    editor.insertBlocks([{ type: 'paragraph' }], editor.document[1], 'after');
    editor.setTextCursorPosition(editor.document[2], 'start');
    type(editor, '[^a]');
    expect(citations(editor)).toHaveLength(2);
    type(editor, ': The source');
    expect(citations(editor)).toEqual([
      '"type":"citation","props":{"id":"a","def":""}',
      '"type":"citation","props":{"id":"a","def":"1"}',
    ]);
    editor.setTextCursorPosition(editor.document[1], 'start');
    type(editor, '[^b] opens ');
    expect(citations(editor)).toContain('"type":"citation","props":{"id":"b","def":""}');
    expect(await saved(editor)).toBe('Body.[^a]\n\n[^b] opens last\n\n[^a]: The source\n');
  });

  it('leaves a line that is only a marker the chip the next load reads', async () => {
    const editor = await open('Body.\n');
    editor.insertBlocks([{ type: 'paragraph' }], editor.document[0], 'after');
    editor.setTextCursorPosition(editor.document[1], 'start');
    type(editor, '[^a]');
    enter(editor);
    type(editor, 'next');
    expect(citations(editor)).toEqual(['"type":"citation","props":{"id":"a","def":""}']);
    const md = await saved(editor);
    expect(md).toBe('Body.\n\n[^a]\n\nnext\n');
    expect(await reloaded(editor, md)).toEqual(citations(editor));
  });

  it('types a definition line as the definition it saves as', async () => {
    const editor = await open('Body.\n');
    editor.insertBlocks([{ type: 'paragraph' }], editor.document[0], 'after');
    editor.setTextCursorPosition(editor.document[1], 'start');
    type(editor, '[^a]: src');
    expect(citations(editor)).toEqual(['"type":"citation","props":{"id":"a","def":"1"}']);
    const md = await saved(editor);
    expect(md).toBe('Body.\n\n[^a]: src\n');
    expect(await reloaded(editor, md)).toEqual(citations(editor));
  });

  /* A delimiter still open before the marker. Its closing `` ` `` or `*` is
     typed AFTER the `]`, and the mark it then makes has to cover the marker,
     which it can only do while the marker is text. */
  it.each([
    ['`[^a]`', 'code'],
    ['**b[^a]**', 'bold'],
    ['*i[^a]*', 'italic'],
  ])('leaves %s text, under its %s mark, when the delimiter closes', async (typed, mark) => {
    const editor = await open('x\n');
    caretAtEnd(editor, 'x');
    type(editor, ` ${typed} y`);
    expect(citations(editor)).toEqual([]);
    expect(JSON.stringify(editor.document)).toContain(`"styles":{"${mark}":true}`);
    const md = await saved(editor);
    expect(md).toBe(`x ${typed} y\n`);
    expect(await reloaded(editor, md)).toEqual([]);
  });

  it.each([' 2 * 3 [^a]', ' snake_id [^a]', ' x [^a] y'])(
    'still closes %j — nothing before it opens a code span or emphasis',
    async (typed) => {
      const editor = await open('x\n');
      caretAtEnd(editor, 'x');
      type(editor, typed);
      expect(citations(editor)).toHaveLength(1);
      expect(await reloaded(editor, await saved(editor))).toEqual(citations(editor));
    },
  );

  it('reads a : after a reference chip that opens a line as its definition', async () => {
    const editor = await open('Body.\n\nx\n');
    editor.setTextCursorPosition(editor.document[1], 'start');
    insertCitation(editor.prosemirrorView, 'src');
    type(editor, ':');
    expect(citations(editor)).toEqual(['"type":"citation","props":{"id":"src","def":"1"}']);
    expect(await saved(editor)).toBe('Body.\n\n[^src]:x\n');
  });

  it("the menu's pick is a chip in plain text and the marker as text inside emphasis", async () => {
    const editor = await open('Plain.\n');
    const view = editor.prosemirrorView;
    caretAtEnd(editor, 'Plain.');
    insertCitation(view, 'a');
    type(editor, ' ');
    view.dispatch(view.state.tr.addStoredMark(view.state.schema.marks.italic.create()));
    type(editor, 'a claim');
    insertCitation(view, 'b');
    type(editor, ' more');
    expect(citations(editor)).toEqual(['"type":"citation","props":{"id":"a","def":""}']);
    expect(await saved(editor)).toBe('Plain.[^a] *a claim[^b] more*\n');
  });
});

/*
 * Pasting a citation (M52.4). BlockNote reads pasted markdown, and plain text
 * as markdown, with the GFM parser — which made `[^pp]` a numbered link and
 * its definition a generated "Footnotes" list. The paste goes through the
 * load's own escape instead, so the bytes are the ones the author copied.
 */
describe('pasting a citation', () => {
  beforeEach(() => {
    // jsdom has no ClipboardEvent, and TipTap's paste rules construct one.
    vi.stubGlobal('ClipboardEvent', class extends Event {});
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const clipboard = (data: Record<string, string>) => ({
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? '',
  });

  function paste(editor: CerebroEditor, data: Record<string, string>): void {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: clipboard(data) });
    editor.prosemirrorView.dom.dispatchEvent(event);
  }

  const PASTED = 'Pasted claim.[^pp]\n\n[^pp]: Pasted source';

  it.each(['text/plain', 'text/markdown'])('keeps the footnotes of %s as written', async (type) => {
    const editor = await open('Body.\n');
    caretAtEnd(editor, 'Body.');
    paste(editor, { [type]: PASTED });
    const md = await saved(editor);
    expect(md).toContain('Pasted claim.[^pp]');
    expect(md).toContain('[^pp]: Pasted source');
    expect(md).not.toMatch(/Footnotes|user-content|\\\[/);
  });

  it('pastes text without a marker, and every other format, the way BlockNote does', async () => {
    const editor = await open('Body.\n');
    const pasteMarkdown = vi.spyOn(editor, 'pasteMarkdown');
    const route = (data: Record<string, string>) => {
      const defaultPasteHandler = vi.fn(() => true);
      const event = { clipboardData: clipboard(data) } as unknown as ClipboardEvent;
      citationPasteHandler({ event, editor, defaultPasteHandler });
      return defaultPasteHandler.mock.calls.length;
    };
    // The editor's own copy, HTML, and a VS Code copy lead with a format that
    // is not markdown, whatever plain text rides along with them.
    expect(route({ 'vscode-editor-data': '{}', 'text/plain': PASTED })).toBe(1);
    expect(route({ 'blocknote/html': '<p>x</p>', 'text/plain': PASTED })).toBe(1);
    expect(route({ 'text/html': '<p>x</p>', 'text/plain': PASTED })).toBe(1);
    expect(route({ 'text/plain': 'No marker here.' })).toBe(1);
    expect(pasteMarkdown).not.toHaveBeenCalled();
    expect(route({ 'text/plain': PASTED })).toBe(0);
    expect(pasteMarkdown).toHaveBeenCalledWith('Pasted claim.\\[^pp]\n\n\\[^pp]: Pasted source');
  });

  it('pastes into a code block as the code block takes it', async () => {
    const editor = await open('```text\nfenced\n```\n');
    caretAtEnd(editor, 'fenced');
    paste(editor, { 'text/plain': ' [^pp]' });
    expect(await saved(editor)).toBe('```text\nfenced [^pp]\n```\n');
  });
});
