import { navSeed } from '@/test/navSeed';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommentHighlights } from '@/editor/commentHighlights';
import type { EditorReadyInfo } from '@/editor/MarkdownEditor';
import { announceExternalWrites, __resetOpenPages } from '@/editor/openPages';
import { resetMockFs } from '@/lib/mockIpc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { DocPage } from './DocPage';

// The real editor, with its ready info kept so a case can type the way the
// person would (M55.13's held-save case). Every other case is unaffected.
const lastEditor = vi.hoisted(() => ({ info: null as EditorReadyInfo | null }));
vi.mock('@/editor/NoteBodyEditor', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/editor/NoteBodyEditor')>();
  const Tracked = (props: ComponentProps<typeof mod.NoteBodyEditor>) =>
    createElement(mod.NoteBodyEditor, {
      ...props,
      onReady: (info: EditorReadyInfo) => {
        lastEditor.info = info;
        props.onReady?.(info);
      },
    });
  return { ...mod, NoteBodyEditor: Tracked };
});

const DOC = 'projects/guided-onboarding-ga/meetings/kickoff.md';
const DOC_FOLDER = 'projects/guided-onboarding-ga/spec';
const DOC_MAIN = `${DOC_FOLDER}/spec.md`;
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;

describe('DocPage', () => {
  beforeEach(async () => {
    resetMockFs();
    // A page an earlier test left unsaved would hold every later navigation.
    __resetOpenPages();
    await useVaultStore.getState().openVault('/demo-vault');
    useNavStore.setState({
      selection: { kind: 'doc', path: DOC },
      history: [navSeed({ kind: 'home' })],
      historyIndex: 0,
    });
    useUiStore.setState({ docPanelOpen: true, docPanel: 'details' });
  });
  afterEach(cleanup);

  it('shows body PR state on an ordinary page, independently of the editor', async () => {
    const path = 'notes/pr-page.md';
    fs().set(path, '# A linked change\n\nhttps://github.com/acme/notes/pull/42\n');
    await useVaultStore.getState().rescan();
    render(<DocPage selection={{ kind: 'doc', path }} />);
    const chip = await screen.findByTestId('pr-chip');
    await waitFor(() => expect(chip.dataset.state).toBe('gh_missing'));
    expect(chip.textContent).toContain('checks unknown');
    expect(fs().get(path)).toBe('# A linked change\n\nhttps://github.com/acme/notes/pull/42\n');
  });

  it('shows imported provenance on a plain page without exposing its stamp keys', async () => {
    const path = 'notes/imported-copy.md';
    fs().set(
      path,
      '---\ntitle: Imported copy\nsource_system: notion\nimported_at: "2026-10-13"\nimport_hash: abc\n---\n# Outside material\n',
    );
    await useVaultStore.getState().rescan();
    render(<DocPage selection={{ kind: 'doc', path }} />);
    expect((await screen.findByTestId('import-provenance')).textContent).toContain(
      'Imported from Notion · 2026-10-13',
    );
    expect(screen.queryByText('Import hash')).toBeNull();
  });

  // M58.4 (D18): the page's history is its History panel, not a list under
  // the editor.
  it('keeps history out from under the editor, in the side panel', async () => {
    render(<DocPage selection={{ kind: 'doc', path: DOC }} />);
    await waitFor(() => expect(screen.getByTestId('markdown-editor')).toBeTruthy(), {
      timeout: 5_000,
    });
    expect(screen.queryByTestId('git-history')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    const panel = screen.getByTestId('doc-side-panel');
    expect(await within(panel).findByTestId('git-history')).toBeTruthy();
    expect(within(screen.getByTestId('doc-content')).queryByTestId('git-history')).toBeNull();
  });

  it('shows the breadcrumb bar, title and editor', async () => {
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
  });

  // Owner, 2026-10-19: the outline is on the page, as Notion's is — over the
  // reading column, never in the side panel, once the live editor is ready.
  it('draws the outline on the page once the editor is ready, its headings under the title', async () => {
    render(<DocPage selection={{ kind: 'doc', path: 'delivery/how-we-schedule.md' }} />);
    const outline = await screen.findByTestId('doc-outline', undefined, { timeout: 5_000 });
    expect(screen.getByTestId('doc-column').contains(outline)).toBe(true);
    expect(screen.getByTestId('doc-side-panel').contains(outline)).toBe(false);
    expect(
      within(outline)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Windows, not deadlines', 'Blocking is a relation', 'Nesting is grouping']);
  });

  it('draws no outline for a page whose only heading is its title', async () => {
    // This render's own editor, not the one an earlier case left behind.
    lastEditor.info = null;
    render(<DocPage selection={{ kind: 'doc', path: DOC }} />);
    await waitFor(() => expect(lastEditor.info).not.toBeNull(), { timeout: 5_000 });
    const live = lastEditor.info!.editor;
    // The page holds that editor now: its title is a heading the outline could
    // list, and it lists nothing.
    expect(live.document.some((block) => block.type === 'heading')).toBe(true);
    await waitFor(() => expect(screen.getByTestId('markdown-editor')).toBeTruthy());
    // Past the render that hands the page its editor.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByTestId('doc-outline')).toBeNull();
  });

  it('a project page offers Overview, Tasks, Docs, Agents and Runs and lists its twelve work items', () => {
    const path = 'records/projects/guided-onboarding-ga.md';
    render(<DocPage selection={{ kind: 'doc', path, tab: 'tasks' }} />);
    expect(screen.getByTestId('record-tab-overview').textContent).toContain('Overview');
    expect(screen.getByTestId('record-tab-tasks').textContent).toContain('Tasks');
    expect(screen.getByTestId('record-tab-docs').textContent).toContain('Docs');
    expect(screen.getByTestId('record-tab-agents').textContent).toContain('Agents');
    expect(screen.getByTestId('record-tab-runs').textContent).toContain('Runs');
    const embed = within(screen.getByTestId('view-tab-embed'));
    expect(embed.getAllByTestId('table-row')).toHaveLength(12);
    expect(embed.getByText('Blank-state coaching copy')).toBeTruthy();
    expect(embed.queryByText('Campaign brief')).toBeNull();
  });

  it('a project Runs tab renders its own scoped feed', () => {
    render(
      <DocPage
        selection={{ kind: 'doc', path: 'records/projects/guided-onboarding-ga.md', tab: 'runs' }}
      />,
    );
    expect(screen.getByTestId('page-runs')).toBeTruthy();
    expect(screen.getByTestId('page-runs-footnote').textContent).toContain(
      "can't be placed on a page",
    );
    expect(screen.queryByTestId('view-tab-embed')).toBeNull();
  });

  it('a project Agents tab lists its seeded agent on the page', () => {
    const path = 'records/projects/guided-onboarding-ga.md';
    useVaultStore.setState({
      entries: useVaultStore
        .getState()
        .entries.map((entry) =>
          entry.path === path
            ? { ...entry, relationships: { ...entry.relationships, agents: ['release-scout'] } }
            : entry,
        ),
    });
    render(<DocPage selection={{ kind: 'doc', path, tab: 'agents' }} />);
    expect(screen.getByTestId('page-agents')).toBeTruthy();
    expect(screen.getByTestId('page-agent-open').textContent).toBe('Release scout');
    expect(screen.queryByTestId('view-tab-embed')).toBeNull();
  });

  // M38.2 — a record is a page too: the peek's property surface renders on
  // the page canvas, and the crumb roots at the record's backdrop rather
  // than at Docs, which never owned it.
  it('renders a record as a page: properties above the body, backdrop crumb', async () => {
    const entries = useVaultStore.getState().entries;
    const record = entries.find((e) => e.type === 'Work item');
    if (record === undefined) throw new Error('fixture vault has no Work item');
    render(<DocPage selection={{ kind: 'doc', path: record.path }} />);
    // M45.2 Task 6 (2026-08-28 plan): the corpus Work item wears `layout:`
    // now, so the stack opens behind the strip's Show all properties toggle.
    fireEvent.click(screen.getByTestId('view-details-toggle'));
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
      // M45.2 Task 6 (2026-08-28 plan): the corpus layout folds the stack
      // behind the strip's toggle.
      fireEvent.click(screen.getByTestId('view-details-toggle'));
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
      // The synthesized Overview still runs the canvas: properties render —
      // behind the corpus layout's strip toggle (M45.2 Task 6, 2026-08-28 plan).
      fireEvent.click(screen.getByTestId('view-details-toggle'));
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
      // The swap is the BODY's: M46.1 keeps the record's stack on every tab,
      // behind the corpus layout's strip toggle here as it is on Overview.
      expect(screen.queryByTestId('markdown-editor')).toBeNull();
      fireEvent.click(screen.getByTestId('view-details-toggle'));
      expect(screen.getByTestId('page-properties')).toBeTruthy();
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
      // Two headings under the title, so the page draws its outline.
      fs().set(record.path, `${fs().get(record.path)}\n## First\n\nOne.\n\n## Second\n\nTwo.\n`);
      await useVaultStore.getState().rescan();
      const { rerender } = render(
        <DocPage selection={{ kind: 'doc', path: record.path, tab: 'brief' }} />,
      );
      // The page's outline draws exactly while the page holds a live editor
      // — wait for onReady to bring it.
      await screen.findByTestId('doc-outline', undefined, { timeout: 5_000 });
      // Both tabs render the same MOUNTED editor (one key), so the switch
      // re-fires no onReady — a reset keyed on the tab id would null the
      // editor here and take the outline away for good.
      rerender(<DocPage selection={{ kind: 'doc', path: record.path, tab: 'build' }} />);
      expect(screen.getByTestId('record-tab-build').getAttribute('aria-selected')).toBe('true');
      expect(screen.getByTestId('doc-outline')).toBeTruthy();
    });

    it('a stale selection.tab falls back to the first tab (M44.5)', async () => {
      const entries = useVaultStore.getState().entries;
      const record = entries.find((e) => e.type === 'Work item');
      if (record === undefined) throw new Error('fixture vault has no Work item');
      // No saved tabs: the synthesized set is [overview], and 'gone' is a tab
      // a deleted-tab history entry might still carry.
      render(<DocPage selection={{ kind: 'doc', path: record.path, tab: 'gone' }} />);
      // M45.2 Task 6 (2026-08-28 plan): the corpus layout folds the stack
      // behind the strip's toggle — which only Overview renders, so its
      // presence already IS the fallback.
      fireEvent.click(screen.getByTestId('view-details-toggle'));
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
    // closing fence, rescan, pick a Work item. Only top-level keys belong
    // in this splice; field additions must target the fields mapping itself.
    //
    // M45.2 Task 6 (2026-08-28 plan): the golden corpus gave Work item a real
    // `layout:`, and these cases stage their OWN — so the corpus block is
    // stripped first, or the splice would mint a duplicate `layout:` key and
    // fail the whole frontmatter parse. The tripwire keeps the strip honest
    // when the corpus block drifts.
    const CORPUS_LAYOUT =
      'layout:\n' +
      '  heading: [status, priority]\n' +
      '  groups:\n' +
      '    - { id: planning, name: Planning, fields: [assignee, due, estimate] }\n';
    const setTypeFrontmatter = async (frontmatter: string) => {
      const typeDoc = fs().get(TYPE_DOC);
      if (typeDoc === undefined) throw new Error('fixture vault has no Work item Type doc');
      if (!typeDoc.includes(CORPUS_LAYOUT)) {
        throw new Error('work-item.md corpus layout drifted — update CORPUS_LAYOUT here');
      }
      fs().set(
        TYPE_DOC,
        typeDoc.replace(CORPUS_LAYOUT, '').replace('\n---\n', `\n${frontmatter}---\n`),
      );
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
      const manager = screen.getByTestId('page-properties');
      expect(manager.hidden).toBe(false);
      fireEvent.click(screen.getByTestId('view-details-toggle'));
      expect(screen.getByTestId('page-properties')).toBe(manager);
      expect(manager.hidden).toBe(true);
    });

    it('the strip and its toggle stand on a sections tab as well', async () => {
      const record = await setTypeFrontmatter(
        'layout:\n  heading: [status]\n' +
          'tabs:\n' +
          '  - { id: overview, name: Overview, content: overview }\n' +
          '  - { id: spec, name: Spec, content: sections }\n',
      );
      render(<DocPage selection={{ kind: 'doc', path: record.path, tab: 'spec' }} />);
      expect(screen.getByTestId('heading-strip')).toBeTruthy();
      expect(screen.getByTestId('tab-sections')).toBeTruthy();
      // M46.1: the stack is the record's on every tab, so the fold is the
      // strip's alone — and the toggle that opens it renders here too.
      expect(screen.queryByTestId('page-properties')).toBeNull();
      fireEvent.click(screen.getByTestId('view-details-toggle'));
      expect(screen.getByTestId('page-properties')).toBeTruthy();
    });

    it('no layout opens on a summary with the full manager one action away', async () => {
      // M45.2 Task 6 (2026-08-28 plan): the corpus doc carries a layout now,
      // so this case stages its no-layout baseline explicitly.
      const record = await setTypeFrontmatter('');
      render(<DocPage selection={{ kind: 'doc', path: record.path }} />);
      expect(screen.queryByTestId('heading-strip')).toBeNull();
      expect(screen.getByTestId('record-summary')).toBeTruthy();
      expect(screen.queryByTestId('page-properties')).toBeNull();
      fireEvent.click(screen.getByTestId('record-properties-toggle'));
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
      fs().set(
        TYPE_DOC,
        fs()
          .get(TYPE_DOC)!
          .replace('fields:\n', 'fields:\n  probe: { kind: text, visibility: hide_when_empty }\n'),
      );
      const record = await setTypeFrontmatter('layout:\n  heading: [probe]\n');
      render(<DocPage selection={{ kind: 'doc', path: record.path }} />);
      expect(screen.queryByTestId('heading-strip')).toBeNull();
      expect(screen.queryByTestId('view-details-toggle')).toBeNull();
      expect(screen.getByTestId('page-properties')).toBeTruthy();
    });
  });

  /**
   * M46.1 — a section belongs to the RECORD, not to a tab (user, 2026-08-29:
   * "sorry tabs are only for related data sources. fields shwo above. just
   * like notion."). The heading strip and the whole property stack stand
   * ABOVE the tab strip on every tab; the tab below them holds only its own
   * content — the body, its free text, or its database.
   *
   * This reverses M45.6, whose per-tab cases are deleted rather than
   * weakened: they described a product that no longer exists.
   */
  describe('properties stand above the tabs (M46.1)', () => {
    const TYPE_DOC = 'types/work-item.md';
    // The heading-strip block's idiom: strip the corpus `layout:` first, or
    // the splice mints a duplicate key and the frontmatter parse fails whole.
    // The same goes for `tabs:`, which this fixture also stages — hence the
    // second tripwire, which the first splice would otherwise not cover.
    const CORPUS_LAYOUT =
      'layout:\n' +
      '  heading: [status, priority]\n' +
      '  groups:\n' +
      '    - { id: planning, name: Planning, fields: [assignee, due, estimate] }\n';
    const stage = async (frontmatter: string) => {
      const typeDoc = fs().get(TYPE_DOC);
      if (typeDoc === undefined) throw new Error('fixture vault has no Work item Type doc');
      if (!typeDoc.includes(CORPUS_LAYOUT)) {
        throw new Error('work-item.md corpus layout drifted — update CORPUS_LAYOUT here');
      }
      if (typeDoc.includes('\ntabs:')) {
        throw new Error('work-item.md grew tabs — this fixture splices its own');
      }
      fs().set(
        TYPE_DOC,
        typeDoc.replace(CORPUS_LAYOUT, '').replace('\n---\n', `\n${frontmatter}---\n`),
      );
      await useVaultStore.getState().rescan();
      const record = useVaultStore.getState().entries.find((e) => e.type === 'Work item');
      if (record === undefined) throw new Error('fixture vault has no Work item');
      return record;
    };

    // Three sections and a loose remainder, none of them a tab's property:
    // every one has to stand on every tab. An authored empty heading keeps
    // the manager open independently of the new automatic summary default.
    const SECTIONS =
      'layout:\n' +
      '  heading: []\n' +
      '  groups:\n' +
      '    - { id: planning, name: Planning, fields: [assignee, due] }\n' +
      '    - { id: links, name: Links, fields: [epic, blocked_by] }\n' +
      '    - { id: extra, name: Extra, fields: [estimate] }\n';
    // One tab of each surviving kind: the body, free text, and a database.
    const TABS =
      'tabs:\n' +
      '  - { id: overview, name: Overview, content: overview }\n' +
      '  - { id: spec, name: Spec, content: sections }\n' +
      '  - { id: items, name: Items, content: view, source: { type: Work item } }\n';
    const stageTabs = () => stage(TABS + SECTIONS);

    // Everything is asserted INSIDE the page stack. The doc side panel's
    // Details render a second `DocProperties` holding the same groups, and
    // this file opens the panel on Details, so both are on screen here.
    const props = () => within(screen.getByTestId('page-properties'));
    const groupIds = () =>
      props()
        .queryAllByTestId('property-group')
        .map((g) => g.getAttribute('data-group'));
    const above = (first: HTMLElement, second: HTMLElement) =>
      Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

    // The headline of the reversal: a tab that is not the body still carries
    // the record's whole stack, and the stack stands over the strip.
    it('a sections tab shows every section, above the tab strip', async () => {
      const record = await stageTabs();
      render(<DocPage selection={{ kind: 'doc', path: record.path, tab: 'spec' }} />);
      expect(screen.getByTestId('tab-sections')).toBeTruthy();
      expect(groupIds()).toEqual(['planning', 'links', 'extra']);
      expect(props().getByText('Priority')).toBeTruthy();
      expect(above(screen.getByTestId('page-properties'), screen.getByTestId('record-tabs'))).toBe(
        true,
      );
    });

    it('a view tab shows every section too — the embed is the tab, not the page', async () => {
      const record = await stageTabs();
      render(<DocPage selection={{ kind: 'doc', path: record.path, tab: 'items' }} />);
      expect(screen.getByTestId('view-tab-embed')).toBeTruthy();
      expect(groupIds()).toEqual(['planning', 'links', 'extra']);
      expect(above(screen.getByTestId('page-properties'), screen.getByTestId('record-tabs'))).toBe(
        true,
      );
    });

    it('the overview tab is the same stack, in the same place', async () => {
      const record = await stageTabs();
      render(<DocPage selection={{ kind: 'doc', path: record.path }} />);
      expect(groupIds()).toEqual(['planning', 'links', 'extra']);
      expect(above(screen.getByTestId('page-properties'), screen.getByTestId('record-tabs'))).toBe(
        true,
      );
    });

    // Related content hides prose while retaining the native title and its
    // editor owner, including undo and any unsaved document draft.
    it('related tabs retain the document owner while only overview presents its body', async () => {
      const record = await stageTabs();
      lastEditor.info = null;
      const currentOwner = () => lastEditor.info?.editor;
      const { rerender } = render(
        <DocPage selection={{ kind: 'doc', path: record.path, tab: 'spec' }} />,
      );
      await waitFor(() => expect(screen.getByTestId('markdown-editor')).toBeTruthy(), {
        timeout: 5_000,
      });
      await waitFor(() => expect(lastEditor.info).not.toBeNull());
      const owner = currentOwner();
      expect(owner).toBeDefined();
      expect(screen.queryByTestId('page-body-start')).toBeNull();
      rerender(<DocPage selection={{ kind: 'doc', path: record.path }} />);
      await waitFor(() => expect(screen.getByTestId('page-body-start')).toBeTruthy());
      expect(currentOwner()).toBe(owner);
    });

    // The strip's expander is the one thing that still hides the stack, and
    // it is offered on EVERY tab now: the stack it opens is the same stack on
    // all of them, so a toggle missing here would strand the sections behind
    // a strip that has no way to open.
    it('the strip folds the stack behind its toggle on a view tab too', async () => {
      const record = await stage(
        TABS + SECTIONS.replace('  heading: []\n', '  heading: [status]\n'),
      );
      render(<DocPage selection={{ kind: 'doc', path: record.path, tab: 'items' }} />);
      expect(screen.getByTestId('heading-strip')).toBeTruthy();
      expect(screen.queryByTestId('page-properties')).toBeNull();
      fireEvent.click(screen.getByTestId('view-details-toggle'));
      expect(groupIds()).toEqual(['planning', 'links', 'extra']);
    });
  });

  // M45.4 — the view swap arm: a record tab backed by a database view. The
  // tab's content is the database, with prose hidden, and a dead pointer
  // renders the broken card, never an empty database. M46.1: the record's
  // property stack stands above the strip here as on every tab, so these
  // cases assert the embed and the body, never the stack's absence.
  describe('view tabs (M45.4)', () => {
    const TYPE_DOC = 'types/work-item.md';
    // syn-6 is the host: syn-7 and syn-10 declare `blocked_by: [[syn-6]]`,
    // fld-9 is blocked by syn-8 — related scoping must keep the first two and
    // drop the third.
    const HOST = 'projects/offline-sync-hardening/items/syn-6.md';
    // The heading-strip suite's tripwire, reused: these cases strip the
    // corpus `layout:` so `stripShows` is FALSE and the stack stands
    // unfolded — which is what makes the M46.1 assertion below bite.
    const CORPUS_LAYOUT =
      'layout:\n' +
      '  heading: [status, priority]\n' +
      '  groups:\n' +
      '    - { id: planning, name: Planning, fields: [assignee, due, estimate] }\n';
    /**
     * A tab naming no `view` takes the database's FIRST saved view, filters
     * and all — the same fallback `resolveDatabaseRef` uses, so a tab and a
     * `/database` block agree about what "show me Work item" means. M47.5 gave
     * the corpus Work item three saved views, the first of which filters to
     * urgent-and-moving, and these cases are about RELATED SCOPING rather than
     * about filters. Stripping them keeps each test measuring one thing.
     */
    const CORPUS_VIEWS_START = '\nviews:\n';
    const setTabs = async (tabsYaml: string) => {
      const typeDoc = fs().get(TYPE_DOC);
      if (typeDoc === undefined) throw new Error('fixture vault has no Work item Type doc');
      if (!typeDoc.includes(CORPUS_LAYOUT)) {
        throw new Error('work-item.md corpus layout drifted — update CORPUS_LAYOUT here');
      }
      if (!typeDoc.includes(CORPUS_VIEWS_START)) {
        throw new Error('work-item.md corpus views drifted — update CORPUS_VIEWS_START here');
      }
      const [frontmatter, ...rest] = typeDoc.split('\n---\n');
      // `+ 1` keeps the newline that ENDS the previous key — `CORPUS_LAYOUT`
      // includes its own trailing newline, and cutting it away made that
      // replace silently no-op and the layout survive.
      const stripped = frontmatter
        .slice(0, frontmatter.indexOf(CORPUS_VIEWS_START) + 1)
        .replace(CORPUS_LAYOUT, '');
      fs().set(TYPE_DOC, [stripped + tabsYaml.replace(/\n$/, ''), ...rest].join('\n---\n'));
      await useVaultStore.getState().rescan();
    };
    const VIEW_TABS =
      'tabs:\n' +
      '  - { id: overview, name: Overview, content: overview }\n' +
      '  - { id: blocked, name: Blocked, content: view, source: { type: Work item }, scope: related }\n';

    it('a view tab shows its database scoped to the host — only the related rows', async () => {
      await setTabs(VIEW_TABS);
      render(<DocPage selection={{ kind: 'doc', path: HOST, tab: 'blocked' }} />);
      const embed = screen.getByTestId('view-tab-embed');
      // The two items blocked BY this host… (the side panel's Details list
      // them too, as backlinks, so the embed is asked)
      expect(within(embed).getByText('Hold both versions instead of discarding')).toBeTruthy();
      expect(
        within(embed).getByText('Instrument conflict rate separately from sync errors'),
      ).toBeTruthy();
      // …and not the one blocked by a different record.
      expect(within(embed).queryByText('Recover gracefully from the first failed sync')).toBeNull();
      expect(screen.getAllByTestId('table-row')).toHaveLength(2);
      // The same editor owns the visible native title while the database
      // replaces its body presentation. Metadata remains above the strip.
      await waitFor(() => expect(screen.getByTestId('markdown-editor')).toBeTruthy(), {
        timeout: 5_000,
      });
      expect(screen.queryByTestId('page-body-start')).toBeNull();
      expect(screen.getByTestId('record-summary')).toBeTruthy();
      fireEvent.click(screen.getByTestId('record-properties-toggle'));
      expect(screen.getByTestId('page-properties')).toBeTruthy();
    });

    it('a dead source renders the card — the sentence, never an empty database', async () => {
      await setTabs(
        'tabs:\n' +
          '  - { id: overview, name: Overview, content: overview }\n' +
          '  - { id: ghost, name: Ghost, content: view, source: { type: Ghost } }\n',
      );
      render(<DocPage selection={{ kind: 'doc', path: HOST, tab: 'ghost' }} />);
      expect(screen.getByTestId('view-tab-broken').textContent).toContain(
        'This tab points at a type called “Ghost” that is no longer in the vault.',
      );
      // Broken is a sentence, not an empty view — an empty-state line would
      // read as measured-at-zero. Both spellings: the table this dead source
      // would default to says "No records yet"; "No items yet" is BoardView's.
      expect(screen.queryByTestId('view-tab-embed')).toBeNull();
      expect(screen.queryByText('No records yet')).toBeNull();
      expect(screen.queryByText('No items yet')).toBeNull();
      expect(screen.queryByTestId('table-row')).toBeNull();
    });

    it('a stale selection.tab still falls back to the first tab (M44.5 unchanged)', async () => {
      await setTabs(VIEW_TABS);
      render(<DocPage selection={{ kind: 'doc', path: HOST, tab: 'gone' }} />);
      // The fallback is Overview — the editor mounts, and no embed renders.
      await waitFor(() => expect(screen.getByTestId('markdown-editor')).toBeTruthy(), {
        timeout: 5_000,
      });
      expect(screen.queryByTestId('view-tab-embed')).toBeNull();
    });
  });

  // Owner, 2026-10-19 — Notion's properties, discussions and updates: one
  // slot, a button per panel, and the open one's button closes it.
  it("each panel's button opens it in the one slot, and closes it when it is open", async () => {
    render(<DocPage selection={{ kind: 'doc', path: DOC }} />);
    const side = () => screen.queryByTestId('doc-side-panel');
    const button = (name: string) => screen.getByRole('button', { name });
    expect(side()?.dataset.panel).toBe('details');
    expect(button('Details').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('doc-page').dataset.panel).toBe('docked');
    fireEvent.click(button('Details'));
    expect(side()).toBeNull();
    expect(useUiStore.getState().docPanelOpen).toBe(false);
    expect(screen.getByTestId('doc-page').dataset.panel).toBeUndefined();
    expect(screen.queryByRole('button', { name: 'Close panel' })).toBeNull();

    fireEvent.click(button('Comments'));
    expect(side()?.dataset.panel).toBe('comments');
    expect(useUiStore.getState()).toMatchObject({ docPanelOpen: true, docPanel: 'comments' });
    expect(button('Comments').getAttribute('aria-pressed')).toBe('true');
    expect(button('Details').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button('History'));
    expect(side()?.dataset.panel).toBe('history');
    expect(await within(side() as HTMLElement).findByTestId('page-history')).toBeTruthy();
    fireEvent.click(button('History'));
    expect(side()).toBeNull();

    // Close, at the panel's edge, closes whichever is open.
    fireEvent.click(button('Details'));
    expect(side()?.dataset.panel).toBe('details');
    fireEvent.click(button('Close panel'));
    expect(side()).toBeNull();
    expect(useUiStore.getState().docPanelOpen).toBe(false);
  });

  it('the Details panel lists backlinks from other notes', async () => {
    useUiStore.setState({ docPanel: 'details', inspectorCollapsed: [] });
    // Work items in the fixture vault reference this decision via wikilinks.
    const path = 'records/decisions/dec-offline-window-72h.md';
    render(<DocPage selection={{ kind: 'doc', path }} />);
    const links = await screen.findByTestId('doc-links');
    const backlinks = links.querySelector<HTMLElement>('[data-section="backlinks"]');
    if (backlinks === null) throw new Error('no Backlinks section');
    const occurrences = within(backlinks).getByTestId('source-occurrences');
    const rows = await within(occurrences).findAllByRole('button', {
      name: /dec-offline-window-72h/,
    });
    expect(rows).toHaveLength(3);
    expect(within(occurrences).getByTestId('source-occurrences-count').textContent).toBe(
      '3 occurrences on 3 pages',
    );
    expect(
      within(occurrences).getByRole('button', { name: /^The offline guarantee:/ }),
    ).toBeTruthy();
    expect(
      within(occurrences).getByRole('button', { name: /^Warn past the 72-hour offline window:/ }),
    ).toBeTruthy();
    fireEvent.click(
      within(occurrences).getByRole('button', {
        name: /^Three work items reference a 72-hour window that is only written down in one decision:/,
      }),
    );
    await waitFor(() =>
      expect(useNavStore.getState().selection).toEqual({
        kind: 'doc',
        path: 'inbox/capture-2026-07-28-1642.md',
      }),
    );
  });

  it('falls back gracefully when the doc no longer exists', () => {
    render(<DocPage selection={{ kind: 'doc', path: 'nope/gone.md' }} />);
    expect(screen.getByText('This page no longer exists')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go home' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
  });

  // 'Add sub-page' and 'Move to folder' both live in the overflow menu; the
  // toolbar's only LABELLED control used to be a duplicate of the action
  // users need least.
  it('does not duplicate overflow-menu actions in the toolbar', () => {
    render(<DocPage selection={{ kind: 'doc', path: DOC }} />);
    expect(screen.queryByRole('button', { name: 'Add sub-page' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move to folder' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Page options' }));
    const labels = screen.getAllByRole('menuitem').map((el) => el.textContent);
    expect(labels).toContain('Add sub-page');
    expect(labels).toContain('Move to folder…');
    // Rename is reachable without going back to the file tree.
    expect(labels).toContain('Rename…');
  });

  // M55.9 — Open with sits in the header beside the star, with every item.
  it('has Open with in its header', () => {
    render(<DocPage selection={{ kind: 'doc', path: DOC }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open with' }));
    const menu = screen.getByRole('menu', { name: 'Open with' });
    const labels = within(menu)
      .getAllByRole('menuitem')
      .map((el) => el.querySelector('span')?.textContent);
    expect(labels).toEqual([
      'Copy as prompt',
      'Copy path',
      'Copy Cerebro link',
      'Reveal in Finder',
      'Open in default editor',
      'Claude Code on the web',
      'Codex',
      'Cursor',
      'Zed',
    ]);
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
  it('trashing a page with sub-pages takes them all', async () => {
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

  // M60.8: the doc goes to the vault's own Trash through trashPath, every
  // page in it, and the dialog says Settings brings it back.
  it('trashing a doc moves every page into the vault Trash, in the new words', async () => {
    fs().set(DOC_MAIN, '# Spec\n');
    fs().set(`${DOC_FOLDER}/two.md`, '# Two\n');
    await useVaultStore.getState().rescan();
    render(<DocPage selection={{ kind: 'doc', path: DOC_MAIN }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Page options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move doc to Trash' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('The whole doc — every page in it — moves to the Trash.');
    expect(dialog.textContent).toContain('Restore from Settings → Recently deleted for 30 days.');
    expect(dialog.textContent).not.toMatch(/system Trash|not from the app/);
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() => expect(fs().has(DOC_MAIN)).toBe(false), { timeout: 5_000 });
    const keys = [...fs().keys()];
    expect(
      keys.find((p) => p.startsWith('.trash/') && p.endsWith(`/${DOC_FOLDER}/two.md`)),
    ).toBeTruthy();
    expect(useUiStore.getState().toasts.map((t) => t.message)).toContain('Moved “Spec” to Trash');
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

  // M55.13 — sub-pages: Add sub-page grows a plain page into a folder of its
  // own, by rename, and adds a child; on a sub-page it adds a grandchild under
  // that page, never a sibling.
  describe('sub-pages (M55.13)', () => {
    const PLAIN = 'notes/plan.md';
    const addSubPageNamed = async (name: string) => {
      fireEvent.click(screen.getByRole('button', { name: 'Page options' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Add sub-page' }));
      fireEvent.change(screen.getByPlaceholderText('Page name'), { target: { value: name } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    };

    it('grows a plain page, keeps its bytes, and opens the child', async () => {
      fs().set(PLAIN, '# Plan\n\nBody.\n');
      await useVaultStore.getState().rescan();
      render(<DocPage selection={{ kind: 'doc', path: PLAIN }} />);
      fireEvent.click(screen.getByRole('button', { name: 'Page options' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Add sub-page' }));
      expect(
        screen.getByText('"Plan" moves into a folder of its own. Its text does not change.'),
      ).toBeTruthy();
      fireEvent.change(screen.getByPlaceholderText('Page name'), { target: { value: 'Goals' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      await waitFor(
        () =>
          expect(useNavStore.getState().selection).toEqual({
            kind: 'doc',
            path: 'notes/plan/goals.md',
          }),
        { timeout: 5_000 },
      );
      expect(fs().get('notes/plan/plan.md')).toBe('# Plan\n\nBody.\n');
      expect(fs().has(PLAIN)).toBe(false);
      expect(fs().get('notes/plan/goals.md')).toBe('# Goals\n');
    });

    it('refuses to grow a page while its save waits on a choice, and keeps the typing', async () => {
      fs().set(PLAIN, '# Plan\n\nBody.\n');
      await useVaultStore.getState().rescan();
      useUiStore.setState({ toasts: [] });
      lastEditor.info = null;
      render(<DocPage selection={{ kind: 'doc', path: PLAIN }} />);
      await waitFor(() => expect(lastEditor.info).not.toBeNull(), { timeout: 5_000 });
      const info = lastEditor.info as unknown as EditorReadyInfo;
      const body = info.editor.document.find((b) => JSON.stringify(b.content).includes('Body.'));
      if (body === undefined) throw new Error('no Body. paragraph');
      // Typed, then an outside write hits the same paragraph: a choice opens
      // and the save is held until it is settled (M55.6).
      act(() => {
        info.editor.updateBlock(body, { content: 'Body, typed by me.' });
      });
      fs().set(PLAIN, '# Plan\n\nBody, by the agent.\n');
      await act(() => announceExternalWrites([PLAIN], async () => undefined));
      await waitFor(() => expect(screen.getAllByTestId('merge-choice')).toHaveLength(1), {
        timeout: 5_000,
      });
      await addSubPageNamed('Goals');
      await waitFor(() =>
        expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
          `Couldn't add sub-page: "Plan" has changes waiting on you. Settle them first`,
        ),
      );
      // Nothing moved, so the held save still has its file.
      expect(fs().has('notes/plan/plan.md')).toBe(false);
      expect(fs().has('notes/plan/goals.md')).toBe(false);
      fireEvent.click(screen.getByTestId('merge-keep-mine'));
      await waitFor(() => expect(fs().get(PLAIN)).toContain('Body, typed by me.'), {
        timeout: 5_000,
      });
    });

    it('on a sub-page, adds a grandchild under that page’s own folder', async () => {
      fs().set(DOC_MAIN, '# Spec\n');
      fs().set(`${DOC_FOLDER}/two.md`, '# Two\n');
      await useVaultStore.getState().rescan();
      render(<DocPage selection={{ kind: 'doc', path: `${DOC_FOLDER}/two.md` }} />);
      await addSubPageNamed('Deeper');
      await waitFor(() => expect(fs().has(`${DOC_FOLDER}/two/deeper.md`)).toBe(true), {
        timeout: 5_000,
      });
      expect(fs().get(`${DOC_FOLDER}/two/two.md`)).toBe('# Two\n');
      expect(fs().has(`${DOC_FOLDER}/deeper.md`)).toBe(false);
    });

    it('on a page with sub-pages, says it adds inside it', () => {
      fs().set(DOC_MAIN, '# Spec\n');
      return useVaultStore
        .getState()
        .rescan()
        .then(() => {
          render(<DocPage selection={{ kind: 'doc', path: DOC_MAIN }} />);
          fireEvent.click(screen.getByRole('button', { name: 'Page options' }));
          fireEvent.click(screen.getByRole('menuitem', { name: 'Add sub-page' }));
          expect(screen.getByText('Adds a page inside "Spec".')).toBeTruthy();
        });
    });

    it('crumbs show each ancestor page as a button that opens it', async () => {
      fs().set(DOC_MAIN, '# Spec\n');
      fs().set(`${DOC_FOLDER}/two/two.md`, '# Two\n');
      fs().set(`${DOC_FOLDER}/two/three.md`, '# Three\n');
      await useVaultStore.getState().rescan();
      render(<DocPage selection={{ kind: 'doc', path: `${DOC_FOLDER}/two/three.md` }} />);
      const crumbs = screen.getByTestId('doc-page').firstElementChild as HTMLElement;
      expect(within(crumbs).getByRole('button', { name: 'Spec' })).toBeTruthy();
      fireEvent.click(within(crumbs).getByRole('button', { name: 'Two' }));
      expect(useNavStore.getState().selection).toEqual({
        kind: 'doc',
        path: `${DOC_FOLDER}/two/two.md`,
      });
      // A plain folder stays a label.
      expect(within(crumbs).queryByRole('button', { name: 'Projects' })).toBeNull();
      expect(within(crumbs).getByText('Projects')).toBeTruthy();
    });

    it('Move on a sub-page moves only that page', async () => {
      fs().set(DOC_MAIN, '# Spec\n');
      fs().set(`${DOC_FOLDER}/two.md`, '# Two\n');
      await useVaultStore.getState().rescan();
      render(<DocPage selection={{ kind: 'doc', path: `${DOC_FOLDER}/two.md` }} />);
      fireEvent.click(screen.getByRole('button', { name: 'Page options' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Move to folder…' }));
      expect(screen.getByText('Move page "Two"')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Vault root' }));
      fireEvent.click(screen.getByRole('button', { name: 'Move' }));
      await waitFor(() => expect(fs().get('two.md')).toBe('# Two\n'), { timeout: 5_000 });
      // The page it sat in stays where it was.
      expect(fs().get(DOC_MAIN)).toBe('# Spec\n');
      expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'two.md' });
    });

    it('the delete count includes grandchildren', async () => {
      fs().set(DOC_MAIN, '# Spec\n');
      fs().set(`${DOC_FOLDER}/two/two.md`, '# Two\n');
      fs().set(`${DOC_FOLDER}/two/three.md`, '# Three\n');
      await useVaultStore.getState().rescan();
      render(<DocPage selection={{ kind: 'doc', path: DOC_MAIN }} />);
      fireEvent.click(screen.getByRole('button', { name: 'Page options' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Move doc to Trash' }));
      expect(screen.getByText(/and its 2 other pages to Trash\?/)).toBeTruthy();
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

// M55.11 — a page's own icon and cover: above the title, in the crumbs, and
// on the cover band, read from the page's frontmatter and never written by
// being shown.
describe('a page icon and cover (M55.11)', () => {
  const ROCKET = '\u{1F680}';
  const PAGE = 'inbox/launch-notes.md';

  beforeEach(async () => {
    resetMockFs();
    await useVaultStore.getState().openVault('/demo-vault');
    useNavStore.setState({
      selection: { kind: 'doc', path: PAGE },
      history: [navSeed({ kind: 'home' })],
      historyIndex: 0,
    });
    useUiStore.setState({ docPanelOpen: false, docPanel: 'details' });
  });
  afterEach(cleanup);

  it('shows the icon above the title and in the title crumb, and draws the cover', async () => {
    fs().set(PAGE, `---\nicon: ${ROCKET}\ncover: blue\n---\n# Launch notes\n`);
    await useVaultStore.getState().rescan();
    render(<DocPage selection={{ kind: 'doc', path: PAGE }} />);
    expect(within(screen.getByTestId('page-icon')).getByRole('img', { name: ROCKET })).toBeTruthy();
    expect(within(screen.getByTestId('doc-title')).getByRole('img', { name: ROCKET })).toBeTruthy();
    expect(screen.getByTestId('page-cover').style.background).toBe('var(--opt-blue)');
    // Drawing it wrote nothing.
    expect(fs().get(PAGE)).toBe(`---\nicon: ${ROCKET}\ncover: blue\n---\n# Launch notes\n`);
  });

  it('a page with neither draws no icon and no band, only the hidden Add row', async () => {
    fs().set(PAGE, '# Launch notes\n');
    await useVaultStore.getState().rescan();
    render(<DocPage selection={{ kind: 'doc', path: PAGE }} />);
    expect(screen.queryByTestId('page-icon')).toBeNull();
    expect(screen.queryByTestId('page-cover')).toBeNull();
    expect(screen.getByTestId('page-add-icon')).toBeTruthy();
    // The title crumb keeps the lucide glyph it always drew.
    expect(screen.getByTestId('doc-title').querySelector('[data-icon="file-text"]')).not.toBe(null);
  });

  it("a sub-page's doc crumb shows the main page's icon", async () => {
    fs().set(DOC_MAIN, `---\nicon: ${ROCKET}\n---\n# Spec\n`);
    fs().set(`${DOC_FOLDER}/two.md`, '# Two\n');
    await useVaultStore.getState().rescan();
    render(<DocPage selection={{ kind: 'doc', path: `${DOC_FOLDER}/two.md` }} />);
    // The crumb bar is the page's first row; the Pages panel names Spec too.
    const crumbs = screen.getByTestId('doc-page').firstElementChild as HTMLElement;
    const docCrumb = within(crumbs).getByRole('button', { name: `${ROCKET} Spec` });
    expect(within(docCrumb).getByRole('img', { name: ROCKET })).toBeTruthy();
    // The sub-page itself has no icon: no header icon, and its crumb has none.
    expect(screen.queryByTestId('page-icon')).toBeNull();
    expect(within(screen.getByTestId('doc-title')).queryByRole('img')).toBeNull();
  });

  it('a concept page offers no Add row', () => {
    render(
      <DocPage selection={{ kind: 'doc', path: 'knowledge/playbooks/warehouse-cutover.md' }} />,
    );
    expect(screen.queryByTestId('page-add-icon')).toBeNull();
    expect(screen.queryByTestId('page-add-cover')).toBeNull();
  });
});

// M50.1 — a concept is a page: the same canvas, editor and side panel as any
// page. What differs is where its title lives (frontmatter), where its review
// sits (a bar under the title, M51.3), and which actions its folder refuses.
// M70.2b — a comment thread is a place: `{kind: 'doc', path, thread}` opens
// the page with its panel on Comments and that thread in focus.
describe('a comment thread is a place (M70.2b)', () => {
  const THREAD = '00000000000000aa';

  beforeEach(async () => {
    resetMockFs();
    await useVaultStore.getState().openVault('/demo-vault');
    fs().set(
      `.comments/${DOC}.json`,
      JSON.stringify(
        {
          format: 1,
          threads: [
            {
              comments: [
                {
                  id: THREAD,
                  author: 'human:owner',
                  created: '2026-10-14T09:00:00Z',
                  body: 'Who owns the follow-ups?',
                },
              ],
            },
          ],
        },
        null,
        2,
      ) + '\n',
    );
    useUiStore.setState({ docPanelOpen: false, docPanel: 'details', toasts: [] });
  });
  afterEach(cleanup);

  it('a deep link opens the Comments panel and focuses its thread', async () => {
    render(<DocPage selection={{ kind: 'doc', path: DOC, thread: THREAD }} />);
    const card = await screen.findByTestId('comment-thread');
    expect(card.dataset.threadId).toBe(THREAD);
    await waitFor(() => expect(card.dataset.focused).toBe('true'));
    expect(useUiStore.getState().docPanelOpen).toBe(true);
    expect(useUiStore.getState().docPanel).toBe('comments');
    expect(screen.getByTestId('doc-side-panel').dataset.panel).toBe('comments');
    // The count rides the Comments button in the toolbar.
    expect(screen.getByTestId('doc-panel-comment-count').textContent).toBe('1');
    expect(
      screen
        .getByRole('button', { name: 'Comments' })
        .contains(screen.getByTestId('doc-panel-comment-count')),
    ).toBe(true);
  });

  // The editor on screen, once the page's mount has said it is ready, with
  // its highlights' reveal watched: a dead editor must never be handed one.
  // Each case clears `lastEditor.info` before the render it waits on.
  const readyEditor = async () => {
    await waitFor(() => expect(lastEditor.info).not.toBeNull(), { timeout: 5_000 });
    const highlights = lastEditor.info!.editor.getExtension(CommentHighlights)!;
    return vi.spyOn(highlights, 'reveal');
  };

  it('a deep link after the diff closes never reveals in the editor the diff destroyed', async () => {
    lastEditor.info = null;
    const { rerender } = render(<DocPage selection={{ kind: 'doc', path: DOC }} />);
    const deadReveal = await readyEditor();
    act(() => useUiStore.setState({ diffView: { path: DOC, commit: null } }));
    expect(screen.queryByTestId('markdown-editor')).toBeNull();
    // Navigating closes the diff (navStore) in the same step that names the thread.
    lastEditor.info = null;
    act(() => useUiStore.setState({ diffView: null }));
    rerender(<DocPage selection={{ kind: 'doc', path: DOC, thread: THREAD }} />);
    const card = await screen.findByTestId('comment-thread');
    await waitFor(() => expect(card.dataset.focused).toBe('true'));
    await waitFor(() => expect(lastEditor.info).not.toBeNull(), { timeout: 5_000 });
    expect(deadReveal).not.toHaveBeenCalled();
    expect(screen.getByTestId('doc-page')).toBeTruthy();
  });

  it("a deep link from another page never reveals in that page's editor", async () => {
    useUiStore.setState({ docPanelOpen: true });
    lastEditor.info = null;
    const { rerender } = render(<DocPage selection={{ kind: 'doc', path: DOC }} />);
    // The first visit leaves the slot cached, so the link is handled at once.
    await screen.findByTestId('doc-panel-comment-count');
    await readyEditor();
    lastEditor.info = null;
    rerender(<DocPage selection={{ kind: 'doc', path: 'delivery/how-we-schedule.md' }} />);
    const previousReveal = await readyEditor();
    rerender(<DocPage selection={{ kind: 'doc', path: DOC, thread: THREAD }} />);
    const card = await screen.findByTestId('comment-thread');
    await waitFor(() => expect(card.dataset.focused).toBe('true'));
    expect(previousReveal).not.toHaveBeenCalled();
    expect(screen.getByTestId('doc-page')).toBeTruthy();
  });

  it('a deep link to a thread that is gone says so once', async () => {
    render(<DocPage selection={{ kind: 'doc', path: DOC, thread: 'ffffffffffffffff' }} />);
    await waitFor(() =>
      expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual([
        'That comment is no longer on this page.',
      ]),
    );
    expect(useUiStore.getState().docPanel).toBe('comments');
  });
});

describe('a concept is a page (M50.1)', () => {
  const CONCEPT = 'knowledge/playbooks/warehouse-cutover.md';

  beforeEach(async () => {
    resetMockFs();
    await useVaultStore.getState().openVault('/demo-vault');
    useNavStore.setState({
      selection: { kind: 'doc', path: CONCEPT },
      history: [navSeed({ kind: 'home' })],
      historyIndex: 0,
    });
    useUiStore.setState({
      docPanelOpen: true,
      conceptPanelOpen: false,
      conceptPanel: 'details',
      actorId: 'josef',
    });
  });
  afterEach(cleanup);

  it('roots at Knowledge, titles from frontmatter, and puts its review under the title', () => {
    render(<DocPage selection={{ kind: 'doc', path: CONCEPT }} />);
    expect((screen.getByTestId('concept-title') as HTMLTextAreaElement).value).toBe(
      'Warehouse cutover: go-live and rollback',
    );
    // M51.3 — the review is a bar on the page; the panel starts closed even
    // though the doc panel is open, so the page is not four columns wide.
    expect(screen.getByTestId('concept-review-bar')).toBeTruthy();
    expect(screen.queryByTestId('doc-side-panel')).toBeNull();
    // Written by the Knowledge agent (the corpus stamps it `process:knowledge`
    // since M52.3), and said so in the app's words — its record's title.
    const author = screen.getByTestId('review-bar-author');
    expect(author.dataset.author).toBe('agent');
    expect(author.textContent).toContain('Knowledge agent');
    // The panel opens on the concept's details: its provenance, never the
    // property editor a page's Details hold.
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByTestId('knowledge-panel')).toBeTruthy();
    expect(screen.getByTestId('doc-side-panel').dataset.panel).toBe('details');
    expect(screen.queryByTestId('doc-properties')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Playbooks' }));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'knowledge',
      nav: { tab: 'section', folder: 'playbooks' },
    });
  });

  it('walks the review queue from the page it sends you to, and ends it (M51.2)', () => {
    // The corpus's last queued concept: never reviewed, and the oldest
    // writing of the three that are (M52.5 ranks never-reviewed as new,
    // newest first). The walk ends here with Done, rather than wrapping
    // round to the first as it used to.
    render(<DocPage selection={{ kind: 'doc', path: 'knowledge/metrics/sync-error-rate.md' }} />);
    const pager = screen.getByTestId('review-pager');
    expect(pager.textContent).toMatch(/^Review (\d+) of \1Done$/);
    expect(screen.queryByTestId('review-next')).toBeNull();
    fireEvent.click(screen.getByTestId('review-done'));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'knowledge',
      nav: { tab: 'review' },
    });
  });

  it('offers only what its folder allows in the page menu', () => {
    render(<DocPage selection={{ kind: 'doc', path: CONCEPT }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Page options' }));
    const items = screen.getAllByRole('menuitem').map((el) => el.textContent);
    // M52.3 — the review bar's ask, by the review bar's name.
    expect(items).toEqual(['Ask to revise', 'Show in Knowledge']);
  });

  // M91.14 — the menu's ask is the bar's one Ask: its label shown, its
  // prompt sent, the concept its subject and its bubble.
  it('sends the same ask from the page menu as from the review bar', () => {
    useUiStore.setState({ handoffs: [] });
    render(<DocPage selection={{ kind: 'doc', path: CONCEPT }} />);
    fireEvent.click(screen.getByTestId('revise-concept'));
    const fromBar = useUiStore.getState().handoffs.at(-1);
    fireEvent.click(screen.getByRole('button', { name: 'Page options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ask to revise' }));
    const fromMenu = useUiStore.getState().handoffs.at(-1);
    expect(useUiStore.getState().handoffs).toHaveLength(2);
    expect(fromMenu).toMatchObject({
      text: fromBar?.text,
      subject: CONCEPT,
      label: 'Ask to revise · Warehouse cutover: go-live and rollback',
    });
    expect(fromMenu?.text.split('\n')[0]).toBe(
      `Revise the knowledge concept at ${CONCEPT} ("Warehouse cutover: go-live and rollback").`,
    );
  });

  // M55.9, Q17 — a concept is edited in the app or not at all.
  it('offers Open with, but no default editor', () => {
    render(<DocPage selection={{ kind: 'doc', path: CONCEPT }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open with' }));
    expect(screen.getByTestId('open-with-copy-prompt')).toBeTruthy();
    expect(screen.getByTestId('open-with-reveal')).toBeTruthy();
    expect(screen.queryByTestId('open-with-default-editor')).toBeNull();
  });

  it('verifies the body the editor loaded, through the M49.3 pin', async () => {
    render(<DocPage selection={{ kind: 'doc', path: CONCEPT }} />);
    const verify = () => screen.getByRole('button', { name: /^Verify$/ });
    await waitFor(() => expect(verify().hasAttribute('disabled')).toBe(false), {
      timeout: 5_000,
    });
    fireEvent.click(verify());
    await waitFor(() => expect(fs().get(CONCEPT)).toContain('human:josef'), { timeout: 5_000 });
  });

  // M70.2b, Q5 — a concept takes comments like any page: the sidecar sits
  // outside the bundle, and a thread can neither write nor verify it.
  it("offers Comments in its panel, and the concept's file is untouched", async () => {
    const before = fs().get(CONCEPT);
    render(<DocPage selection={{ kind: 'doc', path: CONCEPT }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Comments' }));
    expect(useUiStore.getState().conceptPanel).toBe('comments');
    expect(useUiStore.getState().conceptPanelOpen).toBe(true);
    fireEvent.change(await screen.findByTestId('discussion-submit-input'), {
      target: { value: 'Is the rollback rehearsed?' },
    });
    fireEvent.click(screen.getByTestId('discussion-submit'));
    await waitFor(() => expect(screen.getByText('Is the rollback rehearsed?')).toBeTruthy());
    expect(fs().get(`.comments/${CONCEPT}.json`)).toContain('Is the rollback rehearsed?');
    expect(fs().get(CONCEPT)).toBe(before);
  });

  it('opens the rest of the folder read-only — the log is the system’s', async () => {
    render(<DocPage selection={{ kind: 'doc', path: 'knowledge/log.md' }} />);
    await waitFor(() => expect(screen.getByTestId('markdown-editor')).toBeTruthy(), {
      timeout: 5_000,
    });
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
    expect(screen.queryByTestId('concept-title')).toBeNull();
  });
});

describe('an agent is a page (M55.12)', () => {
  const AGENT = 'records/agents/release-scout.md';

  beforeEach(async () => {
    resetMockFs();
    await useVaultStore.getState().openVault('/demo-vault');
    useNavStore.setState({
      selection: { kind: 'doc', path: AGENT },
      history: [navSeed({ kind: 'home' }), navSeed({ kind: 'doc', path: AGENT })],
      historyIndex: 1,
    });
    useUiStore.setState({ docPanelOpen: false, docPanel: 'details' });
  });
  afterEach(cleanup);

  it('roots at Agents, with no folder crumbs', () => {
    render(<DocPage selection={{ kind: 'doc', path: AGENT }} />);
    expect(screen.getByTestId('doc-title').textContent).toBe('Release scout');
    expect(screen.queryByRole('button', { name: 'Records' })).toBeNull();
    expect(screen.queryByText('Records')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Agents' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'agents' });
  });

  it('shows its grants as its own rows, never the generic property surface', () => {
    render(<DocPage selection={{ kind: 'doc', path: AGENT }} />);
    expect(screen.getByTestId('agent-properties').textContent).toContain('records/risks/');
    expect(screen.queryByTestId('page-properties')).toBeNull();
    expect(screen.getByTestId('agent-dossier')).toBeTruthy();
  });

  it('opens its Runs tab through the selection and retains the document owner', async () => {
    const { rerender } = render(<DocPage selection={{ kind: 'doc', path: AGENT }} />);
    await waitFor(() => expect(screen.getByTestId('markdown-editor')).toBeTruthy(), {
      timeout: 5_000,
    });
    fireEvent.click(screen.getByTestId('record-tab-runs'));
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: AGENT, tab: 'runs' });
    rerender(<DocPage selection={{ kind: 'doc', path: AGENT, tab: 'runs' }} />);
    expect(screen.getByTestId('markdown-editor')).toBeTruthy();
    expect(screen.queryByTestId('page-body-start')).toBeNull();
    expect(await screen.findByTestId('agent-runs')).toBeTruthy();
    // The strip is the app's: nothing to add, rename or delete.
    expect(screen.queryByTestId('new-record-tab')).toBeNull();
  });

  it('offers no Add sub-page or Save as template, and keeps Rename and Trash', () => {
    render(<DocPage selection={{ kind: 'doc', path: AGENT }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Page options' }));
    const labels = screen.getAllByRole('menuitem').map((el) => el.textContent);
    expect(labels).not.toContain('Add sub-page');
    expect(labels).not.toContain('Save as template');
    expect(labels).toContain('Rename…');
    expect(labels).toContain('Move to Trash');
  });

  it('has Open with, like every page (M55.9)', () => {
    render(<DocPage selection={{ kind: 'doc', path: AGENT }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open with' }));
    expect(screen.getByTestId('open-with-default-editor')).toBeTruthy();
  });

  it('Details hold a read-only note, never the generic property editor', () => {
    useUiStore.setState({ docPanelOpen: true, docPanel: 'details', inspectorCollapsed: [] });
    render(<DocPage selection={{ kind: 'doc', path: AGENT }} />);
    const info = screen.getByTestId('agent-info');
    expect(info.textContent).toContain('Handle@release-scout');
    expect(info.textContent).toContain('Writes asprocess:release-scout');
    expect(info.title).toBe('Its settings are this page’s properties');
    expect(screen.queryByTestId('doc-properties')).toBeNull();
  });

  it('an empty agent gets no template bar, which an empty doc does', async () => {
    fs().set('notes/blank.md', '# Blank\n');
    fs().set('records/agents/blank.md', '---\ntype: Agent\npaused: true\n---\n\n# Blank agent\n');
    await useVaultStore.getState().rescan();

    // The control: an empty doc offers its templates.
    render(<DocPage selection={{ kind: 'doc', path: 'notes/blank.md' }} />);
    await waitFor(() => expect(screen.getByTestId('blank-page-bar')).toBeTruthy(), {
      timeout: 5_000,
    });
    cleanup();

    render(<DocPage selection={{ kind: 'doc', path: 'records/agents/blank.md' }} />);
    await waitFor(() => expect(screen.getByTestId('markdown-editor')).toBeTruthy(), {
      timeout: 5_000,
    });
    // A template's frontmatter could retype the agent it lands on.
    expect(screen.queryByTestId('blank-page-bar')).toBeNull();
  });
});
