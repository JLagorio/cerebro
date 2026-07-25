// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entry, ViewFile } from '@/engine/types';
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

const boardView: ViewFile = {
  id: 'all-board',
  project: null,
  definition: {
    name: 'All board',
    icon: null,
    color: null,
    order: null,
    filters: null,
    presentation: {
      type: 'board',
      groupBy: 'status',
      orderBy: { field: 'modifiedAt', dir: 'desc' },
      visibleFields: ['key', 'status'],
    },
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
    render(<ProjectPage selection={{ kind: 'view', id: 'all-board' }} />);
    expect(screen.getByTestId('board-view')).toBeTruthy();
  });

  // Task 6: saving from a project page scopes the view to that project's
  // views/ dir; M1.x: ids dedupe within the scope instead of overwriting.
  it('saves project-scoped views and dedupes ids within the scope', async () => {
    // handleSaveView rescans from the mock fs, so the fixture project must
    // exist there too (listViews scopes by the presence of project.md).
    (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs.set(
      FOUNDATIONS,
      '---\ntype: Project\nkey: FLD\n---\n\n# Foundations\n',
    );
    render(<ProjectPage selection={{ kind: 'project', path: FOUNDATIONS }} />);
    const save = async (name: string) => {
      fireEvent.click(screen.getByText('Save view'));
      fireEvent.change(screen.getByPlaceholderText('View name'), { target: { value: name } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    };
    await save('All board');
    await waitFor(async () => {
      const views = await ipc.listViews('/demo-vault');
      expect(views.some((v) => v.id === 'all-board' && v.project === FOUNDATIONS)).toBe(true);
    });
    await save('All board'); // same name again → -2 within the project scope
    await waitFor(async () => {
      const views = await ipc.listViews('/demo-vault');
      expect(views.some((v) => v.id === 'all-board-2' && v.project === FOUNDATIONS)).toBe(true);
    });
  });
});
