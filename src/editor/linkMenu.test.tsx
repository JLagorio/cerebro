// @vitest-environment jsdom
import { SuggestionMenu } from '@blocknote/core/extensions';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLinkedPage } from '@/app/listActions';
import { makeEntry } from '@/engine/testHelpers';
import { useOpenLogStore } from '@/stores/openLogStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import {
  charBeforeTrigger,
  creatableTitle,
  mentionAtWordStart,
  mentionNamesPage,
  readLinkQuery,
  stemOfPath,
  type TriggerState,
} from './linkMenu';
import { blocksToMarkdown } from './markdown';
import { MarkdownEditor, type CerebroEditor, type EditorReadyInfo } from './MarkdownEditor';

// The page write itself is listActions.test's; here it stands in, so a test
// can choose what it answers and when.
vi.mock('@/app/listActions', () => ({ createLinkedPage: vi.fn() }));

describe('creatableTitle', () => {
  const cases: [string, string | null][] = [
    ['Launch notes', 'Launch notes'],
    ['  Launch notes  ', 'Launch notes'],
    ['a^b', 'a^b'],
    ['', null],
    ['   ', null],
    ['a[b', null],
    ['a]b', null],
    ['a|b', null],
    ['a#b', null],
    ['^x', null],
    [' ^x', null],
  ];
  it.each(cases)('%j gives %j', (text, title) => {
    expect(creatableTitle(text)).toBe(title);
  });
});

describe('readLinkQuery', () => {
  it.each([
    ['a leading ^ cites, read on the raw query', '^fir', '[', { kind: 'cite', text: 'fir' }],
    ['a ] closes the link', 'x]', '[', { kind: 'closed' }],
    ['a ] closes it after a leading bracket too', '[x]', ' ', { kind: 'closed' }],
    [
      'the bracket before the trigger makes it [[',
      'Launch',
      '[',
      { kind: 'page', text: 'Launch', double: true, section: null },
    ],
    [
      'a leading bracket makes it [[ and is dropped',
      '[Launch',
      ' ',
      { kind: 'page', text: 'Launch', double: true, section: null },
    ],
    [
      'anything else before is a lone [',
      'Launch',
      ' ',
      { kind: 'page', text: 'Launch', double: false, section: null },
    ],
    [
      'the start of a block is a lone [',
      'Launch',
      '',
      { kind: 'page', text: 'Launch', double: false, section: null },
    ],
    [
      'an unreadable trigger is a lone [',
      'Launch',
      null,
      { kind: 'page', text: 'Launch', double: false, section: null },
    ],
    [
      'a # splits a section from its page (M55.8)',
      'systems#Rollback',
      '[',
      {
        kind: 'page',
        text: 'systems#Rollback',
        double: true,
        section: { page: 'systems', heading: 'Rollback' },
      },
    ],
    [
      'only the first # splits, and both halves are trimmed',
      '[ systems # A#B ',
      ' ',
      {
        kind: 'page',
        text: ' systems # A#B ',
        double: true,
        section: { page: 'systems', heading: 'A#B' },
      },
    ],
    [
      'a leading # is a section of this page',
      '#Rollback',
      '[',
      { kind: 'page', text: '#Rollback', double: true, section: { page: '', heading: 'Rollback' } },
    ],
    [
      'no heading yet after the #',
      'systems#',
      '[',
      { kind: 'page', text: 'systems#', double: true, section: { page: 'systems', heading: null } },
    ],
  ] as const)('%s', (_name, query, before, asked) => {
    expect(readLinkQuery(query, before)).toEqual(asked);
  });
});

describe('mentionAtWordStart', () => {
  it.each(['', ' ', '(', '\uFFFC'])('starts a mention after %j', (before) => {
    expect(mentionAtWordStart(before)).toBe(true);
  });
  it.each(['a', '\u00E9', '1', '.', '-', '_', '+', null])('is mid-word after %j', (before) => {
    expect(mentionAtWordStart(before)).toBe(false);
  });
});

describe('mentionNamesPage', () => {
  it.each(['dana', 'Retro memo', 'Retro memo ', 'v1-2 notes', 'Caf\u00E9 plan'])(
    '%j could name a page',
    (query) => {
      expect(mentionNamesPage(query)).toBe(true);
    },
  );
  it.each([
    'alex when done',
    'dana about the launch plan',
    'dana,',
    'dana: see',
    'v1.2',
    'ok?',
    'go!',
    'a;b',
  ])('%j reads as a sentence', (query) => {
    expect(mentionNamesPage(query)).toBe(false);
  });
});

describe('charBeforeTrigger', () => {
  /** One textblock whose positions are its text's offsets. */
  const state = (text: string): TriggerState => ({
    selection: { from: text.length },
    doc: {
      textBetween: (from, to) => {
        if (from < 0 || to > text.length) throw new RangeError(`${from}..${to}`);
        return text.slice(from, to);
      },
      resolve: (pos) => ({ parentOffset: pos }),
    },
  });

  it('reads the character before the trigger', () => {
    expect(charBeforeTrigger(state('See [[Launch'), 'Launch', '[')).toBe('[');
    expect(charBeforeTrigger(state('ana@ex'), 'ex', '@')).toBe('a');
  });

  it("is '' when the trigger opens the block", () => {
    expect(charBeforeTrigger(state('@Retro'), 'Retro', '@')).toBe('');
  });

  it('is null when the trigger is not where the query puts it, and never throws', () => {
    expect(charBeforeTrigger(state('See Launch'), 'Launch', '[')).toBeNull();
    expect(charBeforeTrigger(state('x'), 'longer than the text', '[')).toBeNull();
    const broken: TriggerState = {
      selection: { from: 3 },
      doc: {
        textBetween: () => '[',
        resolve: () => {
          throw new RangeError('no such position');
        },
      },
    };
    expect(charBeforeTrigger(broken, 'ab', '[')).toBeNull();
  });
});

describe('stemOfPath', () => {
  it('is the filename less .md', () => {
    expect(stemOfPath('launch-notes.md')).toBe('launch-notes');
    expect(stemOfPath('notes/archive/Launch-Notes.MD')).toBe('Launch-Notes');
  });
});

/**
 * The menus on screen (M55.7), driven the way a keyboard drives them: each
 * character offered to the editor's text-input handlers, so the brackets and
 * the `@` open BlockNote's menus for real.
 */
describe('Create in the [[ and @ menus', () => {
  const toast = vi.fn();

  beforeEach(() => {
    vi.mocked(createLinkedPage).mockReset();
    toast.mockReset();
    useUiStore.setState({ toast });
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entries: [
        makeEntry({
          path: 'records/first.md',
          filename: 'first.md',
          folder: 'records',
          title: 'First record',
        }),
      ],
      status: 'ready',
      error: null,
    });
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

  const rows = () =>
    [...document.querySelectorAll('#bn-suggestion-menu > *')].map((el) =>
      el.getAttribute('role') === 'option'
        ? (el.querySelector('.bn-mt-suggestion-menu-item-title')?.textContent ?? '')
        : `# ${el.textContent}`,
    );

  const pick = (title: string) => {
    const option = [
      ...document.querySelectorAll<HTMLElement>('#bn-suggestion-menu [role=option]'),
    ].find((el) => el.querySelector('.bn-mt-suggestion-menu-item-title')?.textContent === title);
    if (option === undefined) throw new Error(`no row "${title}" in ${JSON.stringify(rows())}`);
    fireEvent.click(option);
  };

  const menuClosed = () => expect(document.querySelector('#bn-suggestion-menu')).toBeNull();

  /** The first paragraph's inline content: text as itself, a link as `[[target]]`. */
  const inline = (editor: CerebroEditor) =>
    (
      editor.document[0].content as { type: string; text?: string; props?: { target?: string } }[]
    ).map((node) =>
      node.type === 'wikilink' ? `[[${node.props?.target}]]` : (node.text ?? `<${node.type}>`),
    );

  async function openEditor() {
    const onReady = vi.fn<(info: EditorReadyInfo) => void>();
    const view = render(
      <MarkdownEditor markdown={'Plain.\n'} onChange={vi.fn()} onReady={onReady} />,
    );
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    const { editor } = onReady.mock.calls[0][0];
    // Ready fires as the view mounts, before its menus have registered their
    // triggers; the text rendering is the view having committed.
    await waitFor(() => expect(document.querySelector('.bn-editor')?.textContent).toBe('Plain.'));
    editor.setTextCursorPosition(editor.document[0], 'end');
    return { editor, unmount: view.unmount };
  }

  /** A create that lands when the test says so. */
  function deferCreate() {
    let land: (path: string | null) => void = () => {};
    vi.mocked(createLinkedPage).mockImplementation(
      () =>
        new Promise((resolve) => {
          land = resolve;
        }),
    );
    return (path: string | null) => act(async () => land(path));
  }

  // M59.3 — the `[[` page rows rank: the match tier, then your own opens.
  it('lists the page you opened first within its tier after [[', async () => {
    useVaultStore.setState({
      entries: [
        ...useVaultStore.getState().entries,
        makeEntry({ path: 'notes/plan-a.md', filename: 'plan-a.md', title: 'Plan a' }),
        makeEntry({ path: 'notes/plan-b.md', filename: 'plan-b.md', title: 'Plan b' }),
        makeEntry({ path: 'notes/unplanned.md', filename: 'unplanned.md', title: 'Unplanned' }),
      ],
    });
    useOpenLogStore.setState({ logs: {}, saved: true });
    useOpenLogStore.getState().record('/demo-vault', 'notes/plan-b.md');
    useOpenLogStore.getState().record('/demo-vault', 'notes/unplanned.md');
    const { editor } = await openEditor();
    await type(editor, ' [[plan');
    await waitFor(() =>
      expect(rows().slice(0, 4)).toEqual(['# Link page', 'Plan b', 'Plan a', 'Unplanned']),
    );
  });

  it('keeps People, Link page and Due date contiguous in the @ menu', async () => {
    useVaultStore.setState({
      entries: [
        ...useVaultStore.getState().entries,
        makeEntry({
          path: 'types/person.md',
          filename: 'person.md',
          title: 'Person',
          type: 'Type',
        }),
        makeEntry({ path: 'people/dana.md', filename: 'dana.md', title: 'Dana', type: 'Person' }),
        makeEntry({ path: 'notes/due.md', filename: 'due.md', title: 'Due diligence' }),
      ],
    });
    const { editor } = await openEditor();
    await type(editor, ' @d');
    await waitFor(() => expect(rows()).toContain('Dana'));
    const headers = rows().filter((r) => r.startsWith('# '));
    expect(headers.slice(0, 3)).toEqual(['# People', '# Link page', '# Due date']);
    expect(new Set(headers).size).toBe(headers.length);
  });

  // Which bracket opens the menu decides what the query holds, and the two
  // comments MarkdownEditor carried disagreed about it.
  it('opens the menu again on the second bracket of [[, so the query starts after both', async () => {
    const { editor } = await openEditor();
    await type(editor, ' [[Launch');
    await waitFor(() => expect(rows()).toContain('Create "Launch"'));
    expect(editor.getExtension(SuggestionMenu)?.store.state?.query).toBe('Launch');
    expect(charBeforeTrigger(editor.prosemirrorState, 'Launch', '[')).toBe('[');
  });

  it('ends [[ on a Create row that makes the page and links the stem it was written under', async () => {
    vi.mocked(createLinkedPage).mockResolvedValue('launch-notes.md');
    const { editor } = await openEditor();
    await type(editor, ' [[Launch notes');
    await waitFor(() => expect(rows()).toEqual(['# New page', 'Create "Launch notes"']));
    pick('Create "Launch notes"');
    expect(createLinkedPage).toHaveBeenCalledTimes(1);
    expect(createLinkedPage).toHaveBeenCalledWith('Launch notes');
    // Exactly one link, and neither bracket left behind as text.
    await waitFor(() => expect(inline(editor)).toEqual(['Plain. ', '[[launch-notes]]', ' ']));
    expect(await blocksToMarkdown(editor)).toContain('Plain. [[launch-notes]]');
    expect(toast).not.toHaveBeenCalled();
  });

  it('offers no Create row for a name a page already answers to', async () => {
    const { editor } = await openEditor();
    await type(editor, ' [[First record');
    await waitFor(() => expect(rows()).toEqual(['# Link page', 'First record']));
  });

  it('offers no Create row after a lone [', async () => {
    const { editor } = await openEditor();
    await type(editor, ' [Fir');
    await waitFor(() => expect(rows()).toEqual(['# Link page', 'First record']));
  });

  it.each(['|b', '#b'])('drops the Create row once %j makes it link syntax', async (more) => {
    const { editor } = await openEditor();
    await type(editor, ' [[a');
    await waitFor(() => expect(rows()).toEqual(['# New page', 'Create "a"']));
    await type(editor, more);
    await waitFor(() =>
      expect(rows()).toEqual([`# ${editor.dictionary.suggestion_menu.no_items_title}`]),
    );
  });

  it('closes on a typed ], so the next Enter starts a line', async () => {
    const { editor } = await openEditor();
    await type(editor, ' [[x');
    await waitFor(() => expect(rows()).toEqual(['# New page', 'Create "x"']));
    await type(editor, ']');
    await waitFor(menuClosed);
  });

  it('ends @ on a Create row where a word starts, and links what it made', async () => {
    vi.mocked(createLinkedPage).mockResolvedValue('retro-memo.md');
    const { editor } = await openEditor();
    await type(editor, ' @Retro memo');
    await waitFor(() => expect(rows()).toEqual(['# New page', 'Create "Retro memo"']));
    pick('Create "Retro memo"');
    expect(createLinkedPage).toHaveBeenCalledWith('Retro memo');
    await waitFor(() => expect(inline(editor)).toEqual(['Plain. ', '[[retro-memo]]', ' ']));
  });

  it('offers no Create row for an @ inside a word, or one a space follows', async () => {
    const { editor } = await openEditor();
    await type(editor, ' ana@ex');
    await waitFor(() => expect(rows()).toEqual(['# Due date', 'Due next week']));
    await type(editor, ' @ 5pm');
    await waitFor(() =>
      expect(rows()).toEqual([`# ${editor.dictionary.suggestion_menu.no_items_title}`]),
    );
  });

  // BlockNote closes a menu four characters past its last query with rows. A
  // Create row on every query kept the `@` menu open to the end of the line,
  // and its Enter made a page of the sentence.
  it.each([' Ask @dana about the launch plan', ' Ping @alex when done', ' Hi @dana, see'])(
    'lets the @ menu close on a sentence, so Enter after %j starts a line',
    async (sentence) => {
      const { editor } = await openEditor();
      await type(editor, sentence);
      await waitFor(menuClosed);
      act(() => {
        fireEvent.keyDown(editor.prosemirrorView.dom, { key: 'Enter' });
      });
      await type(editor, 'next line');
      expect(createLinkedPage).not.toHaveBeenCalled();
      expect(inline(editor)).toEqual([`Plain.${sentence}`]);
      expect(editor.document[1].content).toEqual([{ type: 'text', text: 'next line', styles: {} }]);
    },
  );

  it('links where the caret was when the page lands, ahead of what was typed since', async () => {
    const land = deferCreate();
    const { editor } = await openEditor();
    await type(editor, ' [[Launch notes');
    await waitFor(() => expect(rows()).toContain('Create "Launch notes"'));
    pick('Create "Launch notes"');
    await waitFor(menuClosed);
    await type(editor, 'X');
    await land('launch-notes.md');
    expect(inline(editor)).toEqual(['Plain. ', '[[launch-notes]]', ' X']);
  });

  it('puts back what was typed, and links nothing, when the page cannot be made', async () => {
    const land = deferCreate();
    const { editor } = await openEditor();
    await type(editor, ' [[Launch notes');
    await waitFor(() => expect(rows()).toContain('Create "Launch notes"'));
    pick('Create "Launch notes"');
    await waitFor(menuClosed);
    expect(inline(editor)).toEqual(['Plain. ']);
    await land(null);
    expect(inline(editor)).toEqual(['Plain. [[Launch notes']);
    // createLinkedPage toasts its own failure; the editor adds nothing.
    expect(toast).not.toHaveBeenCalled();
  });

  it('inserts nothing, and throws nothing, when the editor is gone before the page lands', async () => {
    const land = deferCreate();
    const { editor, unmount } = await openEditor();
    await type(editor, ' [[Launch notes');
    await waitFor(() => expect(rows()).toContain('Create "Launch notes"'));
    pick('Create "Launch notes"');
    unmount();
    await land('launch-notes.md');
    expect(JSON.stringify(editor.document)).not.toContain('wikilink');
    expect(toast).not.toHaveBeenCalled();
  });
});
