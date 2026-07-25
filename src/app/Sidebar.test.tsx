// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '@/engine/types';
import { useNavStore } from '@/stores/navStore';
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
            filters: null,
            presentation: {
              type: 'list',
              groupBy: 'status',
              orderBy: { field: 'modifiedAt', dir: 'desc' },
              visibleFields: ['key', 'status'],
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
  });

  afterEach(cleanup);

  it('renders top-level project rows and saved views (v2: no spaces)', () => {
    render(<Sidebar onNewProject={vi.fn()} />);
    expect(screen.getByText('Foundations')).toBeTruthy();
    expect(screen.getByText('Urgent work')).toBeTruthy();
  });

  it('clicking rows navigates to project and view', () => {
    render(<Sidebar onNewProject={vi.fn()} />);
    fireEvent.click(screen.getByText('Foundations'));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'project',
      path: 'projects/foundations/project.md',
    });
    fireEvent.click(screen.getByText('Urgent work'));
    expect(useNavStore.getState().selection).toEqual({ kind: 'view', id: 'urgent-work' });
  });

  it('the new project row calls onNewProject', () => {
    const onNewProject = vi.fn();
    render(<Sidebar onNewProject={onNewProject} />);
    fireEvent.click(screen.getByText('New project'));
    expect(onNewProject).toHaveBeenCalledTimes(1);
  });

  it('shows an empty hint when the vault has no projects', () => {
    useVaultStore.setState({ entries: [] });
    render(<Sidebar onNewProject={vi.fn()} />);
    expect(screen.getByText('No projects yet')).toBeTruthy();
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
    render(<Sidebar onNewProject={vi.fn()} />);
    expect(screen.getByText('Urgent work')).toBeTruthy();
    expect(screen.queryByText('Delivery')).toBeNull();
  });
});
