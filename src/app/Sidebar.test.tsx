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
          definition: {
            name: 'Urgent work',
            icon: null,
            color: null,
            order: null,
            source: { type: null, project: null },
            filters: null,
            presentation: {
              type: 'list',
              group: [{ field: 'status' }],
              sort: [{ field: 'modifiedAt', dir: 'desc' }],
              columns: [{ field: 'key' }, { field: 'status' }],
            },
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

  // M3.5: views are the top-level navigation; projects are no longer a
  // sidebar primitive (a project is a saved view over Work items).
  it('lists saved views above the types, and no project rows', () => {
    render(<Sidebar onNewView={vi.fn()} />);
    expect(screen.getByText('Urgent work')).toBeTruthy();
    expect(screen.queryByTestId('sidebar-project')).toBeNull();
    expect(screen.queryByText('New project')).toBeNull();
  });

  it('clicking a view navigates to it', () => {
    render(<Sidebar onNewView={vi.fn()} />);
    fireEvent.click(screen.getByText('Urgent work'));
    expect(useNavStore.getState().selection).toEqual({ kind: 'view', id: 'urgent-work' });
  });

  it('the + button opens the view builder', () => {
    const onNewView = vi.fn();
    render(<Sidebar onNewView={onNewView} />);
    fireEvent.click(screen.getByTestId('new-view'));
    expect(onNewView).toHaveBeenCalledTimes(1);
  });

  it('shows an empty hint when the vault has no saved views', () => {
    useVaultStore.setState({ entries: [], views: [] });
    render(<Sidebar onNewView={vi.fn()} />);
    expect(screen.getByText(/No views yet/)).toBeTruthy();
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

    it('lists system types plus declared types with record counts', () => {
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
      // Project (1 record), Recipe (2), Type (1 type doc), Work item (0).
      expect(labels).toEqual(['Project1', 'Recipe2', 'Type1', 'Work item0']);
    });

    it('clicking a type navigates to the type screen', () => {
      render(<Sidebar onNewView={vi.fn()} />);
      fireEvent.click(screen.getByText('Work item'));
      expect(useNavStore.getState().selection).toEqual({ kind: 'type', name: 'Work item' });
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

    it('right-click on a system type only offers customize (locked)', () => {
      render(<Sidebar onNewView={vi.fn()} />);
      fireEvent.contextMenu(screen.getByText('Work item'));
      expect(screen.getByText('Customize icon & color…')).toBeTruthy();
      expect(screen.queryByText('Change display name…')).toBeNull();
      expect(screen.queryByText('Delete type')).toBeNull();
    });
  });

  // Task 6: project-scoped views belong to their project's tabs, not here.
  it('hides project-scoped views from the Views section', () => {
    const scoped = {
      ...useVaultStore.getState().views[0],
      id: 'delivery',
      project: 'projects/foundations/project.md',
      definition: { ...useVaultStore.getState().views[0].definition, name: 'Delivery' },
    };
    useVaultStore.setState({ views: [...useVaultStore.getState().views, scoped] });
    render(<Sidebar onNewView={vi.fn()} />);
    expect(screen.getByText('Urgent work')).toBeTruthy();
    expect(screen.queryByText('Delivery')).toBeNull();
  });
});
