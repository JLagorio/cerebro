// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    // M45.2 Task 6 (2026-08-28 plan): the corpus Work item wears `layout:`
    // now, so the stack opens behind the strip's View details toggle.
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
    // closing fence, rescan, pick a Work item. The splice lands right after
    // the `fields:` mapping, so a two-space-indented first line can grow the
    // roster before the top-level keys start.
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
      expect(screen.getByTestId('page-properties')).toBeTruthy();
      fireEvent.click(screen.getByTestId('view-details-toggle'));
      expect(screen.queryByTestId('page-properties')).toBeNull();
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

    it('no layout → no strip, and the stack renders exactly as today', async () => {
      // M45.2 Task 6 (2026-08-28 plan): the corpus doc carries a layout now,
      // so this case stages its no-layout baseline explicitly.
      const record = await setTypeFrontmatter('');
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
    // every one has to stand on every tab. No `heading:` here, so the stack
    // is not folded behind the strip's toggle — that fold is its own case
    // below, and it is the ONE gate this slice leaves in place.
    const SECTIONS =
      'layout:\n' +
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

    // Everything is asserted INSIDE the page stack. The doc side panel
    // renders a second `DocProperties` holding the same groups, and it is
    // only off screen here because `docPanelTab` happens to default to
    // 'outline' — a default this file must not depend on.
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

    // The other half of the correction: the tab holds only ITS content, so
    // the body is the Overview tab's and nobody else's.
    it('the body editor renders on the overview tab and nowhere else', async () => {
      const record = await stageTabs();
      const { unmount } = render(
        <DocPage selection={{ kind: 'doc', path: record.path, tab: 'spec' }} />,
      );
      expect(screen.queryByTestId('markdown-editor')).toBeNull();
      unmount();
      render(<DocPage selection={{ kind: 'doc', path: record.path }} />);
      await waitFor(() => expect(screen.getByTestId('markdown-editor')).toBeTruthy(), {
        timeout: 5_000,
      });
    });

    // The strip's expander is the one thing that still hides the stack, and
    // it is offered on EVERY tab now: the stack it opens is the same stack on
    // all of them, so a toggle missing here would strand the sections behind
    // a strip that has no way to open.
    it('the strip folds the stack behind its toggle on a view tab too', async () => {
      const record = await stage(
        TABS + SECTIONS.replace('layout:\n', 'layout:\n  heading: [status]\n'),
      );
      render(<DocPage selection={{ kind: 'doc', path: record.path, tab: 'items' }} />);
      expect(screen.getByTestId('heading-strip')).toBeTruthy();
      expect(screen.queryByTestId('page-properties')).toBeNull();
      fireEvent.click(screen.getByTestId('view-details-toggle'));
      expect(groupIds()).toEqual(['planning', 'links', 'extra']);
    });
  });

  // M45.4 — the view swap arm: a record tab backed by a database view. The
  // tab's CONTENT is the database — no body editor — and a dead pointer
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
      expect(screen.getByTestId('view-tab-embed')).toBeTruthy();
      // The two items blocked BY this host…
      expect(screen.getByText('Hold both versions instead of discarding')).toBeTruthy();
      expect(screen.getByText('Instrument conflict rate separately from sync errors')).toBeTruthy();
      // …and not the one blocked by a different record.
      expect(screen.queryByText('Recover gracefully from the first failed sync')).toBeNull();
      expect(screen.getAllByTestId('table-row')).toHaveLength(2);
      // The tab holds the database and nothing else: no body editor —
      // `showsEditor` stays false, the M44.5 reset key untouched. The
      // record's own stack stands above the strip (M46.1), unfolded here
      // because the corpus layout was stripped.
      expect(screen.queryByTestId('markdown-editor')).toBeNull();
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
      history: [{ kind: 'home' }],
      historyIndex: 0,
    });
    useUiStore.setState({ docPanelOpen: false, docPanelTab: 'outline' });
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
    useUiStore.setState({ docPanelOpen: false, docPanelTab: 'outline', toasts: [] });
  });
  afterEach(cleanup);

  it('a deep link opens the panel on Comments and focuses its thread', async () => {
    render(<DocPage selection={{ kind: 'doc', path: DOC, thread: THREAD }} />);
    const card = await screen.findByTestId('comment-thread');
    expect(card.dataset.threadId).toBe(THREAD);
    await waitFor(() => expect(card.dataset.focused).toBe('true'));
    expect(useUiStore.getState().docPanelOpen).toBe(true);
    expect(useUiStore.getState().docPanelTab).toBe('comments');
    expect(screen.getByTestId('doc-panel-comment-count').textContent).toBe('1');
  });

  it('a deep link to a thread that is gone says so once', async () => {
    render(<DocPage selection={{ kind: 'doc', path: DOC, thread: 'ffffffffffffffff' }} />);
    await waitFor(() =>
      expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual([
        'That comment is no longer on this page.',
      ]),
    );
    expect(useUiStore.getState().docPanelTab).toBe('comments');
  });
});

describe('a concept is a page (M50.1)', () => {
  const CONCEPT = 'knowledge/playbooks/warehouse-cutover.md';

  beforeEach(async () => {
    resetMockFs();
    await useVaultStore.getState().openVault('/demo-vault');
    useNavStore.setState({
      selection: { kind: 'doc', path: CONCEPT },
      history: [{ kind: 'home' }],
      historyIndex: 0,
    });
    useUiStore.setState({
      docPanelOpen: true,
      conceptPanelOpen: false,
      conceptPanelTab: 'details',
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
    // The panel opens on the concept's details, with no Info tab.
    fireEvent.click(screen.getByRole('button', { name: 'Show panel' }));
    expect(screen.getByTestId('knowledge-panel')).toBeTruthy();
    expect(screen.queryByTestId('doc-panel-tab-info')).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: 'Show panel' }));
    fireEvent.click(screen.getByTestId('doc-panel-tab-comments'));
    expect(useUiStore.getState().conceptPanelTab).toBe('comments');
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
      history: [{ kind: 'home' }, { kind: 'doc', path: AGENT }],
      historyIndex: 1,
    });
    useUiStore.setState({ docPanelOpen: false, docPanelTab: 'outline' });
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

  it('opens its Runs tab through the selection, and the editor leaves', async () => {
    const { rerender } = render(<DocPage selection={{ kind: 'doc', path: AGENT }} />);
    await waitFor(() => expect(screen.getByTestId('markdown-editor')).toBeTruthy(), {
      timeout: 5_000,
    });
    fireEvent.click(screen.getByTestId('record-tab-runs'));
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: AGENT, tab: 'runs' });
    rerender(<DocPage selection={{ kind: 'doc', path: AGENT, tab: 'runs' }} />);
    expect(screen.queryByTestId('markdown-editor')).toBeNull();
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

  it('Info is a read-only note, never the generic property editor', () => {
    useUiStore.setState({ docPanelOpen: true, docPanelTab: 'info' });
    render(<DocPage selection={{ kind: 'doc', path: AGENT }} />);
    const info = screen.getByTestId('agent-info');
    expect(info.textContent).toContain(
      'Answers to @release-scout; writes as process:release-scout',
    );
    expect(info.textContent).toContain('Its settings are this page’s properties');
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
