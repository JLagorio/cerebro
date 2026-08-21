// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry, Selection } from '@/engine/types';
import { useNavStore } from '@/stores/navStore';
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
          // The inbox label carries its count; everything else is a bare name.
          labels.push((button.getAttribute('aria-label') ?? '').replace(/ \(\d+\)$/, ''));
        }
      }
      return labels;
    };

    it('carries exactly the ten destinations the shell has', () => {
      render(<Sidebar onNewView={vi.fn()} />);
      const labels = surfaceLabels();
      // Studio is M40's (the third locked name, seated with Work); Agents is
      // M41's — the platform's front door, this high because D2 says agent
      // platform first.
      expect(labels).toEqual([
        'Home',
        'Inbox',
        'Agents',
        'Work',
        'Studio',
        'Base',
        'History',
        'Assistant',
        'Library',
        'Settings',
      ]);
      // M33a.2 folded the Status hub into Knowledge; M37.2 spent the locked
      // names (Base was Knowledge, Work was Workspace); M38.3 retired Docs —
      // pages are a standing tree section, not a destination. Each merge that
      // removes or renames a destination leaves the old name here, because
      // the failure mode is a label silently coming back.
      expect(labels).not.toContain('Status');
      expect(labels).not.toContain('Needs review');
      expect(labels).not.toContain('Background');
      expect(labels).not.toContain('Knowledge');
      expect(labels).not.toContain('Workspace');
      expect(labels).not.toContain('Docs');
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
        expect(surfaceLabels()).toHaveLength(10);
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
      useNavStore.setState({ selection: { kind: 'workspace' } });
      render(<Sidebar onNewView={vi.fn()} />);
      // Scoped: the demo fixtures hold a COLLECTION named Work too, and only
      // the destination row wears aria-current.
      const work = within(screen.getAllByTestId('nav-surfaces')[0]).getByRole('button', {
        name: 'Work',
      });
      expect(work.getAttribute('aria-current')).toBe('page');
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

    it('nests the Base nav rows under the Base row while on Base (M35 relocation)', () => {
      useNavStore.setState({ selection: { kind: 'knowledge' } });
      render(<Sidebar onNewView={vi.fn()} />);
      // The rows are KnowledgeNav's — same testid, same axes, new geometry.
      expect(screen.getAllByTestId('knowledge-nav-row').length).toBeGreaterThan(0);
      cleanup();
      // And gone the moment the surface is not current: content is still a
      // function of the destination (M15), it just stopped displacing the nav.
      useNavStore.setState({ selection: { kind: 'home' } });
      render(<Sidebar onNewView={vi.fn()} />);
      expect(screen.queryAllByTestId('knowledge-nav-row')).toEqual([]);
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
    expect(onNewView).toHaveBeenCalledWith('product');
  });

  // M15: the sidebar names the NAVIGATOR, not the page — as an h1 it gave Docs
  // two level-1 headings. M37.3: what it names is the VAULT now, because a nav
  // that is the whole shell answers "which vault" rather than "which mode".
  it('titles itself with the vault name as an h2 so the page keeps the only h1', () => {
    render(<Sidebar onNewView={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'demo-vault', level: 2 })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'demo-vault', level: 1 })).toBeNull();
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
});
