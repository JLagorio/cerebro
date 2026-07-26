// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRef } from 'react';
import { BlockNoteEditor } from '@blocknote/core';
import { useUiStore } from '@/stores/uiStore';
import { buildOutline, DocOutline } from './DocOutline';
import { markdownToBlocks } from './markdown';

const MD = '# Title\n\nIntro.\n\n## Section one\n\nText.\n\n### Detail\n\n## Section two\n';

async function makeEditor(md = MD): Promise<BlockNoteEditor> {
  const editor = BlockNoteEditor.create();
  editor.replaceBlocks(editor.document, await markdownToBlocks(editor, md));
  return editor;
}

const scrollRef = () => createRef<HTMLDivElement>();

describe('buildOutline', () => {
  it('collects H1-H3 with level and text, skipping deeper and empty headings', async () => {
    const editor = await makeEditor(`${MD}\n#### Too deep\n`);
    const items = buildOutline(editor.document);
    expect(items.map((i) => [i.level, i.text])).toEqual([
      [1, 'Title'],
      [2, 'Section one'],
      [3, 'Detail'],
      [2, 'Section two'],
    ]);
    expect(items.every((i) => i.id.length > 0)).toBe(true);
  });
});

describe('DocOutline', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.setState({ docOutlineCollapsed: false });
  });
  afterEach(cleanup);

  it('renders the heading list', async () => {
    const editor = await makeEditor();
    render(<DocOutline editor={editor} scrollRef={scrollRef()} />);
    expect(screen.getByTestId('doc-outline')).toBeTruthy();
    expect(screen.getByText('Section one')).toBeTruthy();
    expect(screen.getByText('Detail')).toBeTruthy();
  });

  it('renders nothing for a doc without headings', async () => {
    const editor = await makeEditor('Just a paragraph.\n');
    render(<DocOutline editor={editor} scrollRef={scrollRef()} />);
    expect(screen.queryByTestId('doc-outline')).toBeNull();
  });

  it('clicking an item moves the editor cursor to that block', async () => {
    const editor = await makeEditor();
    const target = buildOutline(editor.document).find((i) => i.text === 'Section two')!;
    render(<DocOutline editor={editor} scrollRef={scrollRef()} />);
    fireEvent.click(screen.getByText('Section two'));
    expect(editor.getTextCursorPosition().block.id).toBe(target.id);
  });

  it('minimizes to a floating button and persists the collapse', async () => {
    const editor = await makeEditor();
    render(<DocOutline editor={editor} scrollRef={scrollRef()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide outline' }));
    expect(screen.queryByTestId('doc-outline')).toBeNull();
    expect(window.localStorage.getItem('cerebro.docOutlineCollapsed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Show outline' }));
    expect(screen.getByTestId('doc-outline')).toBeTruthy();
    expect(useUiStore.getState().docOutlineCollapsed).toBe(false);
  });

  it('picks up headings added to the document (debounced)', async () => {
    const editor = await makeEditor();
    render(<DocOutline editor={editor} scrollRef={scrollRef()} />);
    const last = editor.document[editor.document.length - 1];
    editor.insertBlocks(
      [{ type: 'heading', props: { level: 2 }, content: 'Appendix' }],
      last,
      'after',
    );
    await waitFor(() => expect(screen.getByText('Appendix')).toBeTruthy());
  });
});
