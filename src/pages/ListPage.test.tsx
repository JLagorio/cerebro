// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListFile, Presentation, ViewDefinition } from '@/engine/types';
import { parseListYaml } from '@/engine/views';
import { resetMockFs } from '@/lib/mockIpc';
import { ListPage } from '@/pages/ListPage';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { fixtureVault } from '@/test/factories';

/**
 * jsdom cannot render mermaid, and this file is about WHERE a whiteboard tab's
 * canvas lands rather than what it draws. The stand-in keeps the shared
 * editor's contract and nothing else (the same substitution
 * `WhiteboardView.test.tsx` makes, for the same reason).
 */
vi.mock('@/mermaid/FullScreenDiagramEditor', () => ({
  FullScreenDiagramEditor: () => <div data-testid="fake-editor" />,
}));

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

/**
 * The number beside the list's name (M16.31).
 *
 * It read `surface.entries.length` — filtered but not searched. So typing in
 * "Search this view" narrowed the canvas to three cards, flipped the chip to
 * "· filtered", and left the count reading 45. A Filter rule DID move it. One
 * header, two different truths about the same screen, depending on which
 * control you narrowed with.
 */
describe('ListPage header count (M16.31)', () => {
  beforeEach(() => {
    useVaultStore.setState({ vaultPath: null, entries: [], views: [], collections: [] });
  });

  const search = (query: string) => {
    fireEvent.click(screen.getByLabelText('Search this view'));
    fireEvent.change(screen.getByTestId('view-search-input'), { target: { value: query } });
  };

  it('counts the records on screen, not the ones a search just removed', () => {
    setup(TWO_VIEWS, 'grid');
    // The fixture holds two Work items; "sync" matches one of them.
    expect(screen.getByTestId('view-count').textContent).toBe('2');
    search('sync');
    expect(screen.getByTestId('view-count').textContent).toBe('1');
  });

  it('goes back up when the search is cleared', () => {
    setup(TWO_VIEWS, 'grid');
    search('sync');
    search('');
    expect(screen.getByTestId('view-count').textContent).toBe('2');
  });

  /** A filter already moved the count, and the two controls must not disagree
   * — that disagreement is what made the search's silence look deliberate. */
  it('still counts what the view’s filters left', () => {
    setup(TWO_VIEWS, 'risk');
    expect(screen.getByTestId('view-count').textContent).toBe('1');
  });
});

/**
 * The tenth kind's host (M29.48).
 *
 * A whiteboard tab's canvas lives beside the LIST'S OWN FILE — the collection
 * folder for a List inside a Collection, the vault root for a root-level one
 * (spec D8). The page is the only thing that knows where its file is, which is
 * why the host is wired here rather than derived inside the view.
 *
 * Measured on the mock disk, not on a captured prop: the created path IS the
 * contract, and `folder` has no other observable.
 */
describe('ListPage hosts a whiteboard tab (M29.48)', () => {
  const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
  // Captured before anything overrides it — the stub below is per-test state,
  // not a permanent amputation of the store for whatever runs after.
  const realRescan = useVaultStore.getState().rescan;

  function setupBoard(
    path: string,
    collection: string | null,
    views: ViewDefinition[],
    open: string,
  ) {
    resetMockFs();
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entries: fixtureVault(),
      views: [{ ...mkList(views), collection, path }],
      collections: [],
      status: 'ready',
      error: null,
      // Create-on-open rescans so the file tree sees the new canvas (M29.46).
      // Against this fixture a REAL rescan reloads `views` from the demo
      // corpus and deletes the list mid-test — so the store's own action is
      // stubbed, and the assertions are made on the disk it wrote to.
      rescan: vi.fn(async () => {}),
    });
    const selection = { kind: 'list' as const, id: 'delivery', collection, view: open };
    useNavStore.setState({ selection, history: [selection], historyIndex: 0 });
    useUiStore.setState({ collapsed: {} });
    render(<ListPage selection={selection} />);
  }

  // Unmount FIRST: putting the real action back is a store notification, and a
  // still-mounted WhiteboardView subscribes to `rescan` — restoring it over a
  // live tree re-renders outside act(). Vitest runs afterEach hooks
  // last-registered-first, so this one precedes the file-level `cleanup`.
  afterEach(() => {
    cleanup();
    useVaultStore.setState({ rescan: realRescan });
  });

  // Settled first, asserted second: create-on-open ends by persisting the
  // pointer and opening the editor on it, and waiting for that lets every
  // state update land inside act() instead of after the test.
  const opened = () => screen.findByTestId('fake-editor');

  it('creates the canvas in the collection folder the List itself lives in', async () => {
    setupBoard(
      'work/delivery.list.yml',
      'work',
      [view('sketch', 'Sketch', 'whiteboard')],
      'sketch',
    );
    await opened();
    expect(fs().get('work/whiteboards/sketch.mmd')).toContain('flowchart TD');
  });

  it('a root-level List gets a top-level whiteboards/, with no leading slash', async () => {
    setupBoard('delivery.list.yml', null, [view('sketch', 'Sketch', 'whiteboard')], 'sketch');
    await opened();
    expect(fs().get('whiteboards/sketch.mmd')).toBeTruthy();
  });

  /**
   * The OPEN TAB names the file, not the List. Two whiteboard tabs on one list
   * are two canvases; naming them after the list would collide them into one
   * and both tabs would edit the same drawing.
   */
  it('names the canvas after the open tab', async () => {
    setupBoard(
      'work/delivery.list.yml',
      'work',
      [view('sketch', 'Sketch', 'whiteboard'), view('plan', 'Plan B', 'whiteboard')],
      'plan',
    );
    await opened();
    expect(fs().get('work/whiteboards/plan-b.mmd')).toBeTruthy();
    expect(fs().has('work/whiteboards/sketch.mmd')).toBe(false);
  });
});

/**
 * The chart drilldown's Save-as-view closure, end to end (M44.3): the page's
 * `onSaveView` appends through `addView` and opens the minted tab. Same
 * harness rules as the whiteboard describe above — the store's rescan is
 * stubbed (a real one reloads `views` from the demo corpus and deletes the
 * list mid-test), so the assertions read the disk the write landed on, plus
 * the navigation it caused.
 */
describe('ListPage saves a chart drilldown as a view (M44.3)', () => {
  const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
  const realRescan = useVaultStore.getState().rescan;

  afterEach(() => {
    cleanup();
    useVaultStore.setState({ rescan: realRescan });
  });

  it('Save as view writes the minted List view to the file and opens its tab', async () => {
    resetMockFs();
    const chartTab: ViewDefinition = {
      ...view('chart', 'Chart', 'chart'),
      filters: { all: [{ field: 'status', op: 'is_not_empty' as const, value: '' }] },
      presentation: { ...presentation('chart'), group: [{ field: 'status' }] },
    };
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entries: fixtureVault(),
      views: [mkList([view('grid', 'All work', 'table'), chartTab])],
      collections: [],
      status: 'ready',
      error: null,
      rescan: vi.fn(async () => {}),
    });
    const selection = { kind: 'list' as const, id: 'delivery', collection: 'work', view: 'chart' };
    useNavStore.setState({ selection, history: [selection], historyIndex: 0 });
    useUiStore.setState({ collapsed: {} });
    render(<ListPage selection={selection} />);

    fireEvent.click(
      screen.getAllByTestId('chart-bar').find((b) => b.getAttribute('data-label') === 'Todo')!,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save as view' }));

    // addView persisted through the mock ipc and openTab navigated.
    await waitFor(() => expect(fs().get('work/delivery.list.yml')).toContain('status-todo'));
    const written = parseListYaml('delivery', fs().get('work/delivery.list.yml')!);
    const minted = written.definition.views.find((v) => v.id === 'status-todo');
    expect(minted?.name).toBe('Status: Todo');
    expect(minted?.presentation.type).toBe('list');
    expect(minted?.filters).toEqual({
      all: [
        { field: 'status', op: 'is_not_empty', value: '' },
        { field: 'status', op: 'equals', value: 'todo' },
      ],
    });
    expect(useNavStore.getState().selection).toEqual({
      kind: 'list',
      id: 'delivery',
      collection: 'work',
      view: 'status-todo',
    });
  });
});
