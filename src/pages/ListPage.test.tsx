// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ListFile, Presentation, ViewDefinition } from '@/engine/types';
import { ListPage } from '@/pages/ListPage';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { fixtureVault } from '@/test/factories';

const presentation = (type: Presentation['type']): Presentation => ({
  type,
  group: [],
  sort: [{ field: 'modifiedAt', dir: 'desc' }],
  columns: [{ field: 'status' }, { field: 'priority' }],
});

const view = (id: string, name: string, type: Presentation['type']): ViewDefinition => ({
  id,
  name,
  icon: null,
  filters: null,
  presentation: presentation(type),
});

function mkList(views: ViewDefinition[]): ListFile {
  return {
    id: 'delivery',
    project: null,
    collection: 'work',
    path: 'work/delivery.list.yml',
    definition: {
      name: 'Delivery',
      icon: null,
      color: null,
      order: null,
      source: { type: 'Work item', project: null },
      views,
    },
  };
}

const TWO_VIEWS = [
  view('grid', 'All work', 'table'),
  {
    ...view('risk', 'At risk', 'board'),
    filters: { all: [{ field: 'status', op: 'equals' as const, value: 'todo' }] },
  },
];

function setup(views = TWO_VIEWS, active?: string) {
  useVaultStore.setState({
    vaultPath: '/demo-vault',
    entries: fixtureVault(),
    views: [mkList(views)],
    collections: [],
    status: 'ready',
    error: null,
  });
  const selection = {
    kind: 'list' as const,
    id: 'delivery',
    collection: 'work',
    ...(active === undefined ? {} : { view: active }),
  };
  useNavStore.setState({ selection, history: [selection], historyIndex: 0 });
  useUiStore.setState({ collapsed: {} });
  render(<ListPage selection={selection} />);
}

afterEach(cleanup);

describe('ListPage view tabs (M11)', () => {
  beforeEach(() => {
    useVaultStore.setState({ vaultPath: null, entries: [], views: [], collections: [] });
  });

  it('shows a tab per view and no layout pill row', () => {
    setup();
    expect(screen.getByTestId('view-tab-grid')).toBeTruthy();
    expect(screen.getByTestId('view-tab-risk')).toBeTruthy();
    // The pills are gone from a List's toolbar: layout belongs to a tab now,
    // and a control that changed it in place would overwrite the open tab.
    expect(screen.queryByTestId('view-switch-board')).toBeNull();
    expect(screen.queryByTestId('view-switch-table')).toBeNull();
  });

  it('opens the first tab when the selection names none', () => {
    setup();
    expect(screen.getByTestId('view-tab-grid').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('table-view')).toBeTruthy();
  });

  it('renders the layout of the tab the selection names', () => {
    setup(TWO_VIEWS, 'risk');
    expect(screen.getByTestId('view-tab-risk').getAttribute('aria-selected')).toBe('true');
    // The board tab draws a board — the table tab's layout is untouched.
    expect(screen.queryByTestId('table-view')).toBeNull();
  });

  it('switching tabs navigates rather than mutating the open view', () => {
    setup();
    fireEvent.click(screen.getByTestId('view-tab-risk'));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'list',
      id: 'delivery',
      collection: 'work',
      view: 'risk',
    });
  });

  it('falls back to the first tab when the selection names a view that is gone', () => {
    setup(TWO_VIEWS, 'deleted-in-another-window');
    expect(screen.getByTestId('view-tab-grid').getAttribute('aria-selected')).toBe('true');
  });

  it('applies the OPEN tab’s filters, not the list’s', async () => {
    // The fixture has one `todo` item and one `doing` item. `risk` filters to
    // todo, so the two tabs hold different records — which is the whole point
    // of filters living on the view rather than on the List.
    setup(TWO_VIEWS, 'grid');
    await waitFor(() => expect(screen.getByText('Design first-run flow')).toBeTruthy());
    expect(screen.getByText('Wire field sync banner')).toBeTruthy();

    cleanup();
    setup(TWO_VIEWS, 'risk');
    await waitFor(() => expect(screen.getByText('Design first-run flow')).toBeTruthy());
    expect(screen.queryByText('Wire field sync banner')).toBeNull();
  });

  it('a single-view list still renders one tab', () => {
    setup([view('only', 'Table', 'table')]);
    expect(screen.getByTestId('view-tab-only')).toBeTruthy();
    expect(screen.getByTestId('new-view')).toBeTruthy();
  });
});
