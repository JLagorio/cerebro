// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blocksToMarkdown, markdownToBlocks } from './markdown';
import { MarkdownEditor, type CerebroEditor } from './MarkdownEditor';
import { pageLinkPasteHandler } from './pageCardInput';

/**
 * Pasting a page link (M55.14): alone on an empty line it becomes a page
 * card; anywhere else it is BlockNote's paste, through the citation half
 * (M52.4). Every case ends on the bytes the page saves.
 */

async function open(markdown: string): Promise<CerebroEditor> {
  const onReady = vi.fn<(info: { editor: CerebroEditor }) => void>();
  render(<MarkdownEditor markdown={markdown} onChange={vi.fn()} onReady={onReady} />);
  await waitFor(() => expect(onReady).toHaveBeenCalled());
  return onReady.mock.calls[0][0].editor;
}

/** What the file says, and that reading it back gives the same file. */
async function saved(editor: CerebroEditor): Promise<string> {
  const md = await blocksToMarkdown(editor);
  expect(await blocksToMarkdown(editor, await markdownToBlocks(editor, md))).toBe(md);
  return md;
}

const clipboard = (data: Record<string, string>) => ({
  types: Object.keys(data),
  files: [],
  getData: (type: string) => data[type] ?? '',
});

function paste(editor: CerebroEditor, data: Record<string, string>): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: clipboard(data) });
  editor.prosemirrorView.dom.dispatchEvent(event);
}

/** Put the caret in a new empty paragraph after the first block. */
function emptyLine(editor: CerebroEditor): void {
  const [line] = editor.insertBlocks([{ type: 'paragraph' }], editor.document[0], 'after');
  editor.setTextCursorPosition(line, 'start');
}

const types = (editor: CerebroEditor) => editor.document.map((b) => b.type);

describe('pasting a page link', () => {
  beforeEach(() => {
    // jsdom has no ClipboardEvent, and TipTap's paste rules construct one.
    vi.stubGlobal('ClipboardEvent', class extends Event {});
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(['text/plain', 'text/markdown'])(
    'turns a lone %s link on an empty line into a card that saves as the fence',
    async (type) => {
      const editor = await open('Body.\n');
      emptyLine(editor);
      paste(editor, { [type]: '  [[how-we-schedule]]\n' });
      expect(types(editor)).toContain('pageCard');
      expect(editor.document.find((b) => b.type === 'pageCard')?.props).toMatchObject({
        target: 'how-we-schedule',
        alias: '',
      });
      expect(await saved(editor)).toBe('Body.\n\n```cerebro-page\n[[how-we-schedule]]\n```\n');
    },
  );

  it('keeps an alias as written', async () => {
    const editor = await open('Body.\n');
    emptyLine(editor);
    paste(editor, { 'text/plain': '[[how-we-schedule|Scheduling]]' });
    expect(await saved(editor)).toContain('```cerebro-page\n[[how-we-schedule|Scheduling]]\n```');
  });

  it('leaves a link pasted into text as an inline link', async () => {
    const editor = await open('Body.\n');
    editor.setTextCursorPosition(editor.document[0], 'end');
    paste(editor, { 'text/plain': ' [[how-we-schedule]]' });
    expect(types(editor)).not.toContain('pageCard');
    const md = await saved(editor);
    expect(md).toContain('[[how-we-schedule]]');
    expect(md).not.toContain('cerebro-page');
  });

  it('leaves the line alone when more than one link, or a sentence, is pasted', async () => {
    const editor = await open('Body.\n');
    const route = (text: string) => {
      emptyLine(editor);
      const defaultPasteHandler = vi.fn(() => true);
      const event = {
        clipboardData: clipboard({ 'text/plain': text }),
      } as unknown as ClipboardEvent;
      pageLinkPasteHandler({ event, editor, defaultPasteHandler });
      return defaultPasteHandler.mock.calls.length;
    };
    expect(route('[[a]] [[b]]')).toBe(0);
    expect(route('See [[a]].')).toBe(0);
    expect(await saved(editor)).toContain('See [[a]].');
    // HTML leads, whatever plain text rides along with it.
    const html = {
      clipboardData: clipboard({ 'text/html': '<p>[[a]]</p>', 'text/plain': '[[a]]' }),
    } as unknown as ClipboardEvent;
    emptyLine(editor);
    const defaultPasteHandler = vi.fn(() => true);
    pageLinkPasteHandler({ event: html, editor, defaultPasteHandler });
    expect(defaultPasteHandler).toHaveBeenCalledTimes(1);
    expect(types(editor)).not.toContain('pageCard');
  });

  it('keeps escaped pasted links literal beside live pasted links', async () => {
    const editor = await open('Body.\n');
    paste(editor, { 'text/plain': '[[Live]] \\[\\[Literal\\]\\]' });
    const md = await saved(editor);
    expect(md).toContain('[[Live]]');
    expect(md).toContain('&#91;&#91;Literal&#93;&#93;');
    expect(JSON.stringify(editor.document).match(/"type":"wikilink"/g)).toHaveLength(1);
  });

  it('keeps a citation paste’s markers', async () => {
    const editor = await open('Body.\n');
    editor.setTextCursorPosition(editor.document[0], 'end');
    paste(editor, { 'text/plain': 'Pasted claim.[^pp]\n\n[^pp]: Pasted source' });
    const md = await saved(editor);
    expect(md).toContain('Pasted claim.[^pp]');
    expect(md).toContain('[^pp]: Pasted source');
  });

  it('pastes into a code block as the code block takes it', async () => {
    const editor = await open('```text\nfenced\n```\n');
    editor.setTextCursorPosition(editor.document[0], 'end');
    paste(editor, { 'text/plain': ' [[how-we-schedule]]' });
    expect(types(editor)).not.toContain('pageCard');
    expect(await saved(editor)).toBe('```text\nfenced [[how-we-schedule]]\n```\n');
  });

  it('gives the empty line back on undo', async () => {
    const editor = await open('Body.\n');
    emptyLine(editor);
    paste(editor, { 'text/plain': '[[how-we-schedule]]' });
    expect(types(editor)).toContain('pageCard');
    editor.undo();
    expect(types(editor)).not.toContain('pageCard');
    expect(await saved(editor)).not.toContain('how-we-schedule');
  });
});
