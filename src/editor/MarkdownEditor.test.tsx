// @vitest-environment jsdom
import type { DefaultSuggestionItem } from '@blocknote/core/extensions';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVaultStore } from '@/stores/vaultStore';
import { LazyMarkdownEditor } from './LazyMarkdownEditor';
import {
  DROPPED_SLASH_KEYS,
  MarkdownEditor,
  TABLE_SETTINGS,
  type CerebroEditor,
  type EditorReadyInfo,
} from './MarkdownEditor';

type ReadyInfo = Pick<EditorReadyInfo, 'editor' | 'lossyCause'>;

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

  /* A turn flushes the open page before its child starts (M53.6), and it can
     only wait for what the flush hands back: the save itself, not the emit
     that starts it. */
  it('flushPendingSave resolves once the save it started has landed', async () => {
    let land = () => {};
    const onChange = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          land = resolve;
        }),
    );
    const onReady = vi.fn<(info: EditorReadyInfo) => void>();
    render(
      <MarkdownEditor
        markdown={'# Doc\n'}
        onChange={onChange}
        onReady={onReady}
        debounceMs={60_000}
      />,
    );
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    const { editor, flushPendingSave } = onReady.mock.calls[0][0];
    appendParagraph(editor, 'typed before asking');
    let flushed = false;
    void flushPendingSave().then(() => (flushed = true));
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
    expect(onChange.mock.calls[0]).toEqual(['# Doc\n\ntyped before asking\n']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(flushed).toBe(false);
    land();
    await waitFor(() => expect(flushed).toBe(true));
  });

  it('flushPendingSave with nothing pending waits for the save already in flight', async () => {
    let land = () => {};
    const onChange = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          land = resolve;
        }),
    );
    const onReady = vi.fn<(info: EditorReadyInfo) => void>();
    render(
      <MarkdownEditor markdown={'# Doc\n'} onChange={onChange} onReady={onReady} debounceMs={20} />,
    );
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    const { editor, flushPendingSave } = onReady.mock.calls[0][0];
    appendParagraph(editor, 'typed a moment ago');
    // The debounce has fired and its save is on its way to disk.
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
    let flushed = false;
    void flushPendingSave().then(() => (flushed = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(flushed).toBe(false);
    expect(onChange).toHaveBeenCalledOnce();
    land();
    await waitFor(() => expect(flushed).toBe(true));
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
    expect(info.lossyCause).toBe('html');
  });

  it('reports a clean import for normal markdown', async () => {
    const info = await renderReady({ markdown: '# Fine\n\n- [ ] task\n' });
    expect(info.lossyCause).toBeNull();
  });

  /* An image used to save with the alt text BlockNote invents, which the
     lossy check read as words the file never had: every page with an image
     opened read-only (M55.4). */
  it('reports a clean import for a page with an image, a toggle and a nested child', async () => {
    const info = await renderReady({
      markdown:
        '![](attachments/a.png)\n\n:::toggle Details\nInside.\n:::\n\nParent.\n\n:::indent\nChild.\n:::\n',
    });
    expect(info.editor.document.map((b) => b.type)).toEqual([
      'image',
      'toggleListItem',
      'paragraph',
    ]);
    expect(info.editor.document[2].children.map((b) => b.type)).toEqual(['paragraph']);
    expect(info.lossyCause).toBeNull();
  });

  /* The unmount flush renders nothing, so a carrier that needed rendering
     would be written as nothing there (M51.5, M53.9). */
  it('flushes a toggle and an image on unmount as their carriers', async () => {
    const markdown =
      ':::toggle Ask [[maya-chen]] first\nInside.\n:::\n\n![Plan](attachments/plan.png "The plan")\n';
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
    expect(editor.document.map((b) => b.type).slice(0, 2)).toEqual(['toggleListItem', 'image']);
    appendParagraph(editor, 'last words');
    unmount();
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0][0]).toBe(`${markdown}\nlast words\n`);
  });
});

/**
 * The `/` menu offers only blocks a save keeps (M53.31): since M55.4 gave
 * toggles, toggle headings, audio and file their carriers, that is every
 * block BlockNote has. Opened the way a keyboard opens it, the `/` offered to
 * the editor's text-input handlers.
 */
describe('the / menu', () => {
  beforeEach(() => {
    // The menu measures where its trigger is; jsdom has no layout, and its
    // rect has no `toJSON` for BlockNote to call.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      ...{ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 },
      toJSON: () => ({}),
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const type = (editor: CerebroEditor, text: string) =>
    act(() => {
      const view = editor.prosemirrorView;
      for (const ch of text) {
        const { from, to } = view.state.selection;
        const handled = view.someProp('handleTextInput', (f) =>
          f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)),
        );
        if (handled !== true) view.dispatch(view.state.tr.insertText(ch, from, to));
      }
    });

  const options = () => [...document.querySelectorAll('#bn-suggestion-menu [role=option]')];
  const offered = () =>
    options().map((el) => el.querySelector('.bn-mt-suggestion-menu-item-title')?.textContent ?? '');

  /** A page holding `Plain.` with the `/` menu open at its end. */
  const openMenu = async (): Promise<CerebroEditor> => {
    const { editor } = await renderReady({ markdown: 'Plain.\n' });
    // Ready fires as the view mounts, before its menus have registered their
    // triggers; the text rendering is the view having committed.
    await waitFor(() => expect(document.querySelector('.bn-editor')?.textContent).toBe('Plain.'));
    editor.setTextCursorPosition(editor.document[0], 'end');
    await type(editor, ' /');
    await waitFor(() => expect(offered()).toContain('Callout'));
    return editor;
  };

  it('offers toggles, audio, file, image, table and Cerebro’s blocks', async () => {
    const editor = await openMenu();
    const title = (key: DefaultSuggestionItem['key']) => editor.dictionary.slash_menu[key].title;
    expect(DROPPED_SLASH_KEYS.size).toBe(0);
    expect(offered()).toEqual(
      expect.arrayContaining([
        title('toggle_list'),
        title('toggle_heading'),
        title('toggle_heading_2'),
        title('toggle_heading_3'),
        title('audio'),
        title('file'),
        title('image'),
        title('table'),
        'AI block',
        'Callout',
        'Mermaid diagram',
        'Database',
        '2 columns',
        '2 columns · Turn into',
      ]),
    );
  });

  it('inserts a table with a header row', async () => {
    const editor = await openMenu();
    const table = options()[offered().indexOf(editor.dictionary.slash_menu.table.title)];
    fireEvent.click(table);
    await waitFor(() => expect(editor.document.some((b) => b.type === 'table')).toBe(true));
    const inserted = editor.document.find((b) => b.type === 'table')!;
    expect((inserted.content as { headerRows?: number }).headerRows).toBe(1);
  });
});

/**
 * The formatting toolbar and the block menu offer only what a save keeps
 * (M55.15). Underline, colour and alignment sat on the toolbar, and a page
 * reopened without them; `markdown.test.ts` measures each one.
 */
describe('the toolbar and block menu', () => {
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

  /** The internal TipTap editor, for a text selection a person would drag. */
  type WithTiptap = {
    _tiptapEditor: {
      commands: { setTextSelection: (range: { from: number; to: number }) => void };
    };
  };

  it('opens on a selection without underline, colour or alignment', async () => {
    const { editor } = await renderReady({ markdown: 'Some words here.\n' });
    await waitFor(() =>
      expect(document.querySelector('.bn-editor')?.textContent).toBe('Some words here.'),
    );
    act(() => {
      editor.focus();
      (editor as unknown as WithTiptap)._tiptapEditor.commands.setTextSelection({ from: 3, to: 9 });
    });
    const bar = await waitFor(() => {
      const found = document.querySelector('.bn-formatting-toolbar');
      expect(found).not.toBeNull();
      return found!;
    });
    const labels = [...bar.querySelectorAll('button')].map(
      (b) => b.getAttribute('aria-label') ?? b.textContent ?? '',
    );
    const t = editor.dictionary.formatting_toolbar;
    expect(labels).toEqual(expect.arrayContaining([t.bold.tooltip, t.italic.tooltip]));
    for (const gone of [
      t.underline.tooltip,
      t.colors.tooltip,
      t.align_left.tooltip,
      t.align_center.tooltip,
      t.align_right.tooltip,
    ]) {
      expect(labels).not.toContain(gone);
    }
  });

  it('turns off the table controls a markdown table cannot carry', async () => {
    const { editor } = await renderReady({ markdown: '| a |\n| - |\n| b |\n' });
    expect(editor.settings.tables).toEqual(TABLE_SETTINGS);
    expect(Object.values(TABLE_SETTINGS)).toEqual([false, false, false, false]);
  });
});

/* A bare fence reopened as `javascript` and the page opened read-only for the
   word (M55.15); the cause reaches the host so its banner can name it. */
describe('lossy imports', () => {
  afterEach(cleanup);

  it('opens a bare code fence as a block with no language, and clean', async () => {
    const info = await renderReady({ markdown: '```\nnpm install\n```\n' });
    expect(info.editor.document[0]).toMatchObject({ type: 'codeBlock', props: { language: '' } });
    expect(info.lossyCause).toBeNull();
  });

  it('names a cause that is not raw HTML', async () => {
    const info = await renderReady({ markdown: 'See [a][r].\n\n[r]: https://example.com\n' });
    expect(info.lossyCause).toBe('dropped');
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
