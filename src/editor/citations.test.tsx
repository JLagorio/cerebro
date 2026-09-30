// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEntry } from '@/engine/testHelpers';
import { resetMockFs } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import {
  citationChoices,
  citationName,
  citationNumber,
  indexCitations,
  sourceTarget,
} from './citations';
import { blocksToMarkdown } from './markdown';
import { MarkdownEditor, type CerebroEditor, type EditorReadyInfo } from './MarkdownEditor';
import { NoteBodyEditor } from './NoteBodyEditor';

const { open } = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/app/useOpenPath', () => ({ useOpenPath: () => open }));

const cite = (id: string, def = '') => ({ type: 'citation', props: { id, def } });
const text = (t: string) => ({ type: 'text', text: t, styles: {} });

describe('indexCitations', () => {
  it('reads definitions and first references in document order, each definition to the end of its line', () => {
    const index = indexCitations([
      { type: 'paragraph', content: [text('A'), cite('b'), text(' B'), cite('a'), cite('b')] },
      {
        type: 'paragraph',
        content: [cite('a', '1'), text(' The a source\n'), cite('c', '1'), text(' The c source')],
      },
    ]);
    expect(index.cited).toEqual(['b', 'a']);
    expect(index.defined).toEqual(['a', 'c']);
    expect(index.definitions.get('a')).toBe('The a source');
    expect(index.definitions.get('c')).toBe('The c source');
  });

  it('reaches nested blocks and table cells, in both shapes a cell comes in', () => {
    const index = indexCitations([
      {
        type: 'table',
        content: {
          type: 'tableContent',
          rows: [{ cells: [[cite('partial')], { type: 'tableCell', content: [cite('full')] }] }],
        },
      },
      {
        type: 'bulletListItem',
        content: [],
        children: [{ type: 'paragraph', content: [cite('deep')] }],
      },
    ]);
    expect(index.cited).toEqual(['partial', 'full', 'deep']);
  });
});

describe('citationNumber', () => {
  const index = indexCitations([
    { type: 'paragraph', content: [cite('stray'), cite('b'), cite('a'), cite('listed')] },
    { type: 'paragraph', content: [cite('b', '1'), text(' B\n'), cite('a', '1'), text(' A')] },
  ]);

  it('numbers a listed source by its place in the frontmatter, id-less entries counted', () => {
    const sources = [{ id: null }, { id: 'listed' }];
    expect(citationNumber('listed', sources, index)).toBe(2);
  });

  it('numbers everything else after the listed sources: definitions first, then first references', () => {
    const sources = [{ id: null }, { id: 'listed' }];
    expect(citationNumber('b', sources, index)).toBe(3);
    expect(citationNumber('a', sources, index)).toBe(4);
    expect(citationNumber('stray', sources, index)).toBe(5);
  });

  it('numbers an ordinary page with no sources 1, 2, 3', () => {
    expect(['b', 'a', 'stray', 'listed'].map((id) => citationNumber(id, [], index))).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('has no number for an id the page never mentions', () => {
    expect(citationNumber('elsewhere', [], index)).toBeNull();
  });
});

describe('citationName and citationChoices', () => {
  const index = indexCitations([
    { type: 'paragraph', content: [cite('listed'), cite('loose'), cite('defined')] },
    { type: 'paragraph', content: [cite('defined', '1'), text(' As the page puts it')] },
  ]);
  const sources = [
    { id: null, resource: 'https://example.com/unkeyed', title: 'Unkeyed' },
    { id: 'listed', resource: '/records/first.md', title: null },
    { id: 'unused', resource: 'all telemetry in eu-west', title: null },
  ];
  const entries = [{ path: 'records/first.md', title: 'First record' }];

  it('names a source the way the chip does — listed title, definition, page, resource, or missing', () => {
    expect(citationName('listed', sources, index, entries)).toBe('First record');
    expect(citationName('unused', sources, index, entries)).toBe('all telemetry in eu-west');
    expect(citationName('defined', sources, index, entries)).toBe('As the page puts it');
    expect(citationName('loose', sources, index, entries)).toBe('No source "loose"');
  });

  /* An id-less source cannot be cited, but it holds its number: leaving it
     out must not renumber the ones after it. */
  it('offers the listed sources, then what the page already uses, in number order', () => {
    expect(citationChoices(sources, index, entries)).toEqual([
      { id: 'listed', number: 2, name: 'First record' },
      { id: 'unused', number: 3, name: 'all telemetry in eu-west' },
      { id: 'defined', number: 4, name: 'As the page puts it' },
      { id: 'loose', number: 5, name: 'No source "loose"' },
    ]);
  });
});

describe('sourceTarget', () => {
  const entries = [{ path: 'records/first.md' }];

  it('decides it the way the Sources list does', () => {
    expect(sourceTarget('https://example.com/x', entries)).toEqual({
      external: 'https://example.com/x',
    });
    expect(sourceTarget('/records/first.md', entries)).toEqual({ internal: 'records/first.md' });
    expect(sourceTarget('/records/missing.md', entries)).toBeNull();
    expect(sourceTarget('all sync telemetry in eu-west', entries)).toBeNull();
  });
});

/**
 * The chip on screen (M51.5).
 *
 * The frontmatter lists the sources in the OPPOSITE order to the page's own
 * definitions, so the two ways of counting give different numbers and a test
 * can tell which one the chip used. That is also what proves the note's path
 * reaches the chip at all: BlockNote renders inline content through portals,
 * and only the frontmatter answer needs the context NoteBodyEditor provides.
 */
const CONCEPT = 'knowledge/metrics/sample.md';
const SOURCES = [
  { id: 'second', resource: 'https://example.com/second', title: 'The second source' },
  { id: 'first', resource: '/records/first.md', title: 'The first source' },
];
const BODY =
  'Alpha.[^first] Beta.[^second] Gamma.[^loose]\n\n' +
  '[^first]: First, as the page puts it\n' +
  '[^second]: Second, as the page puts it\n';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;

const chips = (kind: 'ref' | 'def') =>
  [...document.querySelectorAll<HTMLElement>(`[data-citation="${kind}"]`)].map((el) => ({
    id: el.dataset.id,
    label: el.textContent,
    title: el.getAttribute('title'),
    tag: el.tagName,
  }));

describe('the citation chip', () => {
  beforeEach(() => {
    resetMockFs();
    open.mockReset();
    fs().set(
      CONCEPT,
      `---\ntype: Metric\ntitle: Sample\nsources:\n${SOURCES.map(
        (s) => `  - id: ${s.id}\n    resource: ${s.resource}\n    title: ${s.title}\n`,
      ).join('')}---\n\n${BODY}`,
    );
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entries: [
        makeEntry({
          path: CONCEPT,
          filename: 'sample.md',
          type: 'Metric',
          properties: { sources: SOURCES },
        }),
        makeEntry({ path: 'records/first.md', filename: 'first.md', title: 'First record' }),
      ],
      status: 'ready',
      error: null,
    });
  });
  afterEach(cleanup);

  it("numbers a concept's citations by its frontmatter sources, as its Sources list does", async () => {
    render(<NoteBodyEditor path={CONCEPT} />);
    await waitFor(() => expect(chips('ref')).toHaveLength(3));
    expect(chips('ref').map((c) => [c.id, c.label])).toEqual([
      ['first', '2'],
      ['second', '1'],
      // Neither listed nor defined: counted after the listed sources.
      ['loose', '3'],
    ]);
    expect(chips('def').map((c) => [c.id, c.label])).toEqual([
      ['first', '2'],
      ['second', '1'],
    ]);
    // Named as the Sources list names it, over the marker the number stands in for.
    expect(chips('ref').map((c) => c.title)).toEqual([
      'The first source\n[^first]',
      'The second source\n[^second]',
      'No source "loose"\n[^loose]',
    ]);
    expect(chips('def').map((c) => c.title)).toEqual([
      'The first source\n[^first]:',
      'The second source\n[^second]:',
    ]);
  });

  // editor.css reads a paragraph that opens with one as the sources list.
  it("marks a definition's badge, and only a definition's, for the sources style", async () => {
    render(<NoteBodyEditor path={CONCEPT} />);
    await waitFor(() => expect(chips('ref')).toHaveLength(3));
    const hooked = [...document.querySelectorAll<HTMLElement>('.cb-citation-def')];
    expect(hooked.map((el) => el.dataset.citation)).toEqual(['def', 'def']);
    expect(hooked[0].parentElement?.classList.contains('bn-inline-content-section')).toBe(true);
  });

  it('opens a vault source as a page and an outside one in a new tab', async () => {
    render(<NoteBodyEditor path={CONCEPT} />);
    await waitFor(() => expect(chips('ref')).toHaveLength(3));
    const [first, second, loose] = document.querySelectorAll<HTMLElement>('[data-citation="ref"]');
    expect(second.tagName).toBe('A');
    expect(second.getAttribute('href')).toBe('https://example.com/second');
    expect(second.getAttribute('target')).toBe('_blank');
    expect(second.getAttribute('rel')).toBe('noreferrer noopener');
    expect(first.tagName).toBe('BUTTON');
    fireEvent.click(first);
    expect(open).toHaveBeenCalledWith('records/first.md');
    // A citation that leads nowhere is still shown — muted, not hidden.
    expect(loose.tagName).toBe('SPAN');
    expect(loose.className).toContain('bg-n-100');
  });

  it('numbers by the page itself where there is no note to read sources from', async () => {
    const onReady = vi.fn<(info: EditorReadyInfo) => void>();
    render(<MarkdownEditor markdown={BODY} onChange={vi.fn()} onReady={onReady} />);
    await waitFor(() => expect(chips('ref')).toHaveLength(3));
    expect(chips('ref').map((c) => [c.id, c.label, c.title])).toEqual([
      ['first', '1', 'First, as the page puts it\n[^first]'],
      ['second', '2', 'Second, as the page puts it\n[^second]'],
      ['loose', '3', 'No source "loose"\n[^loose]'],
    ]);
  });

  it('renumbers when an edit changes what the page defines', async () => {
    const onReady = vi.fn<(info: EditorReadyInfo) => void>();
    render(
      <MarkdownEditor
        markdown={'One[^x] two[^y].\n\n[^y]: Why\n[^x]: Ex\n'}
        onChange={vi.fn()}
        onReady={onReady}
      />,
    );
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    await waitFor(() => expect(chips('ref').map((c) => c.label)).toEqual(['2', '1']));
    const { editor } = onReady.mock.calls[0][0];
    const definitions = editor.document.find((b) =>
      JSON.stringify(b.content).includes('"def":"1"'),
    );
    editor.removeBlocks([definitions!]);
    // No definitions left: first reference decides.
    await waitFor(() => expect(chips('ref').map((c) => c.label)).toEqual(['1', '2']));
  });
});

/**
 * The `[^` menu (M52.1), driven the way a keyboard drives it: each character
 * offered to the editor's text-input handlers, so the `[` opens BlockNote's
 * link menu for real and the `^` is what turns it into this one.
 */
describe('the [^ menu', () => {
  beforeEach(() => {
    resetMockFs();
    fs().set(
      CONCEPT,
      `---\ntype: Metric\ntitle: Sample\nsources:\n${SOURCES.map(
        (s) => `  - id: ${s.id}\n    resource: ${s.resource}\n    title: ${s.title}\n`,
      ).join('')}---\n\n${BODY}`,
    );
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entries: [
        makeEntry({
          path: CONCEPT,
          filename: 'sample.md',
          type: 'Metric',
          properties: { sources: SOURCES },
        }),
        makeEntry({ path: 'records/first.md', filename: 'first.md', title: 'First record' }),
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

  async function openConcept(): Promise<CerebroEditor> {
    const onReady = vi.fn<(info: EditorReadyInfo) => void>();
    render(<NoteBodyEditor path={CONCEPT} onReady={onReady} />);
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    const { editor } = onReady.mock.calls[0][0];
    // Ready fires as the view mounts, before its menus have registered their
    // triggers; the chips rendering is the view having committed.
    await waitFor(() => expect(chips('ref')).toHaveLength(3));
    editor.setTextCursorPosition(editor.document[0], 'end');
    return editor;
  }

  it("offers the note's sources by the numbers its chips show, then what the page cites besides", async () => {
    const editor = await openConcept();
    await type(editor, ' [^');
    await waitFor(() =>
      expect(rows()).toEqual([
        '# Cite a source',
        '1 · The second source',
        '2 · The first source',
        '3 · No source "loose"',
      ]),
    );
    // The query reads the id as well as the name.
    await type(editor, 'fir');
    await waitFor(() => expect(rows()).toEqual(['# Cite a source', '2 · The first source']));
  });

  it('inserts the chosen source as a citation chip, and the file gets its marker', async () => {
    const editor = await openConcept();
    await type(editor, ' [^');
    await waitFor(() => expect(rows()).toContain('2 · The first source'));
    const option = [
      ...document.querySelectorAll<HTMLElement>('#bn-suggestion-menu [role=option]'),
    ].find((el) => el.textContent?.includes('The first source'));
    fireEvent.click(option!);
    await waitFor(() => expect(document.querySelector('#bn-suggestion-menu')).toBeNull());
    expect(await blocksToMarkdown(editor)).toMatch(
      /^Alpha\.\[\^first\] .* Gamma\.\[\^loose\] \[\^first\]\n/,
    );
  });

  /* BlockNote keys a menu row by its title. Two pages sharing one left a
     stale link row behind when `^` swapped the list — measured in the app, a
     "Knowledge" page offered as a source to cite. */
  it('leaves no row of the link menu behind when two pages share a title', async () => {
    const twin = (dir: string) =>
      makeEntry({ path: `${dir}/twin.md`, filename: 'twin.md', title: 'Twin' });
    useVaultStore.setState({
      entries: [...useVaultStore.getState().entries, twin('a'), twin('b')],
    });
    const editor = await openConcept();
    await type(editor, ' [');
    await waitFor(() =>
      expect(rows().filter((r) => r.replaceAll('\u200B', '') === 'Twin')).toHaveLength(2),
    );
    await type(editor, '^');
    await waitFor(() =>
      expect(rows()).toEqual([
        '# Cite a source',
        '1 · The second source',
        '2 · The first source',
        '3 · No source "loose"',
      ]),
    );
  });

  /* The page has nothing to cite: an open menu would swallow Enter and hold
     the `]` the author is about to type, so it closes — and `[[` is still the
     link menu it always was. */
  it('closes on a page with nothing to cite, and leaves [[ the link menu', async () => {
    const onReady = vi.fn<(info: EditorReadyInfo) => void>();
    render(<MarkdownEditor markdown={'Plain.\n'} onChange={vi.fn()} onReady={onReady} />);
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    const { editor } = onReady.mock.calls[0][0];
    await waitFor(() => expect(document.querySelector('.bn-editor')?.textContent).toBe('Plain.'));
    editor.setTextCursorPosition(editor.document[0], 'end');
    await type(editor, ' [');
    await waitFor(() => expect(rows()[0]).toBe('# Link page'));
    await type(editor, '^');
    await waitFor(() => expect(document.querySelector('#bn-suggestion-menu')).toBeNull());
    await type(editor, 'x]');
    // The marker still closed into a chip: the menu gave the `]` back.
    expect(JSON.stringify(editor.document)).toContain(
      '"type":"citation","props":{"id":"x","def":""}',
    );
    await type(editor, ' [[');
    await waitFor(() => expect(rows()).toContain('First record'));
  });
});
