// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '@/engine/types';
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
    useUiStore.setState({ typesOpen: true });
  });

  afterEach(cleanup);

  // M10: Collections are the top-level navigation, and the ONLY one — there is
  // no second grouping beside it, because a folder holding Lists is a
  // Collection so nothing can be orphaned. Projects are not a sidebar primitive.
  it('shows Collections as the only top-level grouping, and no project rows', () => {
    render(<Sidebar onNewView={vi.fn()} />);
    expect(screen.getByText('Collections')).toBeTruthy();
    // The folder holding the List is an implied Collection named after itself.
    expect(screen.getByText('Work')).toBeTruthy();
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
    fireEvent.contextMenu(screen.getByText('Work'));
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

  // M15: sidebar content is a function of the destination. Collections + 15
  // Types beside a settings form is ~25% of the window under navigation that
  // has no relationship to what is in view.
  it('does not render at all on Settings, Pulse or the Inbox', () => {
    for (const kind of ['settings', 'pulse', 'inbox'] as const) {
      useNavStore.setState({ selection: { kind } });
      const { container } = render(<Sidebar onNewView={vi.fn()} />);
      expect(container.firstChild).toBeNull();
      cleanup();
    }
  });

  // M15: the sidebar names the NAVIGATOR, not the page. As an h1 it gave Docs
  // two level-1 headings and left Inbox/Knowledge with none of their own.
  it('titles itself with an h2 so the page keeps the only h1', () => {
    render(<Sidebar onNewView={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Workspace', level: 2 })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Workspace', level: 1 })).toBeNull();
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

  // Task 14: on the Docs surfaces the sidebar is a Drive-style file tree.
  it('shows the file tree instead of projects on the Docs surface', () => {
    const doc = mkEntry({
      path: 'inbox/welcome.md',
      filename: 'welcome.md',
      title: 'Welcome',
    });
    useVaultStore.setState({ entries: [project, doc], folders: ['inbox', 'projects'] });
    useNavStore.setState({ selection: { kind: 'docs' } });
    render(<Sidebar onNewView={vi.fn()} />);
    expect(screen.getByText('Docs')).toBeTruthy();
    expect(screen.getByTestId('file-tree')).toBeTruthy();
    expect(screen.queryByTestId('sidebar-project')).toBeNull();
    expect(screen.queryByText('Urgent work')).toBeNull();
    // Clicking a doc file opens it full-page; project.md routes to the project.
    // Rows show humanized folder names and note titles (M2.x feedback).
    fireEvent.click(screen.getByRole('button', { name: /^Inbox/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Welcome/ }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'inbox/welcome.md' });
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

    it('collapses via the section header', () => {
      render(<Sidebar onNewView={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'Types' }));
      expect(screen.queryAllByTestId('sidebar-type')).toEqual([]);
      expect(useUiStore.getState().typesOpen).toBe(false);
    });

    it('the + button opens the Create-type dialog', () => {
      render(<Sidebar onNewView={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'New type' }));
      expect(screen.getByText('Create new type')).toBeTruthy();
    });

    it('right-click on a custom type offers rename and delete', () => {
      useVaultStore.setState({ entries: [project, recipeType] });
      render(<Sidebar onNewView={vi.fn()} />);
      fireEvent.contextMenu(screen.getByText('Recipe'));
      expect(screen.getByText('Change display name…')).toBeTruthy();
      expect(screen.getByText('Customize icon & color…')).toBeTruthy();
      expect(screen.getByText('Delete type')).toBeTruthy();
    });

    it('right-click on the metamodel only offers customize (locked)', () => {
      // M12.2: `Type` is the one remaining system type — the schema cannot
      // rename or delete itself. Every other type is fully editable.
      render(<Sidebar onNewView={vi.fn()} />);
      fireEvent.contextMenu(screen.getByText('Type'));
      expect(screen.getByText('Customize icon & color…')).toBeTruthy();
      expect(screen.queryByText('Change display name…')).toBeNull();
      expect(screen.queryByText('Delete type')).toBeNull();
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
