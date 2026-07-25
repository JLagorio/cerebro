// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BlockNoteEditor } from '@blocknote/core';
import { LazyMarkdownEditor } from './LazyMarkdownEditor';
import { MarkdownEditor } from './MarkdownEditor';

type ReadyInfo = { editor: BlockNoteEditor; lossyImport: boolean };

async function renderReady(props: {
  markdown: string;
  onChange?: (md: string) => void;
  debounceMs?: number;
}): Promise<ReadyInfo> {
  const onReady = vi.fn<(info: ReadyInfo) => void>();
  render(
    <MarkdownEditor
      markdown={props.markdown}
      onChange={props.onChange ?? vi.fn()}
      onReady={onReady}
      debounceMs={props.debounceMs ?? 40}
    />,
  );
  await waitFor(() => expect(onReady).toHaveBeenCalled());
  return onReady.mock.calls[0][0];
}

const appendParagraph = (editor: BlockNoteEditor, text: string) => {
  const last = editor.document[editor.document.length - 1];
  editor.insertBlocks([{ type: 'paragraph', content: text }], last, 'after');
};

describe('MarkdownEditor', () => {
  afterEach(cleanup);

  it('renders the initial markdown as editor content', async () => {
    await renderReady({ markdown: '# Hello\n\nWorld paragraph.\n' });
    await waitFor(() => {
      expect(screen.getByText('Hello')).toBeTruthy();
      expect(screen.getByText('World paragraph.')).toBeTruthy();
    });
  });

  it('never calls onChange for merely opening a document', async () => {
    const onChange = vi.fn();
    await renderReady({ markdown: '- [ ] task one\n', onChange, debounceMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('emits debounced serialized markdown after an edit', async () => {
    const onChange = vi.fn();
    const { editor } = await renderReady({ markdown: '# Doc\n', onChange, debounceMs: 20 });
    appendParagraph(editor, 'Appended line');
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toBe('# Doc\n\nAppended line\n');
  });

  it('collapses rapid edits into one emit', async () => {
    const onChange = vi.fn();
    const { editor } = await renderReady({ markdown: '# Doc\n', onChange, debounceMs: 60 });
    appendParagraph(editor, 'one');
    appendParagraph(editor, 'two');
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toContain('two');
  });

  it('flushes a pending edit on unmount', async () => {
    const onChange = vi.fn();
    const onReady = vi.fn<(info: ReadyInfo) => void>();
    const { unmount } = render(
      <MarkdownEditor
        markdown={'# Doc\n'}
        onChange={onChange}
        onReady={onReady}
        debounceMs={60_000}
      />,
    );
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    appendParagraph(onReady.mock.calls[0][0].editor, 'last words');
    unmount();
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0][0]).toContain('last words');
  });

  it('reports a lossy import for raw HTML content', async () => {
    const info = await renderReady({ markdown: '<div align="center">centered</div>\n' });
    expect(info.lossyImport).toBe(true);
  });

  it('reports a clean import for normal markdown', async () => {
    const info = await renderReady({ markdown: '# Fine\n\n- [ ] task\n' });
    expect(info.lossyImport).toBe(false);
  });
});

describe('LazyMarkdownEditor', () => {
  afterEach(cleanup);

  it('renders the editor after the lazy chunk loads', async () => {
    render(<LazyMarkdownEditor markdown={'# Lazy\n'} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('markdown-editor')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Lazy')).toBeTruthy());
  });
});
