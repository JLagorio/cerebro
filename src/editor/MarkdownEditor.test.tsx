// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVaultStore } from '@/stores/vaultStore';
import { LazyMarkdownEditor } from './LazyMarkdownEditor';
import { MarkdownEditor, type CerebroEditor } from './MarkdownEditor';

type ReadyInfo = { editor: CerebroEditor; lossyImport: boolean };

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

const appendParagraph = (editor: CerebroEditor, text: string) => {
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

  /* That flush runs inside React's commit, where React will not render — and
     every chip used to be serialized by rendering it. Measured before M51.5
     demoted chips to text first: this page flushed as `See and a claim.` and
     `The source`, the link and both citation markers gone. The AI block was
     serialized by rendering too, until M53.9 gave it a carrier: an ordinary
     save wrote its chrome, and this flush dropped the block entirely. */
  it('flushes chips and an AI block on unmount as the text they are on disk', async () => {
    const markdown =
      'See [[kickoff]] and a claim.[^a]\n\n' +
      ':::ai{prompt="The open questions" generated="2026-10-12"}\n' +
      '* Who owns [[kickoff]]?\n' +
      ':::\n\n' +
      '[^a]: The source\n';
    const onChange = vi.fn();
    const onReady = vi.fn<(info: ReadyInfo) => void>();
    const { unmount } = render(
      <MarkdownEditor
        markdown={markdown}
        onChange={onChange}
        onReady={onReady}
        debounceMs={60_000}
      />,
    );
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    const { editor } = onReady.mock.calls[0][0];
    // An AI block in the editor, not a paragraph that happens to look like one.
    expect(editor.document.map((b) => b.type)).toEqual(['paragraph', 'ai', 'paragraph']);
    appendParagraph(editor, 'last words');
    unmount();
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0][0]).toBe(`${markdown}\nlast words\n`);
  });

  /* The way an answer actually arrives: the run writes it into the live block
     and schedules the save, and the page is left before the debounce ends. */
  it('flushes a freshly answered AI block on unmount as its carrier', async () => {
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
    const { editor } = onReady.mock.calls[0][0];
    editor.insertBlocks(
      [
        {
          type: 'ai',
          props: { prompt: 'What does this decide?', generated: '2026-10-12' },
          children: [{ type: 'paragraph', content: 'The freeze moves a week.' }],
        },
      ],
      editor.document[editor.document.length - 1],
      'after',
    );
    unmount();
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0][0]).toBe(
      '# Doc\n\n' +
        ':::ai{prompt="What does this decide?" generated="2026-10-12"}\n' +
        'The freeze moves a week.\n' +
        ':::\n',
    );
  });

  /* Enter asks the question just typed. The ask used to read it off the render
     from before the question was written — so a new block asked its old,
     empty question, and the editor declined to run it. */
  it('asks an AI block the question just typed when Enter is pressed', async () => {
    const asked = vi.fn();
    const listen = (event: Event) => asked((event as CustomEvent<{ prompt: string }>).detail);
    window.addEventListener('cerebro:ai-block-run', listen);
    try {
      const { editor } = await renderReady({ markdown: ':::ai\n:::\n' });
      const field = await screen.findByTestId('ai-block-prompt-input');
      fireEvent.change(field, { target: { value: 'What does this decide?' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(asked).toHaveBeenCalledTimes(1);
      expect(asked.mock.calls[0][0]).toMatchObject({ prompt: 'What does this decide?' });
      expect(editor.document[0].props).toMatchObject({ prompt: 'What does this decide?' });
    } finally {
      window.removeEventListener('cerebro:ai-block-run', listen);
    }
  });

  /* The question lived only in the field until a blur or Enter wrote it, so a
     page left any other way — a shortcut, the app navigating on its own —
     lost it, and the unmount flush saved an empty `:::ai`. It goes into the
     block as it is typed, and the field it is typed into stays the same
     element, holding the caret. */
  it('flushes a question typed but never committed on unmount', async () => {
    const onChange = vi.fn();
    const onReady = vi.fn<(info: ReadyInfo) => void>();
    const { unmount } = render(
      <MarkdownEditor
        markdown={':::ai\n:::\n'}
        onChange={onChange}
        onReady={onReady}
        debounceMs={60_000}
      />,
    );
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    const { editor } = onReady.mock.calls[0][0];
    const field = await screen.findByTestId('ai-block-prompt-input');
    field.focus();
    fireEvent.change(field, { target: { value: 'What does this' } });
    fireEvent.change(field, { target: { value: 'What does this decide?' } });
    expect(screen.getByTestId('ai-block-prompt-input')).toBe(field);
    expect(document.activeElement).toBe(field);
    expect(editor.document[0].props).toMatchObject({ prompt: 'What does this decide?' });
    unmount();
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0][0]).toBe(':::ai{prompt="What does this decide?"}\n:::\n');
  });

  /* Typed into the block as it goes, so Escape takes it back out of the block
     too — and a page whose question ends as it began writes nothing. */
  it('puts the question back on Escape, in the block as well as the field', async () => {
    const onChange = vi.fn();
    const { editor } = await renderReady({
      markdown: ':::ai{prompt="What does this decide?"}\n:::\n',
      onChange,
      debounceMs: 20,
    });
    fireEvent.click(await screen.findByTestId('ai-block-prompt'));
    const field = await screen.findByTestId('ai-block-prompt-input');
    fireEvent.change(field, { target: { value: 'What does this decide? Really?' } });
    expect(editor.document[0].props).toMatchObject({ prompt: 'What does this decide? Really?' });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(editor.document[0].props).toMatchObject({ prompt: 'What does this decide?' });
    expect((await screen.findByTestId('ai-block-prompt')).textContent).toBe(
      'What does this decide?',
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(onChange).not.toHaveBeenCalled();
  });

  /* Asking again REPLACES the answer: the run writes the block's children in
     one edit. Through the browser-mode mock agent, which answers this question
     with its plain reply (src/agent/mockAgent.ts). */
  it('replaces an AI block’s answer when it is asked again, and saves the new one', async () => {
    const vaultBefore = useVaultStore.getState().vaultPath;
    useVaultStore.setState({ vaultPath: '/vault' });
    try {
      const onChange = vi.fn();
      const { editor } = await renderReady({
        markdown:
          ':::ai{prompt="What does this decide?" generated="2026-01-01"}\nThe old answer.\n:::\n',
        onChange,
      });
      const [block] = editor.document;
      window.dispatchEvent(
        new CustomEvent('cerebro:ai-block-run', {
          detail: { id: block.id, prompt: 'What does this decide?' },
        }),
      );
      await waitFor(() => expect(onChange).toHaveBeenCalled());
      const saved: string = onChange.mock.calls[0][0];
      expect(saved).toMatch(
        /^:::ai\{prompt="What does this decide\?" generated="\d{4}-\d{2}-\d{2}"\}\nThis vault tracks work as typed markdown/,
      );
      expect(saved).not.toContain('2026-01-01');
      expect(saved).not.toContain('The old answer.');
      expect(editor.document[0].children).toHaveLength(1);
    } finally {
      useVaultStore.setState({ vaultPath: vaultBefore });
    }
  });

  /* BlockNote's Enter makes a sibling of the block it splits, so a note
     started after an answer landed INSIDE the AI block, and the Recompute
     that replaces every child took it with the old answer. MEASURED in
     Chromium before Enter learned to leave the answer. */
  it('starts a paragraph after an AI block when Enter ends its answer, and Recompute keeps it', async () => {
    const vaultBefore = useVaultStore.getState().vaultPath;
    useVaultStore.setState({ vaultPath: '/vault' });
    try {
      const onChange = vi.fn();
      const { editor } = await renderReady({
        markdown:
          ':::ai{prompt="What does this decide?" generated="2026-01-01"}\nShip on Thursdays.\n:::\n',
        onChange,
      });
      const [block] = editor.document;
      editor.setTextCursorPosition(block.children[0], 'end');
      const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      editor.domElement!.dispatchEvent(enter);
      expect(enter.defaultPrevented).toBe(true);
      editor.insertInlineContent('My own note.');
      expect(editor.document[0].children).toHaveLength(1);
      expect(editor.document[1].content).toMatchObject([{ text: 'My own note.' }]);
      await waitFor(() => expect(onChange).toHaveBeenCalled());
      expect(onChange.mock.lastCall?.[0]).toContain('Ship on Thursdays.\n:::\n\nMy own note.\n');

      window.dispatchEvent(
        new CustomEvent('cerebro:ai-block-run', {
          detail: { id: block.id, prompt: 'What does this decide?' },
        }),
      );
      await waitFor(() =>
        expect(onChange.mock.lastCall?.[0]).toContain('This vault tracks work as typed markdown'),
      );
      const saved: string = onChange.mock.lastCall?.[0];
      expect(saved).not.toContain('Ship on Thursdays.');
      expect(saved).toMatch(/\n:::\n\nMy own note\.\n$/);
      expect(editor.document[1].content).toMatchObject([{ text: 'My own note.' }]);
    } finally {
      useVaultStore.setState({ vaultPath: vaultBefore });
    }
  });

  /* Anywhere but the end of the answer's last block, Enter is BlockNote's:
     it edits the answer. */
  it('leaves Enter in the middle of an answer to the answer', async () => {
    const { editor } = await renderReady({
      markdown: ':::ai{prompt="Q"}\nFirst line.\n\nSecond line.\n:::\n',
    });
    const [block] = editor.document;
    editor.setTextCursorPosition(block.children[0], 'end');
    editor.domElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(editor.document[0].children).toHaveLength(3);
  });

  /* The page loads with an unasked block's field open, and must not hand it
     the caret; a click on an asked question opens the field and must. */
  it('focuses the question field when the question is clicked, and not when the page loads', async () => {
    await renderReady({ markdown: ':::ai\n:::\n\n:::ai{prompt="What does this decide?"}\n:::\n' });
    const unasked = await screen.findByTestId('ai-block-prompt-input');
    expect(document.activeElement).not.toBe(unasked);
    fireEvent.click(screen.getByTestId('ai-block-prompt'));
    await waitFor(() => expect(screen.getAllByTestId('ai-block-prompt-input')).toHaveLength(2));
    const asked = screen.getAllByTestId('ai-block-prompt-input')[1];
    expect(asked).toHaveProperty('value', 'What does this decide?');
    await waitFor(() => expect(document.activeElement).toBe(asked));
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
