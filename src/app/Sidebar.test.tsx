// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry, Selection } from '@/engine/types';
import { useNavStore } from '@/stores/navStore';
import { useRootsStore } from '@/stores/rootsStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { Sidebar } from './Sidebar';

function mkEntry(partial: Partial<Entry> & { path: string }): Entry {
  return {
    filename: partial.path.split('/').pop() ?? '',
    folder: partial.path.includes('/') ? partial.path.slice(0, partial.path.lastIndexOf('/')) : '',
    project: null,
    title: 'Untitled',
    type: null,
    properties: {},
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '2026-07-01T00:00:00Z',
    modifiedAt: '2026-07-01T00:00:00Z',
    parseError: null,
    ...partial,
  };
}

const project = mkEntry({
  path: 'projects/foundations/project.md',
  filename: 'project.md',
  project: 'projects/foundations/project.md',
  title: 'Foundations',
  type: 'Project',
});

describe('Sidebar', () => {
  beforeEach(() => {
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entries: [project],
      views: [
        {
          id: 'urgent-work',
          project: null,
          collection: 'work',
          path: 'work/urgent-work.list.yml',
          definition: {
            name: 'Urgent work',
            icon: null,
            color: null,
            order: null,
            source: { type: null, project: null },
            views: [
              {
                id: 'view',
                name: 'View',
                icon: null,
                filters: null,
                presentation: {
                  type: 'list',
                  group: [{ field: 'status' }],
                  sort: [{ field: 'modifiedAt', dir: 'desc' }],
                  columns: [{ field: 'key' }, { field: 'status' }],
                },
              },
            ],
          },
        },
      ],
      status: 'ready',
      error: null,
    });
    useNavStore.setState({
      selection: { kind: 'home' },
      history: [{ kind: 'home' }],
      historyIndex: 0,
    });
    useUiStore.setState({
      typesOpen: true,
      inboxEnabled: true,
      inboxPeriod: 'all',
      aiPanelOpen: false,
      sidebarCollapsed: false,
      // The nav groups open (M42.2) — a fold left behind by another test is
      // state, not a default.
      navClosed: [],
    });
  });

  afterEach(cleanup);

  /**
   * The shell's destinations, asserted rather than assumed.
   *
   * This contract lived in `Rail.test.tsx` from M33.4 until M37.3 retired the
   * rail; the flattened nav column inherits it whole. The list is the
   * assertion: adding or removing a destination is a decision, and a decision
   * belongs in a diff somebody reads.
   */
  describe('destinations contract (was Rail.test.tsx, M37.3)', () => {
    const surfaceLabels = () => {
      const labels: string[] = [];
      for (const group of screen.getAllByTestId('nav-surfaces')) {
        for (const button of within(group).getAllByRole('button')) {
          // The inbox label carries its count; the footer rows name
          // themselves by text. Everything else is a bare aria-label.
          labels.push(
            (button.getAttribute('aria-label') ?? button.textContent ?? '').replace(
              / \(\d+\)$/,
              '',
            ),
          );
        }
      }
      return labels;
    };

    it('carries exactly the destinations the shell has (M43)', () => {
      render(<Sidebar onNewView={vi.fn()} />);
      const labels = surfaceLabels();
      // M43: Inbox leads (the design's hot queue), My work is new, Library
      // came up from the footer, and the footer holds Theme + Settings.
      // M43.10: Work and Base left the destinations for SECTIONS — their
      // subjects list like every other shelf — so Studio and History stand
      // alone under My work.
      expect(labels).toEqual([
        'Inbox',
        'Home',
        'My work',
        'Studio',
        'History',
        'Library',
        'Theme',
        'Settings',
      ]);
      // M33a.2 folded the Status hub into Knowledge; M37.2 spent the locked
      // names (Base was Knowledge, Work was Workspace); M38.3 retired Docs —
      // pages are a standing tree section, not a destination. M43 moved
      // Agents into a section and the Assistant onto the header zap. Each
      // merge that removes or renames a destination leaves the old name here,
      // because the failure mode is a label silently coming back.
      expect(labels).not.toContain('Status');
      expect(labels).not.toContain('Needs review');
      expect(labels).not.toContain('Background');
      expect(labels).not.toContain('Knowledge');
      expect(labels).not.toContain('Workspace');
      expect(labels).not.toContain('Docs');
      expect(labels).not.toContain('Agents');
      expect(labels).not.toContain('Assistant');
      expect(labels).not.toContain('Work');
      expect(labels).not.toContain('Base');
    });

    it('renders on every surface — the SIDEBARLESS set retired with the rail (M37.3)', () => {
      // These six returned `null` while the sidebar was contextual: their
      // objection was Collections-and-Types-as-irrelevant-width. A nav that is
      // the whole shell is not irrelevant to any surface, and a one-column
      // shell with no column is no shell at all.
      const surfaces: Selection[] = [
        { kind: 'settings' },
        { kind: 'pulse' },
        { kind: 'inbox' },
        { kind: 'library' },
        { kind: 'workspace' },
        { kind: 'diagram', path: 'diagrams/pipeline.mmd' },
      ];
      for (const selection of surfaces) {
        useNavStore.setState({ selection });
        render(<Sidebar onNewView={vi.fn()} />);
        expect(surfaceLabels()).toHaveLength(8);
        cleanup();
      }
    });

    it('lets the Pages tree carry a doc page — no destination claims it (M38.3)', () => {
      // A doc used to light the Docs destination; with the surface gone the
      // open page is marked in the tree itself, and every destination row
      // stays dark rather than one of them lying about where you are.
      useNavStore.setState({ selection: { kind: 'doc', path: 'inbox/welcome.md' } });
      const { container } = render(<Sidebar onNewView={vi.fn()} />);
      expect(
        container.querySelectorAll('[data-testid="nav-surfaces"] [aria-current="page"]'),
      ).toHaveLength(0);
      cleanup();

      // M12.5: projects retired — a container selection is a Collection.
      useNavStore.setState({ selection: { kind: 'collection', folder: 'projects/x' } });
      render(<Sidebar onNewView={vi.fn()} />);
      expect(screen.getByRole('button', { name: 'Home' }).getAttribute('aria-current')).toBe(
        'page',
      );
    });

    // M15: Home's active state used to be computed by negating every other
    // slot, so any kind nobody remembered to negate lit it up.
    it('leaves Home dark on the surfaces another slot owns', () => {
      for (const selection of [
        { kind: 'settings' } as const,
        { kind: 'changes' } as const,
        { kind: 'knowledge' } as const,
        { kind: 'diagram', path: 'diagrams/pipeline.mmd' } as const,
      ]) {
        useNavStore.setState({ selection });
        render(<Sidebar onNewView={vi.fn()} />);
        expect(
          screen.getByRole('button', { name: 'Home' }).getAttribute('aria-current'),
        ).toBeNull();
        cleanup();
      }
    });

    it('marks the current destination with aria-current and the assistant with aria-pressed', () => {
      useNavStore.setState({ selection: { kind: 'studio' } });
      render(<Sidebar onNewView={vi.fn()} />);
      // Scoped to the destination containers: only the destination row wears
      // aria-current (M43.10 — Studio is a standalone row, lit for the whole
      // surface now that no prototype rows nest under it).
      const studio = screen
        .getAllByTestId('nav-surfaces')
        .map((group) => within(group).queryByRole('button', { name: 'Studio' }))
        .find((button) => button != null);
      expect(studio?.getAttribute('aria-current')).toBe('page');
      // A toggle is not a destination: it reports pressed, never current.
      const assistant = screen.getByRole('button', { name: 'Assistant' });
      expect(assistant.getAttribute('aria-pressed')).toBe('false');
      expect(assistant.getAttribute('aria-current')).toBeNull();
      fireEvent.click(assistant);
      expect(screen.getByRole('button', { name: 'Assistant' }).getAttribute('aria-pressed')).toBe(
        'true',
      );
    });

    // M15: the badge counted every period while the page opened on a persisted
    // one, so a nav reading "Inbox 2" could land on an empty screen.
    it('counts the period the Inbox will actually open on', () => {
      const capture = (path: string, daysAgo: number): Entry =>
        mkEntry({
          path,
          folder: 'inbox',
          createdAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
          modifiedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
        });
      useVaultStore.setState({ entries: [capture('inbox/a.md', 1), capture('inbox/b.md', 40)] });
      render(<Sidebar onNewView={vi.fn()} />);
      expect(screen.getByRole('button', { name: 'Inbox (2)' })).toBeTruthy();
      cleanup();

      useUiStore.setState({ inboxPeriod: 'week' });
      render(<Sidebar onNewView={vi.fn()} />);
      expect(screen.getByRole('button', { name: 'Inbox (1)' })).toBeTruthy();
    });

    it('keeps the Base rows available on every surface, lighting none while elsewhere (M42.2)', () => {
      // M37.3 nested these rows under Base only WHILE current; the Notion turn
      // makes them standing — "we see it all there, available" — and the
      // un-current nav elects no default row, because a highlight naming a
      // view that is not on screen is worse than none.
      useNavStore.setState({ selection: { kind: 'home' } });
      render(<Sidebar onNewView={vi.fn()} />);
      const rows = screen.getAllByTestId('knowledge-nav-row');
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.filter((row) => row.getAttribute('aria-current') === 'page')).toEqual([]);
    });

    it('lists the vault agents in the Agents SECTION, whose header folds it (M43)', () => {
      useVaultStore.setState({
        entries: [
          project,
          mkEntry({ path: 'records/agents/scout.md', title: 'Scout', type: 'Agent' }),
        ],
      });
      render(<Sidebar onNewView={vi.fn()} />);
      // The row is a destination for ONE agent — and it lives outside the
      // `nav-surfaces` containers, so an agent named after a destination can
      // never be caught by a spec scoped to them.
      fireEvent.click(screen.getByTestId('nav-agent'));
      expect(useNavStore.getState().selection).toEqual({
        kind: 'agents',
        actor: 'process:scout',
      });
      // The header's reveals: ↗ is the door to the fleet, ＋ starts a new
      // agent — the affordances the destination row and its nested "New
      // agent" row used to carry.
      fireEvent.click(screen.getByRole('button', { name: 'Open all agents' }));
      expect(useNavStore.getState().selection).toEqual({ kind: 'agents' });
      // Folding is not navigating: the header hides the rows and the
      // selection stays where it was.
      const head = screen.getByRole('button', { name: 'Agents' });
      expect(head.getAttribute('aria-expanded')).toBe('true');
      fireEvent.click(head);
      expect(screen.queryAllByTestId('nav-agent')).toEqual([]);
      expect(useNavStore.getState().selection).toEqual({ kind: 'agents' });
      // The header action survives the fold — creation is not membership.
      expect(screen.getByTestId('nav-agent-new')).toBeTruthy();
    });

    it('the search row opens QuickOpen', () => {
      render(<Sidebar onNewView={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));
      expect(useUiStore.getState().quickOpenVisible).toBe(true);
    });
  });

  // M10: Collections are the top-level navigation, and the ONLY one — there is
  // no second grouping beside it, because a folder holding Lists is a
  // Collection so nothing can be orphaned. Projects are not a sidebar primitive.
  it('shows Collections as the only top-level grouping, and no project rows', () => {
    render(<Sidebar onNewView={vi.fn()} />);
    expect(screen.getByText('Collections')).toBeTruthy();
    // The folder holding the List is an implied Collection named after itself.
    // Scoped to the tree: the Work DESTINATION row (M37.2's locked name)
    // shares the accessible name now that both live in one column.
    expect(
      screen.getAllByTestId('collection-node-collection').some((n) => n.dataset.id === 'work'),
    ).toBe(true);
    expect(screen.queryByText('Lists')).toBeNull();
    expect(screen.queryByTestId('sidebar-project')).toBeNull();
    expect(screen.queryByText('New project')).toBeNull();
  });

  it('clicking a List navigates to it, carrying its collection', () => {
    useUiStore.setState({ expandedFolders: { 'collection:work': true } });
    render(<Sidebar onNewView={vi.fn()} />);
    fireEvent.click(screen.getByText('Urgent work'));
    // The collection is part of the key: ids are unique per folder only.
    expect(useNavStore.getState().selection).toEqual({
      kind: 'list',
      id: 'urgent-work',
      collection: 'work',
    });
  });

  // An implied Collection has no marker, so there is nothing to remove — and an
  // action that silently does nothing is worse than one that is absent.
  it('offers no Remove on an implied Collection, but does on a declared one', () => {
    render(<Sidebar onNewView={vi.fn()} />);
    const workNode = screen
      .getAllByTestId('collection-node-collection')
      .find((n) => n.dataset.id === 'work');
    if (workNode === undefined) throw new Error('implied Work collection not rendered');
    fireEvent.contextMenu(workNode);
    expect(screen.getByText('Rename…')).toBeTruthy();
    expect(screen.queryByText(/Remove collection/)).toBeNull();
  });

  it('the + button opens the new-collection dialog', () => {
    render(<Sidebar onNewView={vi.fn()} />);
    fireEvent.click(screen.getByTestId('new-collection'));
    expect(screen.getByRole('textbox', { name: 'Collection name' })).toBeTruthy();
  });

  it('shows an empty hint when the vault has no collections and no lists', () => {
    useVaultStore.setState({ entries: [], views: [], collections: [] });
    render(<Sidebar onNewView={vi.fn()} />);
    expect(screen.getByText(/No collections yet/)).toBeTruthy();
  });

  // M10: the tree — a Collection expands to reveal its Lists and Docs, and its
  // hover + creates a List INTO that collection rather than at the top level.
  it('expands a Collection to reveal its Lists', () => {
    const roadmap = {
      id: 'roadmap',
      project: null,
      collection: 'product',
      path: 'product/roadmap.list.yml',
      definition: {
        name: 'Roadmap',
        icon: null,
        color: null,
        order: null,
        source: { type: null, project: null },
        views: [
          {
            id: 'view',
            name: 'View',
            icon: null,
            filters: null,
            presentation: {
              type: 'table' as const,
              group: [],
              sort: [{ field: 'modifiedAt', dir: 'desc' as const }],
              columns: [],
            },
          },
        ],
      },
    };
    useVaultStore.setState({
      views: [roadmap],
      collections: [
        {
          folder: 'product',
          declared: true,
          definition: { name: 'Product', icon: null, color: null, order: null, description: null },
        },
      ],
    });
    useUiStore.setState({ expandedFolders: {} });
    render(<Sidebar onNewView={vi.fn()} />);
    // Collapsed: the Collection shows, its contents do not.
    expect(screen.getByText('Product')).toBeTruthy();
    expect(screen.queryByText('Roadmap')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Product' }));
    expect(screen.getByText('Roadmap')).toBeTruthy();
  });

  it('creates a List into the Collection whose + was clicked', () => {
    const onNewView = vi.fn();
    useVaultStore.setState({
      views: [],
      collections: [
        {
          folder: 'product',
          declared: true,
          definition: { name: 'Product', icon: null, color: null, order: null, description: null },
        },
      ],
    });
    render(<Sidebar onNewView={onNewView} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to Product' }));
    // M47.5: the `+` opens a MENU now. It used to go straight to the New list
    // dialog, which is why a collection could hold nothing but lists and its
    // empty page could only tell you to come back here. A page comes first.
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['New page', 'New database', 'New list']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'New list' }));
    expect(onNewView).toHaveBeenCalledWith('product');
  });

  // M37.3 made the header answer "which vault"; M43 moved that answer onto
  // the tile (the slot the design gives an avatar) so the wordmark could take
  // the line — and no heading at all, so every page keeps its own h1 story.
  it('wears the vault as the header tile (M43)', () => {
    render(<Sidebar onNewView={vi.fn()} />);
    const tile = screen.getByTestId('vault-tile');
    expect(tile.getAttribute('title')).toBe('demo-vault');
    expect(tile.textContent).toBe('D');
    expect(screen.queryByRole('heading', { name: 'demo-vault' })).toBeNull();
  });

  // M15: `flex-none` here was what made the canvas absorb every pixel of a
  // narrow window. The sidebar has to be the column that yields.
  it('is shrinkable down to its minimum rather than fixed', () => {
    const { container } = render(<Sidebar onNewView={vi.fn()} />);
    const nav = container.querySelector('nav');
    expect(nav?.className).not.toContain('flex-none');
    expect(nav?.style.minWidth).toBe('180px');
  });

  it('draws at its minimum and withdraws the resize handle while narrow', () => {
    useUiStore.setState({ sidebarWidth: 420 });
    const { container } = render(<Sidebar narrow onNewView={vi.fn()} />);
    expect(container.querySelector('nav')?.style.width).toBe('180px');
    expect(screen.queryByRole('separator', { name: 'Resize sidebar' })).toBeNull();
    cleanup();
    // The STORED preference is untouched — widening the window restores it.
    expect(useUiStore.getState().sidebarWidth).toBe(420);
    const wide = render(<Sidebar onNewView={vi.fn()} />);
    expect(wide.container.querySelector('nav')?.style.width).toBe('420px');
  });

  // Task 14 / M38.3: the Drive-style file tree is the standing Pages section
  // now — the Docs destination died with its surface, and in a shell where
  // everything is a page the pages ARE navigation, not a mode.
  it('carries the Pages tree on every surface', () => {
    const doc = mkEntry({
      path: 'inbox/welcome.md',
      filename: 'welcome.md',
      title: 'Welcome',
    });
    useVaultStore.setState({ entries: [project, doc], folders: ['inbox', 'projects'] });
    render(<Sidebar onNewView={vi.fn()} />);
    const fileTree = screen.getByTestId('file-tree');
    expect(screen.queryByTestId('sidebar-project')).toBeNull();
    // Scoped into the tree: the Inbox DESTINATION row shares the accessible
    // name with the inbox/ FOLDER row now that both live in one column.
    // Clicking a doc file opens it full-page; project.md routes to the project.
    // Rows show humanized folder names and note titles (M2.x feedback).
    fireEvent.click(within(fileTree).getByRole('button', { name: /^Inbox/ }));
    fireEvent.click(within(fileTree).getByRole('button', { name: /^Welcome/ }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'inbox/welcome.md' });
    cleanup();
    // And it does NOT withdraw off the doc surfaces — that was the mode the
    // Docs destination gated, and both retired together.
    useNavStore.setState({ selection: { kind: 'settings' } });
    render(<Sidebar onNewView={vi.fn()} />);
    expect(screen.getByTestId('file-tree')).toBeTruthy();
  });

  // M3: collapsible Types section above Views.
  describe('Types section', () => {
    const recipeType = mkEntry({
      path: 'types/recipe.md',
      title: 'Recipe',
      type: 'Type',
      properties: { icon: 'chef-hat', color: '#DE8F0A' },
    });

    it('lists declared and referenced types with record counts', () => {
      useVaultStore.setState({
        entries: [
          project,
          recipeType,
          mkEntry({ path: 'recipes/pasta.md', title: 'Pasta', type: 'Recipe' }),
          mkEntry({ path: 'recipes/soup.md', title: 'Soup', type: 'Recipe' }),
        ],
      });
      render(<Sidebar onNewView={vi.fn()} />);
      const rows = screen.getAllByTestId('sidebar-type');
      const labels = rows.map((r) => r.textContent);
      // M12.2: no standing system rows — Project appears because a record
      // references it (ghost), Recipe because it is declared, Type because
      // the metamodel always exists. No phantom "Work item 0".
      expect(labels).toEqual(['Project1', 'Recipe2', 'Type1']);
    });

    it('clicking a type navigates to the type screen', () => {
      useVaultStore.setState({ entries: [project, recipeType] });
      render(<Sidebar onNewView={vi.fn()} />);
      fireEvent.click(screen.getByText('Recipe'));
      expect(useNavStore.getState().selection).toEqual({ kind: 'type', name: 'Recipe' });
    });

    // M39.2: the section wears the word it always meant — Databases. The
    // internal vocabulary (`type:`, TypeListing, the `type` kind, this very
    // testid) deliberately keeps the old word: labels spend, kinds stay.
    it('collapses via the section header', () => {
      render(<Sidebar onNewView={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'Databases' }));
      expect(screen.queryAllByTestId('sidebar-type')).toEqual([]);
      expect(useUiStore.getState().typesOpen).toBe(false);
    });

    it('the + button opens the New-database dialog', () => {
      render(<Sidebar onNewView={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'New database' }));
      expect(screen.getByText('New database')).toBeTruthy();
    });

    it('right-click on a custom type offers rename and delete', () => {
      useVaultStore.setState({ entries: [project, recipeType] });
      render(<Sidebar onNewView={vi.fn()} />);
      fireEvent.contextMenu(screen.getByText('Recipe'));
      expect(screen.getByText('Change display name…')).toBeTruthy();
      expect(screen.getByText('Customize icon & color…')).toBeTruthy();
      expect(screen.getByText('Delete database')).toBeTruthy();
    });

    it('right-click on the metamodel only offers customize (locked)', () => {
      // M12.2: `Type` is the one remaining system type — the schema cannot
      // rename or delete itself. Every other type is fully editable.
      render(<Sidebar onNewView={vi.fn()} />);
      fireEvent.contextMenu(screen.getByText('Type'));
      expect(screen.getByText('Customize icon & color…')).toBeTruthy();
      expect(screen.queryByText('Change display name…')).toBeNull();
      expect(screen.queryByText('Delete database')).toBeNull();
    });
  });

  // Task 6: project-scoped views belong to their project's tabs, not here.
  // A project-scoped List is a project tab. It gets no sidebar node AND no
  // implied Collection for its folder — its home is the project, not a container.
  it('keeps project-scoped Lists out of the Collections tree entirely', () => {
    const scoped = {
      ...useVaultStore.getState().views[0],
      id: 'delivery',
      project: 'projects/foundations/project.md',
      collection: null,
      path: 'projects/foundations/views/delivery.yml',
      definition: { ...useVaultStore.getState().views[0].definition, name: 'Delivery' },
    };
    useVaultStore.setState({ views: [...useVaultStore.getState().views, scoped] });
    useUiStore.setState({ expandedFolders: { 'collection:work': true } });
    render(<Sidebar onNewView={vi.fn()} />);
    expect(screen.getByText('Urgent work')).toBeTruthy();
    expect(screen.queryByText('Delivery')).toBeNull();
    // No "Views"/"Foundations" container conjured from its folder either.
    expect(screen.queryByText('Views')).toBeNull();
  });
  // M43 — the new shelves.
  describe('M43 sections', () => {
    it("counts open work on the My work row — the page's own membership rule", () => {
      useVaultStore.setState({
        entries: [
          project,
          mkEntry({
            path: 'types/task.md',
            title: 'Task',
            type: 'Type',
            properties: {
              fields: { status: { kind: 'status' } },
              statuses: [
                { id: 'todo', group: 'active' },
                { id: 'done', group: 'done' },
              ],
            } as unknown as Entry['properties'],
          }),
          mkEntry({
            path: 'records/tasks/open.md',
            title: 'Open task',
            type: 'Task',
            properties: { status: 'todo' } as unknown as Entry['properties'],
          }),
          mkEntry({
            path: 'records/tasks/shipped.md',
            title: 'Shipped task',
            type: 'Task',
            properties: { status: 'done' } as unknown as Entry['properties'],
          }),
        ],
      });
      render(<Sidebar onNewView={vi.fn()} />);
      const row = screen.getByRole('button', { name: 'My work (1)' });
      fireEvent.click(row);
      expect(useNavStore.getState().selection).toEqual({ kind: 'mywork' });
    });

    it('says the empty Favorites in words — nobody pinned anything is a real zero', () => {
      useUiStore.setState({ favorites: {} });
      render(<Sidebar onNewView={vi.fn()} />);
      expect(screen.getByText('No favorites yet')).toBeTruthy();
    });

    it('renders a pinned page as a row and prunes a pointer whose file is gone', () => {
      useVaultStore.setState({
        entries: [project, mkEntry({ path: 'notes/keep.md', title: 'Keep me' })],
      });
      useUiStore.setState({ favorites: { '/demo-vault': ['notes/keep.md', 'notes/gone.md'] } });
      render(<Sidebar onNewView={vi.fn()} />);
      const rows = screen.getAllByTestId('nav-favorite');
      expect(rows.map((r) => r.textContent)).toEqual(['Keep me']);
      // The dead pointer left the STORE, not just the render — the list is
      // truthful, and the next session does not resurrect it.
      expect(useUiStore.getState().favorites['/demo-vault']).toEqual(['notes/keep.md']);
      fireEvent.click(rows[0]);
      expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'notes/keep.md' });
    });

    it("creates pages from the Pages header through the tree's own dialog", () => {
      render(<Sidebar onNewView={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'New page' }));
      // The FileTree's dialog — one creation flow, now opened from the header.
      expect(screen.getByRole('dialog', { name: 'New page' })).toBeTruthy();
    });

    it('lists mounted repos in the Work SECTION, whose ↗ opens the surface (M43.10)', () => {
      useRootsStore.setState({
        roots: [
          {
            id: 'cerebro',
            label: 'cerebro',
            path: '/repos/cerebro',
            alias: '',
            color: null,
            caps: { knowledge: false, git: false, writable: false },
          },
        ],
      });
      render(<Sidebar onNewView={vi.fn()} />);
      // Each mounted folder is a row, like every other shelf's subjects.
      fireEvent.click(screen.getByTestId('nav-root'));
      expect(useNavStore.getState().selection).toEqual({ kind: 'workspace', root: 'cerebro' });
      // The ↗ is the door to the whole surface — the destination row died.
      fireEvent.click(screen.getByRole('button', { name: 'Open all repositories' }));
      expect(useNavStore.getState().selection).toEqual({ kind: 'workspace' });
    });

    it('says the empty Work section in words — nothing mounted is a real zero', () => {
      useRootsStore.setState({ roots: [] });
      render(<Sidebar onNewView={vi.fn()} />);
      expect(screen.getByText('No repositories mounted')).toBeTruthy();
    });

    it('opens the Base home from the section’s ↗ (M43.10)', () => {
      render(<Sidebar onNewView={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'Open base' }));
      expect(useNavStore.getState().selection).toEqual({ kind: 'knowledge' });
    });

    it('cycles the theme from the footer', () => {
      useUiStore.setState({ themeMode: 'system' });
      render(<Sidebar onNewView={vi.fn()} />);
      const theme = screen.getByRole('button', { name: 'Theme' });
      fireEvent.click(theme);
      expect(useUiStore.getState().themeMode).toBe('light');
      fireEvent.click(theme);
      expect(useUiStore.getState().themeMode).toBe('dark');
      fireEvent.click(theme);
      expect(useUiStore.getState().themeMode).toBe('system');
    });
  });
});
