// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entry, ViewFile } from '@/engine/types';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { ProjectPage } from './ProjectPage';

function mkEntry(partial: Partial<Entry> & { path: string }): Entry {
  return {
    filename: partial.path.split('/').pop() ?? '',
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

const space = mkEntry({
  path: 'spaces/product.md',
  filename: 'product.md',
  title: 'Product',
  type: 'Space',
  properties: { color: '#3D8BE8' },
});
const project = mkEntry({
  path: 'projects/foundations.md',
  filename: 'foundations.md',
  title: 'Foundations',
  type: 'Project',
  properties: { key: 'FLD' },
  relationships: { space: ['product'] },
});
const item = mkEntry({
  path: 'items/fld-1.md',
  filename: 'fld-1.md',
  title: 'Ship tokens',
  properties: { status: 'todo', key: 'FLD-1' },
  relationships: { project: ['foundations'] },
});

const boardView: ViewFile = {
  id: 'all-board',
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
      entries: [space, project, item],
      views: [boardView],
      status: 'ready',
      error: null,
    });
    useNavStore.setState({
      selection: { kind: 'project', path: 'projects/foundations.md' },
      history: [{ kind: 'home' }],
      historyIndex: 0,
    });
  });

  afterEach(cleanup);

  it('renders breadcrumb and defaults to the list view', () => {
    render(<ProjectPage selection={{ kind: 'project', path: 'projects/foundations.md' }} />);
    expect(screen.getByText('Product')).toBeTruthy();
    expect(screen.getByText('Foundations')).toBeTruthy();
    expect(screen.getByTestId('list-view')).toBeTruthy();
    expect(screen.queryByTestId('board-view')).toBeNull();
  });

  it('switching the toolbar flips list to board', () => {
    render(<ProjectPage selection={{ kind: 'project', path: 'projects/foundations.md' }} />);
    fireEvent.click(screen.getByText('Board'));
    expect(screen.getByTestId('board-view')).toBeTruthy();
    expect(screen.queryByTestId('list-view')).toBeNull();
  });

  it('a view selection uses the saved presentation', () => {
    render(<ProjectPage selection={{ kind: 'view', id: 'all-board' }} />);
    expect(screen.getByTestId('board-view')).toBeTruthy();
  });
});
