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
  properties: { color: 'blue' },
});
const project = mkEntry({
  path: 'projects/foundations.md',
  filename: 'foundations.md',
  title: 'Foundations',
  type: 'Project',
  relationships: { space: ['product'] },
});

describe('Sidebar', () => {
  beforeEach(() => {
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entries: [space, project],
      views: [
        {
          id: 'urgent-work',
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

  it('renders spaces with nested project rows and saved views', () => {
    render(<Sidebar onNewProject={vi.fn()} />);
    expect(screen.getByText('Product')).toBeTruthy();
    expect(screen.getByText('Foundations')).toBeTruthy();
    expect(screen.getByText('Urgent work')).toBeTruthy();
  });

  it('collapsing a space hides its projects', () => {
    render(<Sidebar onNewProject={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Product' }));
    expect(screen.queryByText('Foundations')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Product' }));
    expect(screen.getByText('Foundations')).toBeTruthy();
  });

  it('clicking rows navigates to space, project, and view', () => {
    render(<Sidebar onNewProject={vi.fn()} />);
    fireEvent.click(screen.getByText('Foundations'));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'project',
      path: 'projects/foundations.md',
    });
    fireEvent.click(screen.getByText('Urgent work'));
    expect(useNavStore.getState().selection).toEqual({ kind: 'view', id: 'urgent-work' });
  });

  it('new project row calls onNewProject with the space path', () => {
    const onNewProject = vi.fn();
    render(<Sidebar onNewProject={onNewProject} />);
    fireEvent.click(screen.getByText('New project'));
    expect(onNewProject).toHaveBeenCalledWith('spaces/product.md');
  });
});
