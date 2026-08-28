// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetMockFs } from '@/lib/mockIpc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { DocPage } from './DocPage';

const DOC = 'projects/guided-onboarding-ga/meetings/kickoff.md';
const DOC_FOLDER = 'projects/guided-onboarding-ga/spec';
const DOC_MAIN = `${DOC_FOLDER}/spec.md`;
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;

describe('DocPage', () => {
  beforeEach(async () => {
    resetMockFs();
    await useVaultStore.getState().openVault('/demo-vault');
    useNavStore.setState({
      selection: { kind: 'doc', path: DOC },
      history: [{ kind: 'home' }],
      historyIndex: 0,
    });
    useUiStore.setState({ docPanelOpen: true, docPanelTab: 'outline' });
  });
  afterEach(cleanup);

  it('shows the breadcrumb bar, title, editor, and outline panel', async () => {
    render(<DocPage selection={{ kind: 'doc', path: DOC }} />);
    const entry = useVaultStore.getState().entries.find((e) => e.path === DOC);
    expect(screen.getByTestId('doc-title').textContent).toBe(entry?.title);
    // Breadcrumb: folder segments render as humanized crumbs.
    expect(screen.getByText('Meetings')).toBeTruthy();
    // M38.2: the kickoff note is `type: Meeting` — a record — so its crumb
    // roots at its backdrop (the type screen), not at Docs, which never
    // owned it.
    fireEvent.click(screen.getByRole('button', { name: 'Meeting' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'type', name: 'Meeting' });
    await waitFor(() => expect(screen.getByTestId('markdown-editor')).toBeTruthy(), {
      timeout: 5_000,
    });
    // The side panel's Outline tab fills once the editor is ready.
    await waitFor(() => expect(screen.getByTestId('doc-outline')).toBeTruthy(), {
      timeout: 5_000,
    });
  });

  // M38.2 — a record is a page too: the peek's property surface renders on
  // the page canvas, and the crumb roots at the record's backdrop rather
  // than at Docs, which never owned it.
  it('renders a record as a page: properties above the body, backdrop crumb', async () => {
    const entries = useVaultStore.getState().entries;
    const record = entries.find((e) => e.type === 'Work item');
    if (record === undefined) throw new Error('fixture vault has no Work item');
    render(<DocPage selection={{ kind: 'doc', path: record.path }} />);
    expect(screen.getByTestId('page-properties')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Docs' })).toBeNull();
    cleanup();

    // And a DOC keeps its document form: no property surface conjured for it.
    const doc = entries.find(
      (e) => (e.type === null || e.type === '') && !e.path.startsWith('knowledge/'),
    );
    if (doc === undefined) throw new Error('fixture vault has no untyped doc');
    render(<DocPage selection={{ kind: 'doc', path: doc.path }} />);
    expect(screen.queryByTestId('page-properties')).toBeNull();
    // M38.3: the crumb root is a plain 'Pages' label — the Docs surface it
    // used to navigate to is gone, and the nav's tree is the way up.
    expect(screen.getByText('Pages')).toBeTruthy();
  });

  // M44.5 — the record page swaps content by tab; the tab rides the selection.
  describe('record tabs', () => {
    const TYPE_DOC = 'types/work-item.md';
    const DOC_UNTYPED = 'inbox/welcome.md';

    // M45.2 amendment (docs/superpowers/plans/2026-08-28-m45.2-layout-editor-shell.md
    // Task 5): the strip needs SAVED tabs now, so the fixture declares them —
    // the case keeps asserting that a record page shows its type's tabs.
    it("a record page shows its type tabs, and Overview is today's layout (M44.5)", async () => {
      const typeDoc = fs().get(TYPE_DOC);
      if (typeDoc === undefined) throw new Error('fixture vault has no Work item Type doc');
      fs().set(
        TYPE_DOC,
        typeDoc.replace(
          '\n---\n',
          '\ntabs:\n  - { id: overview, name: Overview, content: overview }\n---\n',
        ),
      );
      await useVaultStore.getState().rescan();
      const record = useVaultStore.getState().entries.find((e) => e.type === 'Work item');
      if (record === undefined) throw new Error('fixture vault has no Work item');
      render(<DocPage selection={{ kind: 'doc', path: record.path }} />);
      expect(screen.getByTestId('record-tabs')).toBeTruthy();
      expect(screen.getByTestId('page-properties')).toBeTruthy();
    });

    // M45.2 (docs/superpowers/plans/2026-08-28-m45.2-layout-editor-shell.md
    // Task 5): Simple means NO strip — a type that declares no `tabs:` renders
    // no strip at all; the synthesized Overview drives only the content swap.
    it('a type with no saved tabs renders no strip (M45.2)', async () => {
      const entries = useVaultStore.getState().entries;
      const record = entries.find((e) => e.type === 'Work item');
      if (record === undefined) throw new Error('fixture vault has no Work item');
      render(<DocPage selection={{ kind: 'doc', path: record.path }} />);
      expect(screen.queryByTestId('record-tabs')).toBeNull();
      // The synthesized Overview still runs the canvas: properties render.
      expect(screen.getByTestId('page-properties')).toBeTruthy();
    });

    it('an untyped doc has no tab bar (M44.5)', async () => {
      render(<DocPage selection={{ kind: 'doc', path: DOC_UNTYPED }} />);
      expect(screen.queryByTestId('record-tabs')).toBeNull();
    });

    it('a sections tab swaps the canvas and the selection carries it (M44.5)', async () => {
      const typeDoc = fs().get(TYPE_DOC);
      if (typeDoc === undefined) throw new Error('fixture vault has no Work item Type doc');
      fs().set(
        TYPE_DOC,
        typeDoc.replace(
          '\n---\n',
          '\ntabs:\n  - { id: overview, name: Overview, content: overview }\n  - { id: spec, name: Spec, content: sections }\n---\n',
        ),
      );
      await useVaultStore.getState().rescan();
      const record = useVaultStore.getState().entries.find((e) => e.type === 'Work item');
      if (record === undefined) throw new Error('fixture vault has no Work item');
      render(<DocPage selection={{ kind: 'doc', path: record.path, tab: 'spec' }} />);
      expect(screen.getByTestId('tab-sections')).toBeTruthy();
      expect(screen.queryByTestId('page-properties')).toBeNull();
    });

    it('switching between two Overview tabs keeps the live editor (M44.5)', async () => {
      const typeDoc = fs().get(TYPE_DOC);
      if (typeDoc === undefined) throw new Error('fixture vault has no Work item Type doc');
      fs().set(
        TYPE_DOC,
        typeDoc.replace(
          '\n---\n',
          '\ntabs:\n  - { id: brief, name: Brief, content: overview }\n  - { id: build, name: Build, content: overview }\n---\n',
        ),
      );
      await useVaultStore.getState().rescan();
      const record = useVaultStore.getState().entries.find((e) => e.type === 'Work item');
      if (record === undefined) throw new Error('fixture vault has no Work item');
      const { rerender } = render(
        <DocPage selection={{ kind: 'doc', path: record.path, tab: 'brief' }} />,
      );
      // The side panel's outline placeholder renders exactly while the live
      // editor is null — wait for onReady to clear it.
      await waitFor(() => expect(screen.queryByTestId('outline-loading')).toBeNull(), {
        timeout: 5_000,
      });
      // Both tabs render the same MOUNTED editor (one key), so the switch
      // re-fires no onReady — a reset keyed on the tab id would null the
      // editor here and strand the outline on its placeholder for good.
      rerender(<DocPage selection={{ kind: 'doc', path: record.path, tab: 'build' }} />);
      expect(screen.getByTestId('record-tab-build').getAttribute('aria-selected')).toBe('true');
      expect(screen.queryByTestId('outline-loading')).toBeNull();
    });

    it('a stale selection.tab falls back to the first tab (M44.5)', async () => {
      const entries = useVaultStore.getState().entries;
      const record = entries.find((e) => e.type === 'Work item');
      if (record === undefined) throw new Error('fixture vault has no Work item');
      // No saved tabs: the synthesized set is [overview], and 'gone' is a tab
      // a deleted-tab history entry might still carry.
      render(<DocPage selection={{ kind: 'doc', path: record.path, tab: 'gone' }} />);
      expect(screen.getByTestId('page-properties')).toBeTruthy();
      expect(screen.queryByTestId('tab-sections')).toBeNull();
    });
  });

  // M45.1 — the type's `layout.heading` renders as the key-property strip on
  // every tab of the record page; the Overview tab opens on the strip alone
  // and the expander reveals the full stack.
  describe('heading strip (M45.1)', () => {
    const TYPE_DOC = 'types/work-item.md';

    // The record-tabs idiom above: splice frontmatter into the Type doc at the
    // closing fence, rescan, pick a Work item. The splice lands right after
    // the `fields:` mapping, so a two-space-indented first line can grow the
    // roster before the top-level keys start.
    const setTypeFrontmatter = async (frontmatter: string) => {
      const typeDoc = fs().get(TYPE_DOC);
      if (typeDoc === undefined) throw new Error('fixture vault has no Work item Type doc');
      fs().set(TYPE_DOC, typeDoc.replace('\n---\n', `\n${frontmatter}---\n`));
      await useVaultStore.getState().rescan();
      const record = useVaultStore.getState().entries.find((e) => e.type === 'Work item');
      if (record === undefined) throw new Error('fixture vault has no Work item');
      return record;
    };

    it('the overview tab opens on the strip; the toggle reveals and hides the stack', async () => {
      const record = await setTypeFrontmatter('layout:\n  heading: [status, priority]\n');
      render(<DocPage selection={{ kind: 'doc', path: record.path }} />);
      expect(screen.getByTestId('heading-strip')).toBeTruthy();
      expect(screen.queryByTestId('page-properties')).toBeNull();
      fireEvent.click(screen.getByTestId('view-details-toggle'));
      expect(screen.getByTestId('page-properties')).toBeTruthy();
      fireEvent.click(screen.getByTestId('view-details-toggle'));
      expect(screen.queryByTestId('page-properties')).toBeNull();
    });

    it('a properties tab always shows the stack, and no toggle renders', async () => {
      const record = await setTypeFrontmatter(
        'layout:\n  heading: [status]\n' +
          'tabs:\n' +
          '  - { id: overview, name: Overview, content: overview }\n' +
          '  - { id: props, name: Properties, content: properties }\n',
      );
      render(<DocPage selection={{ kind: 'doc', path: record.path, tab: 'props' }} />);
      expect(screen.getByTestId('heading-strip')).toBeTruthy();
      expect(screen.getByTestId('page-properties')).toBeTruthy();
      expect(screen.queryByTestId('view-details-toggle')).toBeNull();
    });

    it('a sections tab renders the strip only — no stack conjured for it', async () => {
      const record = await setTypeFrontmatter(
        'layout:\n  heading: [status]\n' +
          'tabs:\n' +
          '  - { id: overview, name: Overview, content: overview }\n' +
          '  - { id: spec, name: Spec, content: sections }\n',
      );
      render(<DocPage selection={{ kind: 'doc', path: record.path, tab: 'spec' }} />);
      expect(screen.getByTestId('heading-strip')).toBeTruthy();
      expect(screen.getByTestId('tab-sections')).toBeTruthy();
      expect(screen.queryByTestId('page-properties')).toBeNull();
      expect(screen.queryByTestId('view-details-toggle')).toBeNull();
    });

    it('no layout → no strip, and the stack renders exactly as today', () => {
      const record = useVaultStore.getState().entries.find((e) => e.type === 'Work item');
      if (record === undefined) throw new Error('fixture vault has no Work item');
      render(<DocPage selection={{ kind: 'doc', path: record.path }} />);
      expect(screen.queryByTestId('heading-strip')).toBeNull();
      expect(screen.getByTestId('page-properties')).toBeTruthy();
      expect(screen.queryByTestId('view-details-toggle')).toBeNull();
    });

    it('toggling details keeps the same body editor instance', async () => {
      const record = await setTypeFrontmatter('layout:\n  heading: [status]\n');
      render(<DocPage selection={{ kind: 'doc', path: record.path }} />);
      await waitFor(() => expect(screen.getByTestId('markdown-editor')).toBeTruthy(), {
        timeout: 5_000,
      });
      const editor = screen.getByTestId('markdown-editor');
      fireEvent.click(screen.getByTestId('view-details-toggle'));
      expect(screen.getByTestId('page-properties')).toBeTruthy();
      fireEvent.click(screen.getByTestId('view-details-toggle'));
      // The same NODE, not merely presence — a remount hands back a new one
      // (and would re-run the whole load/onReady cycle mid-toggle).
      expect(screen.getByTestId('markdown-editor')).toBe(editor);
    });

    // The Task 5 ruling's trap: a heading whose one field is empty under
    // hide_when_empty folds the strip to NOTHING — so the stack must render
    // despite `detailsShown` never being touched, or the record's properties
    // are stranded behind a strip that is not on screen.
    it('a strip that folds to nothing shows the stack untoggled', async () => {
      const record = await setTypeFrontmatter(
        '  probe: { kind: text, visibility: hide_when_empty }\nlayout:\n  heading: [probe]\n',
      );
      render(<DocPage selection={{ kind: 'doc', path: record.path }} />);
      expect(screen.queryByTestId('heading-strip')).toBeNull();
      expect(screen.queryByTestId('view-details-toggle')).toBeNull();
      expect(screen.getByTestId('page-properties')).toBeTruthy();
    });
  });

  it('the panel toggle hides and shows the side panel', async () => {
    render(<DocPage selection={{ kind: 'doc', path: DOC }} />);
    expect(screen.getByTestId('doc-side-panel')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide panel' }));
    expect(screen.queryByTestId('doc-side-panel')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show panel' }));
    expect(screen.getByTestId('doc-side-panel')).toBeTruthy();
  });

  it('the Links tab lists backlinks from other notes', async () => {
    useUiStore.setState({ docPanelTab: 'links' });
    render(<DocPage selection={{ kind: 'doc', path: DOC }} />);
    // Work items in the fixture vault reference people/docs via wikilinks;
    // the kickoff doc links to people in its body.
    await waitFor(() => expect(screen.getByTestId('doc-links')).toBeTruthy());
  });

  it('falls back gracefully when the doc no longer exists', () => {
    render(<DocPage selection={{ kind: 'doc', path: 'nope/gone.md' }} />);
    expect(screen.getByText('This page no longer exists')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go home' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
  });

  // 'Add page' and 'Move to folder' both live in the overflow menu; the
  // toolbar's only LABELLED control used to be a duplicate of the action
  // users need least.
  it('does not duplicate overflow-menu actions in the toolbar', () => {
    render(<DocPage selection={{ kind: 'doc', path: DOC }} />);
    expect(screen.queryByRole('button', { name: 'Add page' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move to folder' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Page options' }));
    const labels = screen.getAllByRole('menuitem').map((el) => el.textContent);
    expect(labels).toContain('Add page');
    expect(labels).toContain('Move to folder…');
    // Rename is reachable without going back to the file tree.
    expect(labels).toContain('Rename…');
  });

  // M45.2 — the third door: a record's Page options opens the layout editor
  // through the same uiStore signal the ⋯ menu and PropertyMenu fire.
  it('Page options offers Customize layout to records only, firing the signal', async () => {
    useUiStore.setState({ layoutEditor: null });
    const record = useVaultStore.getState().entries.find((e) => e.type === 'Work item');
    if (record === undefined) throw new Error('fixture vault has no Work item');
    render(<DocPage selection={{ kind: 'doc', path: record.path }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Page options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Customize layout…' }));
    expect(useUiStore.getState().layoutEditor).toEqual({ type: 'Work item' });
    cleanup();

    // An untyped page has no type whose layout could be customized.
    render(<DocPage selection={{ kind: 'doc', path: 'inbox/welcome.md' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Page options' }));
    expect(screen.queryByRole('menuitem', { name: 'Customize layout…' })).toBeNull();
  });

  it('renames the doc by rewriting its H1, not its filename', async () => {
    render(<DocPage selection={{ kind: 'doc', path: DOC }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Page options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    fireEvent.change(screen.getByPlaceholderText('Page name'), { target: { value: 'Team Sync' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(fs().get(DOC)).toContain('# Team Sync'), { timeout: 5_000 });
    // The file itself never moves — the path the user navigated to still works.
    expect(fs().has(DOC)).toBe(true);
  });

  // Move already operated on the whole doc folder; Trash deleted one file,
  // removing the folder note and dissolving the doc without warning.
  it('trashing a multi-page doc from its main page takes the whole doc', async () => {
    fs().set(DOC_MAIN, '# Spec\n');
    fs().set(`${DOC_FOLDER}/two.md`, '# Two\n');
    await useVaultStore.getState().rescan();
    render(<DocPage selection={{ kind: 'doc', path: DOC_MAIN }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Page options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move doc to Trash' }));
    expect(screen.getByText(/and its 1 other page to Trash\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() => expect(fs().has(`${DOC_FOLDER}/two.md`)).toBe(false), { timeout: 5_000 });
    expect(fs().has(DOC_MAIN)).toBe(false);
  });

  // M15: a doc whose body has no H1 had its title in the breadcrumb and
  // nowhere else — the document itself was untitled.
  describe('the title of an untitled doc', () => {
    const UNTITLED = 'inbox/capture-untitled.md';

    it('renders in the document, and only when the body has none', async () => {
      fs().set(UNTITLED, 'Sync error rate looked spiky again overnight.\n');
      await useVaultStore.getState().rescan();
      render(<DocPage selection={{ kind: 'doc', path: UNTITLED }} />);
      await waitFor(() => expect(screen.getByTestId('markdown-editor')).toBeTruthy(), {
        timeout: 5_000,
      });
      const heading = await screen.findByTestId('doc-title-heading');
      const entry = useVaultStore.getState().entries.find((e) => e.path === UNTITLED);
      expect((heading as HTMLTextAreaElement).value).toBe(entry?.title);

      // The doc that DOES carry an H1 must not grow a second title.
      cleanup();
      render(<DocPage selection={{ kind: 'doc', path: DOC }} />);
      await waitFor(() => expect(screen.getByTestId('markdown-editor')).toBeTruthy(), {
        timeout: 5_000,
      });
      expect(screen.queryByTestId('doc-title-heading')).toBeNull();
    });

    it('committing it writes a real H1 into the body', async () => {
      fs().set(UNTITLED, 'Sync error rate looked spiky again overnight.\n');
      await useVaultStore.getState().rescan();
      render(<DocPage selection={{ kind: 'doc', path: UNTITLED }} />);
      const heading = await screen.findByTestId('doc-title-heading');
      fireEvent.change(heading, { target: { value: 'Sync error spike' } });
      fireEvent.blur(heading);
      await waitFor(() => expect(fs().get(UNTITLED)?.includes('# Sync error spike')).toBe(true), {
        timeout: 5_000,
      });
      // The body it was written above is still there — this adds a title, it
      // does not replace the document.
      expect(fs().get(UNTITLED)).toContain('Sync error rate looked spiky');
    });
  });

  it('trashing a non-main page of a doc still takes only that page', async () => {
    fs().set(DOC_MAIN, '# Spec\n');
    fs().set(`${DOC_FOLDER}/two.md`, '# Two\n');
    await useVaultStore.getState().rescan();
    render(<DocPage selection={{ kind: 'doc', path: `${DOC_FOLDER}/two.md` }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Page options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Trash' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() => expect(fs().has(`${DOC_FOLDER}/two.md`)).toBe(false), { timeout: 5_000 });
    expect(fs().has(DOC_MAIN)).toBe(true);
  });
});
