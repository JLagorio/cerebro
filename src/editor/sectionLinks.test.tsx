// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEntry } from '@/engine/testHelpers';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { MarkdownEditor, type CerebroEditor, type EditorReadyInfo } from './MarkdownEditor';
import { NotePathContext } from './notePath';
import { SECTION_FLASH_MS, SectionFlash } from './SectionFlash';
import {
  __resetSectionLinks,
  findSectionBlock,
  requestSection,
  revealBlock,
  SECTION_REQUEST_TTL_MS,
  watchSections,
  type SectionSourceBlock,
} from './sectionLinks';

/**
 * Section links (M55.8): `[[page#Heading]]` opens its page on the heading.
 * jsdom has no layout, so these hold the wiring: who asks, who answers, what
 * the chip says and what the menu inserts. Where the heading lands on screen,
 * and the highlight over it, are e2e/section-links.spec.ts's.
 */

afterEach(() => {
  __resetSectionLinks();
});

describe('the section request registry', () => {
  it('delivers a waiting request once, to the first watcher of its path', () => {
    requestSection('a.md', 'Risks', 1_000);
    const first = vi.fn();
    const second = vi.fn();
    watchSections('a.md', first, 1_500)();
    watchSections('a.md', second, 1_600)();
    expect(first).toHaveBeenCalledExactlyOnceWith('Risks');
    expect(second).not.toHaveBeenCalled();
  });

  it("leaves another path's request waiting", () => {
    requestSection('a.md', 'Risks', 1_000);
    const other = vi.fn();
    watchSections('b.md', other, 1_000)();
    expect(other).not.toHaveBeenCalled();
    const mine = vi.fn();
    watchSections('a.md', mine, 1_000)();
    expect(mine).toHaveBeenCalledWith('Risks');
  });

  it('keeps only the newest request', () => {
    requestSection('a.md', 'Old', 1_000);
    requestSection('b.md', 'New', 1_001);
    const a = vi.fn();
    watchSections('a.md', a, 1_002)();
    expect(a).not.toHaveBeenCalled();
  });

  it('never delivers a request past its TTL', () => {
    requestSection('a.md', 'Risks', 1_000);
    const late = vi.fn();
    watchSections('a.md', late, 1_000 + SECTION_REQUEST_TTL_MS + 1)();
    expect(late).not.toHaveBeenCalled();
    // Taken and dropped, not left for the next watcher either.
    const later = vi.fn();
    watchSections('a.md', later, 1_001)();
    expect(later).not.toHaveBeenCalled();
  });

  it('delivers live to every watcher and leaves nothing waiting', () => {
    const one = vi.fn();
    const two = vi.fn();
    const stopOne = watchSections('a.md', one);
    const stopTwo = watchSections('a.md', two);
    requestSection('a.md', 'Risks');
    expect(one).toHaveBeenCalledExactlyOnceWith('Risks');
    expect(two).toHaveBeenCalledExactlyOnceWith('Risks');
    stopOne();
    stopTwo();
    const after = vi.fn();
    watchSections('a.md', after)();
    expect(after).not.toHaveBeenCalled();
  });

  it('stops delivering once unsubscribed', () => {
    const listener = vi.fn();
    watchSections('a.md', listener)();
    requestSection('a.md', 'Risks');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('findSectionBlock', () => {
  const text = (t: string) => ({ type: 'text', text: t, styles: {} });
  const heading = (id: string, ...content: unknown[]): SectionSourceBlock => ({
    id,
    type: 'heading',
    content,
    children: [],
  });
  const paragraph = (id: string, t: string): SectionSourceBlock => ({
    id,
    type: 'paragraph',
    content: [text(t)],
    children: [],
  });

  it('finds a top-level heading', () => {
    expect(findSectionBlock([paragraph('p', 'x'), heading('h', text('Risks'))], 'Risks')).toBe('h');
  });

  it('finds a heading inside a column', () => {
    const columns: SectionSourceBlock = {
      id: 'cols',
      type: 'columnList',
      children: [
        { id: 'c1', type: 'column', children: [paragraph('p', 'left')] },
        { id: 'c2', type: 'column', children: [heading('h', text('Rollback'))] },
      ],
    };
    expect(findSectionBlock([columns], 'Rollback')).toBe('h');
  });

  it('ignores case and spacing', () => {
    expect(findSectionBlock([heading('h', text('  Open   questions '))], 'open questions')).toBe(
      'h',
    );
  });

  it('takes the first of two', () => {
    expect(
      findSectionBlock([heading('a', text('Notes')), heading('b', text('Notes'))], 'Notes'),
    ).toBe('a');
  });

  it('ignores a paragraph with the same text', () => {
    expect(findSectionBlock([paragraph('p', 'Risks')], 'Risks')).toBeNull();
  });

  it('is null with no match, or nothing asked', () => {
    expect(findSectionBlock([heading('h', text('Risks'))], 'Rollback')).toBeNull();
    expect(findSectionBlock([heading('h', text('Risks'))], '  ')).toBeNull();
  });

  it('reads a heading without its chips, as the outline does', () => {
    const withChip = heading('h', text('Plan for '), {
      type: 'wikilink',
      props: { target: 'atlas', alias: '' },
    });
    expect(findSectionBlock([withChip], 'Plan for')).toBe('h');
    expect(findSectionBlock([withChip], 'Plan for atlas')).toBeNull();
  });
});

describe('revealBlock', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  /** A closed toggle holding `inner`, in the shape BlockNote renders it. */
  const toggle = (id: string, inner: string, opened: string[]) => {
    const html = `
      <div class="bn-block" data-id="${id}">
        <div class="bn-block-content"><div><div class="bn-toggle-wrapper" data-show-children="false">
          <button class="bn-toggle-button"></button><p>Summary</p>
        </div></div></div>
        <div class="bn-block-group"><div class="bn-block-outer">${inner}</div></div>
      </div>`;
    queueMicrotask(() => {
      const button = document.querySelector(`[data-id="${id}"] .bn-toggle-button`);
      button?.addEventListener('click', () => {
        opened.push(id);
        button.parentElement?.setAttribute('data-show-children', 'true');
      });
    });
    return html;
  };

  it('opens the closed toggles around a heading, outermost first, then scrolls to it', async () => {
    const opened: string[] = [];
    const host = document.createElement('div');
    host.innerHTML = toggle(
      'outer',
      toggle(
        'inner',
        '<div class="bn-block" data-id="h"><div class="bn-block-content"></div></div>',
        opened,
      ),
      opened,
    );
    document.body.append(host);
    await Promise.resolve();
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    const done = vi.fn();
    revealBlock(host, 'h', 0, done);
    expect(opened).toEqual(['outer', 'inner']);
    expect(scroll).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
    expect(scroll.mock.contexts[0]).toBe(host.querySelector('[data-id="h"]'));
    expect(done).toHaveBeenCalledWith(true);
    scroll.mockRestore();
  });

  it('gives up when the block never mounts', () => {
    const done = vi.fn();
    revealBlock(document.createElement('div'), 'missing', 0, done);
    expect(done).toHaveBeenCalledWith(false);
  });
});

describe('SectionFlash', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('calls onDone after SECTION_FLASH_MS', () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    host.innerHTML =
      '<div class="bn-block" data-id="h"><div class="bn-block-content">Rollback</div></div>';
    document.body.append(host);
    const onDone = vi.fn();
    render(<SectionFlash hostRef={{ current: host }} blockId="h" onDone={onDone} />);
    expect(document.querySelector('[data-testid="section-flash"]')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(SECTION_FLASH_MS - 1);
    });
    expect(onDone).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('draws nothing when the block is gone', () => {
    const host = document.createElement('div');
    render(<SectionFlash hostRef={{ current: host }} blockId="gone" onDone={vi.fn()} />);
    expect(document.querySelector('[data-testid="section-flash"]')).toBeNull();
  });
});

describe('section links in the editor', () => {
  const MAP = 'strategy/systems-map.md';
  const SCHEDULE = 'delivery/how-we-schedule.md';
  const MAP_MD = '# Systems map\n\nIntro.\n\n## Rollback\n\nSteps.\n';
  const toast = vi.fn();
  const scroll = vi.fn();

  beforeEach(() => {
    toast.mockReset();
    scroll.mockReset();
    useUiStore.setState({ toast });
    useNavStore.setState({
      selection: { kind: 'doc', path: SCHEDULE },
      history: [{ kind: 'doc', path: SCHEDULE }],
      historyIndex: 0,
    });
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entries: [
        makeEntry({
          path: MAP,
          filename: 'systems-map.md',
          folder: 'strategy',
          title: 'Systems map',
        }),
        makeEntry({
          path: SCHEDULE,
          filename: 'how-we-schedule.md',
          folder: 'delivery',
          title: 'How we schedule',
        }),
      ],
      status: 'ready',
      error: null,
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      ...{ x: 0, y: 40, width: 600, height: 30, top: 40, left: 0, right: 600, bottom: 70 },
      toJSON: () => ({}),
    });
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (
      this: Element,
      arg?: boolean | ScrollIntoViewOptions,
    ) {
      scroll(this, arg);
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  async function openNote(path: string, markdown: string, onChange = vi.fn()) {
    const onReady = vi.fn<(info: EditorReadyInfo) => void>();
    const view = render(
      <NotePathContext.Provider value={path}>
        <MarkdownEditor
          markdown={markdown}
          onChange={onChange}
          onReady={onReady}
          debounceMs={60_000}
        />
      </NotePathContext.Provider>,
    );
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    const { editor } = onReady.mock.calls[0][0];
    await waitFor(() => expect(document.querySelector('.bn-editor')).not.toBeNull());
    return { editor, view };
  }

  const chip = () => {
    const found = document.querySelector<HTMLElement>('[data-chip="wikilink"]');
    if (found === null) throw new Error('no wikilink chip');
    return found;
  };

  const headingId = (editor: CerebroEditor, text: string) =>
    editor.document.find(
      (b) =>
        b.type === 'heading' &&
        (b.content as { text?: string }[]).map((c) => c.text ?? '').join('') === text,
    )?.id;

  const scrolledTo = () => scroll.mock.calls.map(([el]) => (el as Element).getAttribute('data-id'));

  /** Hover a chip until its preview card opens (M59.7). Each hover lands
   * somewhere new: the card opens only for a real move. */
  let at = 40;
  const hoverCard = async () => {
    at += 3;
    act(() => {
      chip().dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, screenX: at, screenY: at }),
      );
    });
    return waitFor(() => {
      const card = document.querySelector<HTMLElement>('[data-testid="hover-card"]');
      if (card === null) throw new Error('no hover card');
      return card;
    });
  };

  it('labels a section link Title › Heading, and its card names the page and heading', async () => {
    await openNote(SCHEDULE, 'Before a release, read [[systems-map#Rollback]].\n');
    await waitFor(() => expect(chip().textContent).toBe('Systems map › Rollback'));
    expect(chip().hasAttribute('title')).toBe(false);
    const card = await hoverCard();
    expect(card.querySelector('[data-testid="page-preview-title"]')?.textContent).toBe(
      'Systems map › Rollback',
    );
    expect(card.querySelector('[data-testid="page-preview-path"]')?.textContent).toBe(MAP);
  });

  it('jumps within the page for [[#Heading]], lights the heading, and does not navigate', async () => {
    const { editor } = await openNote(MAP, `${MAP_MD}\nSee [[#Rollback]].\n`);
    await waitFor(() => expect(chip().textContent).toBe('Systems map › Rollback'));
    fireEvent.click(chip());
    const id = headingId(editor, 'Rollback');
    await waitFor(() => expect(scrolledTo()).toEqual([id]));
    expect(scroll.mock.calls[0][1]).toEqual({ block: 'start', behavior: 'smooth' });
    await waitFor(() =>
      expect(document.querySelector('[data-testid="section-flash"]')).not.toBeNull(),
    );
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: SCHEDULE });
    expect(toast).not.toHaveBeenCalled();
  });

  it('takes a request made before it mounted, once its blocks are in', async () => {
    requestSection(MAP, 'rollback');
    const { editor } = await openNote(MAP, MAP_MD);
    await waitFor(() => expect(scrolledTo()).toEqual([headingId(editor, 'Rollback')]));
  });

  it('says so when the page has no such heading, and stays where it is', async () => {
    requestSection(MAP, 'Postmortem');
    await openNote(MAP, MAP_MD);
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('No heading named "Postmortem" on this page'),
    );
    expect(scroll).not.toHaveBeenCalled();
  });

  it('opens the page a cross-page chip names and leaves it the request', async () => {
    await openNote(SCHEDULE, 'Before a release, read [[systems-map#Rollback]].\n');
    await waitFor(() => expect(chip().textContent).toBe('Systems map › Rollback'));
    fireEvent.click(chip());
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: MAP });
    const taken = vi.fn();
    watchSections(MAP, taken)();
    expect(taken).toHaveBeenCalledWith('Rollback');
  });

  it('dangles a section link whose page names nothing, naming the page half', async () => {
    await openNote(SCHEDULE, 'See [[nothing#X]].\n');
    await waitFor(() => expect(chip().textContent).toBe('nothing#X'));
    const card = await hoverCard();
    expect(card.textContent).toBe('No page named "nothing"');
    fireEvent.click(chip());
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: SCHEDULE });
  });

  it('keeps the fragment through the unmount flush', async () => {
    const onChange = vi.fn();
    const markdown = 'Read [[systems-map#Rollback|the rollback]] and [[#Steps]].\n';
    const { editor, view } = await openNote(SCHEDULE, markdown, onChange);
    const last = editor.document[editor.document.length - 1];
    editor.insertBlocks([{ type: 'paragraph', content: 'last words' }], last, 'after');
    view.unmount();
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0][0]).toBe(`${markdown}\nlast words\n`);
  });

  describe('the [[ menu', () => {
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
      [...document.querySelectorAll('#bn-suggestion-menu [role=option]')].map(
        (el) => el.querySelector('.bn-mt-suggestion-menu-item-title')?.textContent ?? '',
      );

    const pick = (title: string) => {
      const option = [
        ...document.querySelectorAll<HTMLElement>('#bn-suggestion-menu [role=option]'),
      ].find((el) => el.querySelector('.bn-mt-suggestion-menu-item-title')?.textContent === title);
      if (option === undefined) throw new Error(`no row "${title}" in ${JSON.stringify(rows())}`);
      fireEvent.click(option);
    };

    const links = (editor: CerebroEditor) =>
      (editor.document[0].content as { type: string; props?: { target?: string } }[])
        .filter((node) => node.type === 'wikilink')
        .map((node) => node.props?.target);

    async function ready(path: string) {
      const opened = await openNote(path, 'Plain.\n');
      await waitFor(() => expect(document.querySelector('.bn-editor')?.textContent).toBe('Plain.'));
      opened.editor.setTextCursorPosition(opened.editor.document[0], 'end');
      return opened.editor;
    }

    it('links a page by its stem and the heading typed after #', async () => {
      const editor = await ready(SCHEDULE);
      await type(editor, ' [[systems#Rollback');
      await waitFor(() => expect(rows()).toEqual(['Systems map']));
      pick('Systems map');
      await waitFor(() => expect(links(editor)).toEqual(['systems-map#Rollback']));
      expect(editor.document[0].content).not.toContainEqual(
        expect.objectContaining({ type: 'text', text: expect.stringContaining('[') }),
      );
    });

    it('offers this page its own heading for [[#Heading', async () => {
      const editor = await ready(MAP);
      await type(editor, ' [[#Rollback');
      await waitFor(() => expect(rows()).toEqual(['Systems map › Rollback']));
      pick('Systems map › Rollback');
      await waitFor(() => expect(links(editor)).toEqual(['#Rollback']));
    });
  });
});
