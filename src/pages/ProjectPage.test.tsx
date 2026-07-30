// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entry, ListFile } from '@/engine/types';
import * as ipc from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { ProjectPage } from './ProjectPage';

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

const FOUNDATIONS = 'projects/foundations/project.md';
const project = mkEntry({
  path: FOUNDATIONS,
  filename: 'project.md',
  project: FOUNDATIONS,
  title: 'Foundations',
  type: 'Project',
  properties: { key: 'FLD' },
});
const item = mkEntry({
  path: 'projects/foundations/items/fld-1.md',
  filename: 'fld-1.md',
  project: FOUNDATIONS,
  title: 'Ship tokens',
  type: 'Work item',
  properties: { status: 'todo', key: 'FLD-1' },
});

const boardView: ListFile = {
  id: 'all-board',
  project: null,
  collection: null,
  path: 'all-board.list.yml',
  definition: {
    name: 'All board',
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
          type: 'board',
          group: [{ field: 'status' }],
          sort: [{ field: 'modifiedAt', dir: 'desc' }],
          columns: [{ field: 'key' }, { field: 'status' }],
        },
      },
    ],
  },
};

describe('ProjectPage', () => {
  beforeEach(() => {
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entries: [project, item],
      views: [boardView],
      status: 'ready',
      error: null,
    });
    useNavStore.setState({
      selection: { kind: 'project', path: FOUNDATIONS },
      history: [{ kind: 'home' }],
      historyIndex: 0,
    });
  });

  afterEach(cleanup);

  it('renders the project header and defaults to the list view', () => {
    render(<ProjectPage selection={{ kind: 'project', path: FOUNDATIONS }} />);
    expect(screen.getByText('Foundations')).toBeTruthy();
    expect(screen.getByTestId('list-view')).toBeTruthy();
    expect(screen.queryByTestId('board-view')).toBeNull();
  });

  it('switching the toolbar flips list to board', () => {
    render(<ProjectPage selection={{ kind: 'project', path: FOUNDATIONS }} />);
    fireEvent.click(screen.getByText('Board'));
    expect(screen.getByTestId('board-view')).toBeTruthy();
    expect(screen.queryByTestId('list-view')).toBeNull();
  });

  it('a view selection uses the saved presentation', () => {
    render(<ProjectPage selection={{ kind: 'list', id: 'all-board' }} />);
    expect(screen.getByTestId('board-view')).toBeTruthy();
  });

  // Task 8: saved-view tabs on the project header.
  it('renders the Items tab plus project-scoped view tabs, not globals', () => {
    const scoped: ListFile = {
      ...boardView,
      id: 'delivery',
      project: FOUNDATIONS,
      definition: { ...boardView.definition, name: 'Delivery' },
    };
    useVaultStore.setState({ views: [boardView, scoped] });
    render(<ProjectPage selection={{ kind: 'project', path: FOUNDATIONS }} />);
    expect(screen.getByRole('tab', { name: 'Items' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Delivery' })).toBeTruthy();
    // The global 'All board' view is a sidebar concern, not a project tab.
    expect(screen.queryByRole('tab', { name: 'All board' })).toBeNull();
  });

  it('switching to a scoped view tab applies its presentation', () => {
    const scoped: ListFile = {
      ...boardView,
      id: 'delivery',
      project: FOUNDATIONS,
      definition: { ...boardView.definition, name: 'Delivery' },
    };
    useVaultStore.setState({ views: [scoped] });
    render(<ProjectPage selection={{ kind: 'project', path: FOUNDATIONS }} />);
    expect(screen.getByTestId('list-view')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Delivery' }));
    expect(screen.getByTestId('board-view')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Items' }));
    expect(screen.getByTestId('list-view')).toBeTruthy();
  });

  // Task 6+8: "New list" writes into the project's views/ dir (scope-deduped)
  // and activates the new tab.
  it('creates a project-scoped list from the New list affordance', async () => {
    // The create flow rescans from the mock fs, so the fixture project must
    // exist there too (listViews scopes by the presence of project.md).
    (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs.set(
      FOUNDATIONS,
      '---\ntype: Project\nkey: FLD\n---\n\n# Foundations\n',
    );
    render(<ProjectPage selection={{ kind: 'project', path: FOUNDATIONS }} />);
    fireEvent.click(screen.getByText('New list'));
    fireEvent.change(screen.getByPlaceholderText('List name'), { target: { value: 'My board' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => {
      const views = await ipc.listViews('/demo-vault');
      expect(views.some((v) => v.id === 'my-board' && v.project === FOUNDATIONS)).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'My board' }).getAttribute('aria-selected')).toBe(
        'true',
      );
    });
  });

  // Task 10: page tabs — Overview edits project.md, Pages hosts the file tree.
  it('the Overview tab replaces the item canvas with the project.md editor', async () => {
    const fs = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
    fs.set(FOUNDATIONS, '---\ntype: Project\nkey: FLD\n---\n\n# Foundations\n\nMission text.\n');
    render(<ProjectPage selection={{ kind: 'project', path: FOUNDATIONS }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(screen.queryByTestId('list-view')).toBeNull();
    expect(screen.queryByText('Board')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('markdown-editor')).toBeTruthy(), {
      timeout: 5_000,
    });
    await waitFor(() => expect(screen.getByText('Mission text.')).toBeTruthy(), {
      timeout: 5_000,
    });
  });

  it('the Pages tab shows the project file tree without project.md', () => {
    render(<ProjectPage selection={{ kind: 'project', path: FOUNDATIONS }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Pages' }));
    expect(screen.getByTestId('file-tree')).toBeTruthy();
    expect(screen.queryByTestId('list-view')).toBeNull();
    const files = screen.queryAllByTestId('tree-file').map((el) => el.textContent);
    expect(files).not.toContain('project');
  });

  // Task 8: toolbar edits on a saved-view tab auto-persist to the view file.
  it('auto-persists presentation edits on a scoped view tab', async () => {
    const fs = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
    fs.set(FOUNDATIONS, '---\ntype: Project\nkey: FLD\n---\n\n# Foundations\n');
    fs.set('projects/foundations/views/delivery.yml', 'name: Delivery\n');
    const scoped: ListFile = {
      ...boardView,
      id: 'delivery',
      project: FOUNDATIONS,
      definition: { ...boardView.definition, name: 'Delivery' },
    };
    useVaultStore.setState({ views: [scoped] });
    render(<ProjectPage selection={{ kind: 'project', path: FOUNDATIONS }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Delivery' }));
    // M9.1: the group control is a chain popover; removing its only level is
    // what "no grouping" now means.
    fireEvent.click(screen.getByTestId('group-chain'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove level 1' }));
    await waitFor(() => {
      // Written in v2 keys — an edited view converges on one shape.
      expect(fs.get('projects/foundations/views/delivery.yml')).toContain('group: []');
    });
  });
});
