import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DashboardView } from '@/views/DashboardView';
import { buildSchema } from '@/engine/schema';
import { parseListYaml } from '@/engine/views';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import type { DashboardSpec, DashboardWidget, Entry, ListFile, Presentation } from '@/engine/types';

/**
 * The dashboard (M16.28).
 *
 * What it must get right is the difference between its two block kinds. A
 * NUMBER measures the dashboard's own rows, so the view's filters reach it. A
 * VIEW block resolves a saved view out of the vault through `resolveSurface`,
 * the same function the List page calls — it stores a reference, so a deleted
 * List is one honest missing-block tile and never a stale copy of a query.
 *
 * And a block cannot embed another dashboard: without the guard, a dashboard
 * pointing at itself recurses until the stack runs out.
 */

const vault = (): Entry[] => [
  makeEntry({
    path: 'types/work-item.md',
    title: 'Work item',
    type: 'Type',
    properties: {
      fields: { status: { kind: 'status' }, estimate: { kind: 'number' } },
      statuses: [{ id: 'todo', group: 'active', color: 'blue' }],
    } as unknown as Entry['properties'],
  }),
  makeEntry({
    path: 'items/a.md',
    title: 'Alpha',
    type: 'Work item',
    properties: { status: 'todo', estimate: 3 },
  }),
  makeEntry({
    path: 'items/b.md',
    title: 'Beta',
    type: 'Work item',
    properties: { status: 'todo', estimate: 5 },
  }),
];

const records = (entries: Entry[]) => entries.filter((e) => e.path.startsWith('items/'));

const lists = (): ListFile[] => [
  parseListYaml(
    'delivery',
    'name: Delivery\nsource:\n  type: Work item\nviews:\n  - id: grid\n    name: Grid\n    presentation:\n      type: table\n      columns: [status]\n',
    { path: 'delivery.list.yml' },
  ),
  parseListYaml(
    'overview',
    'name: Overview\nsource:\n  type: Work item\nviews:\n  - id: board\n    name: Board\n    presentation:\n      type: dashboard\n',
    { path: 'overview.list.yml' },
  ),
  parseListYaml(
    'sketches',
    'name: Sketches\nsource:\n  type: Work item\nviews:\n  - id: sketch\n    name: Sketch\n    presentation:\n      type: whiteboard\n      whiteboard:\n        file: whiteboards/sketch.mmd\n',
    { path: 'sketches.list.yml' },
  ),
];

/**
 * Fixtures stay LEGACY-SHAPED on purpose (M44.4): they route the pre-M44.4
 * `blocks:` YAML through the real parser, so every test here also proves the
 * blocks→rows migration renders. Rows-native fixtures arrive with the row
 * renderer in Task 3.
 */
type LegacyBlock = Record<string, unknown>;
const view = (blocks: LegacyBlock[]): Presentation =>
  parseListYaml(
    'dash',
    `presentation:\n  type: dashboard\n${
      blocks.length > 0 ? `  dashboard:\n    blocks: ${JSON.stringify(blocks)}\n` : ''
    }`,
  ).definition.views[0].presentation;

afterEach(() => {
  cleanup();
  useVaultStore.setState({ entries: [], views: [] });
});

describe('DashboardView', () => {
  it('says what to do instead of rendering an empty grid', () => {
    const entries = vault();
    render(
      <DashboardView
        entries={records(entries)}
        presentation={view([])}
        schema={buildSchema(entries)}
      />,
    );
    expect(screen.getByText('No widgets yet')).toBeTruthy();
    // No writer, no Edit corner — the description must not promise one.
    expect(screen.getByText('Nothing here yet.')).toBeTruthy();
    expect(screen.getByTestId('dashboard-view').getAttribute('data-blocks')).toBe('0');
  });

  it('measures the dashboard’s OWN rows in a number block', () => {
    const entries = vault();
    render(
      <DashboardView
        entries={records(entries)}
        presentation={view([
          { id: 'b1', kind: 'number', agg: 'count' },
          { id: 'b2', kind: 'number', agg: 'sum', value: 'estimate', title: 'Points' },
        ])}
        schema={buildSchema(entries)}
      />,
    );
    const tiles = screen.getAllByTestId('dashboard-number');
    expect(tiles.map((t) => t.getAttribute('data-value'))).toEqual(['2', '8']);
    expect(screen.getByText('Points')).toBeTruthy();
  });

  it('embeds a saved view, resolved from the vault rather than copied', () => {
    const entries = vault();
    useVaultStore.setState({ entries, views: lists() });
    render(
      <DashboardView
        entries={records(entries)}
        presentation={view([{ id: 'b1', kind: 'view', list: 'delivery' }])}
        schema={buildSchema(entries)}
      />,
    );
    // The block shows the List's own layout and its own name — the block
    // stored neither, only a reference.
    expect(screen.getByTestId('table-view')).toBeTruthy();
    expect(screen.getByText('Delivery · Grid')).toBeTruthy();
    expect(screen.getByText('Alpha')).toBeTruthy();
  });

  it('names the list it can no longer find rather than rendering a blank tile', () => {
    const entries = vault();
    useVaultStore.setState({ entries, views: lists() });
    render(
      <DashboardView
        entries={records(entries)}
        presentation={view([{ id: 'b1', kind: 'view', list: 'deleted-one' }])}
        schema={buildSchema(entries)}
      />,
    );
    // Both the header and the message name it: the tile has to say WHICH
    // reference broke, or fixing it means guessing.
    expect(screen.getAllByText(/deleted-one/)).toHaveLength(2);
    expect(screen.getByText(/no longer in the vault/)).toBeTruthy();
  });

  // Without the guard this is unbounded recursion, not a rendering nit.
  it('refuses to draw a dashboard inside a dashboard', () => {
    const entries = vault();
    useVaultStore.setState({ entries, views: lists() });
    render(
      <DashboardView
        entries={records(entries)}
        presentation={view([{ id: 'b1', kind: 'view', list: 'overview' }])}
        schema={buildSchema(entries)}
      />,
    );
    expect(screen.getByText(/cannot show another dashboard/)).toBeTruthy();
    expect(screen.queryAllByTestId('dashboard-view')).toHaveLength(1);
  });

  /**
   * Stated, not forgotten (M29.48): only the two PAGE hosts pass a
   * `whiteboardHost`, so a block embedding a whiteboard tab draws the "lives
   * on their list" face. `hasBlocks` above guards dashboard-in-dashboard
   * recursion; this is the neighbouring question — a whiteboard is an EDITOR,
   * and a 300px read-only tile of one raises "whose autosave, whose keyboard?"
   * The face says where to go instead of pretending to be a canvas.
   *
   * The pointer in the fixture is deliberate: even with a file to open, the
   * block declines. Nothing is created either — the block passes no
   * `onPresentationChange`, so there is nowhere to persist a pointer to.
   */
  it('sends a whiteboard block back to the list that owns it', () => {
    const entries = vault();
    useVaultStore.setState({ entries, views: lists() });
    render(
      <DashboardView
        entries={records(entries)}
        presentation={view([{ id: 'b1', kind: 'view', list: 'sketches' }])}
        schema={buildSchema(entries)}
      />,
    );
    expect(screen.getByTestId('whiteboard-unavailable')).toBeTruthy();
    expect(screen.getByText('Whiteboards live on their list')).toBeTruthy();
  });

  // `wide` died with blocks[] (M44.4): migration gives a wide block its own
  // row, so the claim to keep is that every legacy block still renders.
  it('shows every block of a migrated legacy dashboard, wide included', () => {
    const entries = vault();
    render(
      <DashboardView
        entries={records(entries)}
        presentation={view([
          { id: 'b1', kind: 'number', agg: 'count', wide: true },
          { id: 'b2', kind: 'number', agg: 'count' },
        ])}
        schema={buildSchema(entries)}
      />,
    );
    expect(screen.getAllByTestId('dashboard-number')).toHaveLength(2);
    expect(screen.getByTestId('dashboard-view').getAttribute('data-blocks')).toBe('2');
  });
});

/**
 * Rows-native rendering (M44.4 Task 3): heights on the row, weights on the
 * widget, in row order. These build a `Presentation` directly rather than
 * through YAML — the parse/migration path is `engine/views.test.ts`'s job;
 * this file's job is what the rows DRAW.
 */
const rowsPresentation = (dashboard: NonNullable<Presentation['dashboard']>): Presentation => ({
  type: 'dashboard',
  group: [],
  sort: [],
  columns: [],
  dashboard,
});

describe('DashboardView rows (M44.4)', () => {
  const twoRows = (): Presentation =>
    rowsPresentation({
      rows: [
        {
          id: 'row-1',
          h: 360,
          widgets: [
            { id: 'a', kind: 'number', agg: 'count', w: 2 },
            { id: 'b', kind: 'number', agg: 'count' },
          ],
        },
        { id: 'row-2', widgets: [{ id: 'c', kind: 'number', agg: 'count' }] },
      ],
    });

  it('renders rows in order with widget width weights as flex-grow', () => {
    const entries = vault();
    render(
      <DashboardView
        entries={records(entries)}
        presentation={twoRows()}
        schema={buildSchema(entries)}
      />,
    );
    const rows = screen.getAllByTestId('dashboard-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByTestId('widget-a').style.flexGrow).toBe('2');
    expect(screen.getByTestId('widget-b').style.flexGrow).toBe('1');
  });

  it("a row's height lands on the row, and the default is 300", () => {
    const entries = vault();
    render(
      <DashboardView
        entries={records(entries)}
        presentation={twoRows()}
        schema={buildSchema(entries)}
      />,
    );
    const rows = screen.getAllByTestId('dashboard-row');
    expect(rows[0].style.height).toBe('360px');
    expect(rows[1].style.height).toBe('300px');
  });

  // AGENTS.md: wide content scrolls inside its own container. One over-wide
  // row must scroll alone — the whole dashboard dragging sideways would take
  // every other row with it.
  it('each row scrolls inside its own wrapper, and the height stays on the row', () => {
    const entries = vault();
    render(
      <DashboardView
        entries={records(entries)}
        presentation={twoRows()}
        schema={buildSchema(entries)}
      />,
    );
    const rows = screen.getAllByTestId('dashboard-row');
    for (const row of rows) {
      expect(row.parentElement?.className).toContain('overflow-x-auto');
    }
    expect(rows[0].style.height).toBe('360px');
  });

  // The number widget must measure through `widgetEntries` — the dashboard's
  // Global filter, not just the view's own — or a Global filter would be
  // decoration rather than a real second layer (M44.4 Task 2's contract).
  it('measures a number widget through widgetEntries — a global filter narrows the count', () => {
    const entries: Entry[] = [
      makeEntry({
        path: 'items/a.md',
        title: 'Alpha',
        type: 'Work item',
        properties: { priority: 'high' },
      }),
      makeEntry({
        path: 'items/b.md',
        title: 'Beta',
        type: 'Work item',
        properties: { priority: 'low' },
      }),
    ];
    const presentation = rowsPresentation({
      rows: [{ id: 'row-1', widgets: [{ id: 'a', kind: 'number', agg: 'count' }] }],
      global: { all: [{ field: 'priority', op: 'not_equals', value: 'low' }] },
    });
    render(
      <DashboardView entries={entries} presentation={presentation} schema={buildSchema(entries)} />,
    );
    // Two records total, one filtered out by the global rule.
    expect(screen.getByTestId('dashboard-number').getAttribute('data-value')).toBe('1');
  });
});

/**
 * The four own-scope widget kinds (M44.4 Task 4): table, board, timeline,
 * chart. Each renders the EXISTING view component directly over
 * `widgetEntries(entries, spec, widget, schema)` — the dashboard's own rows
 * through the Global filter through the widget's own — with a locally
 * composed presentation. `resolveSurface` stays the view-embed's path.
 */
const ownVault = (): Entry[] => [
  makeEntry({
    path: 'types/work-item.md',
    title: 'Work item',
    type: 'Type',
    properties: {
      fields: { status: { kind: 'status' }, estimate: { kind: 'number' }, due: { kind: 'date' } },
      statuses: [
        { id: 'todo', group: 'active', color: 'blue' },
        { id: 'doing', group: 'active', color: 'green' },
      ],
    } as unknown as Entry['properties'],
  }),
  makeEntry({
    path: 'items/a.md',
    title: 'Alpha',
    type: 'Work item',
    properties: { status: 'todo', estimate: 3, due: '2026-08-20' },
  }),
  makeEntry({
    path: 'items/b.md',
    title: 'Beta',
    type: 'Work item',
    properties: { status: 'doing', estimate: 5, due: '2026-08-22' },
  }),
];

const oneWidget = (widget: DashboardWidget): Presentation =>
  rowsPresentation({ rows: [{ id: 'row-1', widgets: [widget] }] });

describe('DashboardView own-scope widgets (M44.4)', () => {
  it("a table widget lists the dashboard's own rows through its filter", () => {
    const entries = ownVault();
    render(
      <DashboardView
        entries={records(entries)}
        presentation={oneWidget({
          id: 't',
          kind: 'table',
          filter: { all: [{ field: 'status', op: 'equals', value: 'doing' }] },
        })}
        schema={buildSchema(entries)}
      />,
    );
    const widget = screen.getByTestId('widget-t');
    expect(widget.querySelector('[data-testid="table-view"]')).toBeTruthy();
    // The filter narrows to Beta; Alpha is in the view's rows but not the widget's.
    expect(within(widget).getByText('Beta')).toBeTruthy();
    expect(within(widget).queryByText('Alpha')).toBeNull();
  });

  it('a board widget bands by its group field', () => {
    const entries = ownVault();
    render(
      <DashboardView
        entries={records(entries)}
        presentation={oneWidget({ id: 'bd', kind: 'board', group: 'status' })}
        schema={buildSchema(entries)}
      />,
    );
    const widget = screen.getByTestId('widget-bd');
    expect(widget.querySelector('[data-testid="board-view"]')).toBeTruthy();
    expect(within(widget).getAllByTestId('board-column')).toHaveLength(2);
    expect(within(widget).getByText('Alpha')).toBeTruthy();
    expect(within(widget).getByText('Beta')).toBeTruthy();
  });

  it('a board widget with no group bands by the first status-kind field', () => {
    const entries = ownVault();
    render(
      <DashboardView
        entries={records(entries)}
        presentation={oneWidget({ id: 'bd', kind: 'board' })}
        schema={buildSchema(entries)}
      />,
    );
    expect(
      screen.getByTestId('widget-bd').querySelector('[data-testid="board-view"]'),
    ).toBeTruthy();
  });

  it('a board widget with no resolvable band asks for configuration, not "no data"', () => {
    // No status-kind field anywhere: the vault() fixture's Type is absent and
    // the records carry only plain text properties.
    const entries: Entry[] = [
      makeEntry({ path: 'items/a.md', title: 'Alpha', type: null, properties: { note: 'x' } }),
    ];
    render(
      <DashboardView
        entries={entries}
        presentation={oneWidget({ id: 'bd', kind: 'board' })}
        schema={buildSchema(entries)}
      />,
    );
    const widget = screen.getByTestId('widget-bd');
    expect(widget.querySelector('[data-testid="board-view"]')).toBeNull();
    expect(
      within(widget).getByText('Toggle Edit and pick Band by… in the widget menu.'),
    ).toBeTruthy();
  });

  it('a timeline widget renders read-only', () => {
    const entries = ownVault();
    render(
      <DashboardView
        entries={records(entries)}
        presentation={oneWidget({ id: 'tl', kind: 'timeline' })}
        schema={buildSchema(entries)}
      />,
    );
    const widget = screen.getByTestId('widget-tl');
    const timeline = widget.querySelector('[data-testid="timeline-view"]');
    expect(timeline).toBeTruthy();
    // The scoped rows carry a date-kind field, so the timeline places bars —
    // it did not fall into its "nothing here carries a date" state.
    expect(timeline?.getAttribute('data-date-field')).toBe('due');
  });

  it('a chart widget draws with its own spec, horizontal included', () => {
    const entries = ownVault();
    render(
      <DashboardView
        entries={records(entries)}
        presentation={oneWidget({
          id: 'ch',
          kind: 'chart',
          group: 'status',
          chart: { horizontal: true },
        })}
        schema={buildSchema(entries)}
      />,
    );
    const widget = screen.getByTestId('widget-ch');
    const chart = widget.querySelector('[data-testid="chart-view"]');
    expect(chart).toBeTruthy();
    expect(chart?.getAttribute('data-chart-kind')).toBe('bar');
    expect(widget.querySelector('[data-testid="chart-empty"]')).toBeNull();
  });

  it("a chart widget with no group shows the chart's own no-group refusal", () => {
    const entries = ownVault();
    render(
      <DashboardView
        entries={records(entries)}
        presentation={oneWidget({ id: 'ch', kind: 'chart' })}
        schema={buildSchema(entries)}
      />,
    );
    const empty = screen.getByTestId('widget-ch').querySelector('[data-testid="chart-empty"]');
    expect(empty).toBeTruthy();
    expect(empty?.getAttribute('data-reason')).toBe('no-group');
  });

  it("every widget's title computes per kind, and an override wins", () => {
    const entries = ownVault();
    render(
      <DashboardView
        entries={records(entries)}
        presentation={rowsPresentation({
          rows: [
            {
              id: 'row-1',
              widgets: [
                { id: 't', kind: 'table' },
                { id: 'tl', kind: 'timeline' },
                {
                  id: 'ch',
                  kind: 'chart',
                  group: 'status',
                  chart: { agg: 'sum', value: 'estimate' },
                },
                { id: 'bd', kind: 'board', group: 'status', title: 'My board' },
              ],
            },
          ],
        })}
        schema={buildSchema(entries)}
      />,
    );
    expect(within(screen.getByTestId('widget-t')).getByText('Table')).toBeTruthy();
    expect(within(screen.getByTestId('widget-tl')).getByText('Timeline')).toBeTruthy();
    // The chart's computed title is its measure, the same words ChartView
    // uses — which is why this reads the HEADER, not the whole tile: the
    // chart's own axis repeats them.
    const chartHeader = screen.getByTestId('widget-ch').querySelector('header');
    expect(chartHeader?.textContent).toContain('Sum of Estimate');
    expect(within(screen.getByTestId('widget-bd')).getByText('My board')).toBeTruthy();
    expect(within(screen.getByTestId('widget-bd')).queryByText('Board')).toBeNull();
  });
});

/**
 * Edit mode (M44.4 Task 5). Every structural change flows through the pure
 * editors in engine/dashboard.ts and lands in `onPresentationChange`; a
 * refusal comes back as the editor's own rule sentence, toasted — never a
 * silent no-op and never a second wording of the cap.
 */
const editVault = (): Entry[] => [
  makeEntry({
    path: 'types/work-item.md',
    title: 'Work item',
    type: 'Type',
    properties: {
      fields: {
        status: { kind: 'status' },
        priority: { kind: 'select' },
        estimate: { kind: 'number' },
      },
      statuses: [{ id: 'todo', group: 'active', color: 'blue' }],
    } as unknown as Entry['properties'],
  }),
  makeEntry({
    path: 'items/a.md',
    title: 'Alpha',
    type: 'Work item',
    properties: { status: 'todo', priority: 'high', estimate: 3 },
  }),
];

const countWidget = (id: string): DashboardWidget => ({ id, kind: 'number', agg: 'count' });

const oneRow = (widgets: DashboardWidget[]): Presentation =>
  rowsPresentation({ rows: [{ id: 'r1', widgets }] });

describe('DashboardView edit mode (M44.4)', () => {
  const realToast = useUiStore.getState().toast;
  afterEach(() => {
    // Unmount BEFORE restoring the store: afterEach hooks run LIFO, so this
    // one fires ahead of the file-level cleanup — and a setState against a
    // still-mounted tree is an update React rightly flags as un-acted.
    cleanup();
    useUiStore.setState({ toast: realToast, toasts: [] });
  });

  /** Renders with a persisting host and toggles Edit on. */
  const editSetup = (presentation: Presentation, entries: Entry[] = editVault()) => {
    const onChange = vi.fn();
    render(
      <DashboardView
        entries={records(entries)}
        presentation={presentation}
        schema={buildSchema(entries)}
        onPresentationChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('dashboard-edit-toggle'));
    return onChange;
  };

  const lastDashboard = (onChange: ReturnType<typeof vi.fn>): DashboardSpec => {
    const next = onChange.mock.calls.at(-1)?.[0] as Presentation;
    if (next.dashboard === undefined) throw new Error('expected a dashboard on the presentation');
    return next.dashboard;
  };

  const ids = (spec: DashboardSpec) => spec.rows.map((r) => r.widgets.map((w) => w.id));

  it('shows the edit affordances only when the host can persist', () => {
    const entries = editVault();
    render(
      <DashboardView
        entries={records(entries)}
        presentation={oneRow([countWidget('a')])}
        schema={buildSchema(entries)}
      />,
    );
    expect(screen.queryByTestId('dashboard-edit-toggle')).toBeNull();
    expect(screen.queryByTestId('dashboard-global-filter')).toBeNull();
    expect(screen.queryByTestId('add-widget')).toBeNull();
    expect(screen.queryByTestId('widget-menu')).toBeNull();

    cleanup();
    // With a writer but Edit off: the toggle and the global chip stand, the
    // structural affordances wait for the lens.
    render(
      <DashboardView
        entries={records(entries)}
        presentation={oneRow([countWidget('a')])}
        schema={buildSchema(entries)}
        onPresentationChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('dashboard-edit-toggle')).toBeTruthy();
    expect(screen.getByTestId('dashboard-global-filter')).toBeTruthy();
    expect(screen.queryByTestId('add-widget')).toBeNull();
    expect(screen.queryByTestId('widget-menu')).toBeNull();
  });

  it('adding a metric preset appends a configured number widget to the last row with room', () => {
    const onChange = editSetup(oneRow([countWidget('a')]));
    fireEvent.click(screen.getByTestId('add-widget'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Count of records' }));
    const next = lastDashboard(onChange);
    expect(next.rows).toHaveLength(1);
    const added = next.rows[0].widgets.at(-1);
    expect(added).toMatchObject({ kind: 'number', agg: 'count' });
    expect(added?.id).not.toBe('a');
  });

  it("Sum of… drills into the dashboard's own numeric fields", () => {
    const onChange = editSetup(oneRow([countWidget('a')]));
    fireEvent.click(screen.getByTestId('add-widget'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sum of…' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Estimate' }));
    expect(lastDashboard(onChange).rows[0].widgets.at(-1)).toMatchObject({
      kind: 'number',
      agg: 'sum',
      value: 'estimate',
    });
  });

  it('Saved view… drills into the vault’s Lists and mints a view widget', () => {
    const entries = editVault();
    useVaultStore.setState({ entries, views: lists() });
    const onChange = editSetup(oneRow([countWidget('a')]), entries);
    fireEvent.click(screen.getByTestId('add-widget'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Saved view…' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delivery' }));
    expect(lastDashboard(onChange).rows[0].widgets.at(-1)).toMatchObject({
      kind: 'view',
      list: 'delivery',
    });
  });

  it('the add popover names the cap when the dashboard is full', () => {
    const full = rowsPresentation({
      rows: [1, 2, 3].map((n) => ({
        id: `r${n}`,
        widgets: [1, 2, 3, 4].map((m) => countWidget(`w${n}-${m}`)),
      })),
    });
    editSetup(full);
    fireEvent.click(screen.getByTestId('add-widget'));
    // The exact sentence the pure editor refuses with — one rule, one wording.
    expect(screen.getByText('A dashboard holds at most twelve widgets')).toBeTruthy();
    const count = screen.getByRole('menuitem', { name: 'Count of records' });
    expect((count as HTMLButtonElement).disabled).toBe(true);
    const bar = screen.getByRole('menuitem', { name: 'Bar chart' });
    expect((bar as HTMLButtonElement).disabled).toBe(true);
  });

  it('the widget menu moves, duplicates and deletes through the pure editors', () => {
    const onChange = editSetup(oneRow([countWidget('a'), countWidget('b')]));
    const menuOnA = () =>
      fireEvent.click(within(screen.getByTestId('widget-a')).getByTestId('widget-menu'));

    menuOnA();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to own row' }));
    expect(ids(lastDashboard(onChange))).toEqual([['b'], ['a']]);

    // The prop never updates under a mock, so each edit starts from the same
    // two-widget row — which is exactly what makes the shapes assertable.
    menuOnA();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(ids(lastDashboard(onChange))).toEqual([['a', 'widget-3', 'b']]);

    menuOnA();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(ids(lastDashboard(onChange))).toEqual([['b']]);
  });

  it('a cap refusal toasts the exact rule sentence and commits nothing', () => {
    const toast = vi.fn();
    useUiStore.setState({ toast });
    const full = rowsPresentation({
      rows: [
        { id: 'r1', widgets: ['a', 'b', 'c', 'd'].map(countWidget) },
        { id: 'r2', widgets: [countWidget('e')] },
      ],
    });
    const onChange = editSetup(full);
    fireEvent.click(within(screen.getByTestId('widget-a')).getByTestId('widget-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(toast).toHaveBeenCalledWith('A row holds at most four widgets');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Rename… swaps the header title for an input and writes through updateWidget', () => {
    const onChange = editSetup(oneRow([countWidget('a')]));
    fireEvent.click(within(screen.getByTestId('widget-a')).getByTestId('widget-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    const input = screen.getByLabelText('Widget title');
    fireEvent.change(input, { target: { value: 'Sprint pulse' } });
    fireEvent.blur(input);
    expect(lastDashboard(onChange).rows[0].widgets[0]).toMatchObject({ title: 'Sprint pulse' });
  });

  it("the board's Band by… lists groupable fields and writes widget.group", () => {
    const onChange = editSetup(oneRow([{ id: 'bd', kind: 'board' }]));
    fireEvent.click(within(screen.getByTestId('widget-bd')).getByTestId('widget-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Band by…' }));
    // The groupable roster (GROUPABLE_KINDS): status and select — never the
    // number field.
    expect(screen.queryByRole('menuitem', { name: 'Estimate' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Priority' }));
    expect(lastDashboard(onChange).rows[0].widgets[0]).toMatchObject({
      kind: 'board',
      group: 'priority',
    });
  });

  it("a widget's Filter… writes widget.filter through updateWidget", () => {
    const onChange = editSetup(oneRow([{ id: 't', kind: 'table' }]));
    fireEvent.click(within(screen.getByTestId('widget-t')).getByTestId('widget-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Filter…' }));
    fireEvent.click(screen.getByText('Add filter'));
    const widget = lastDashboard(onChange).rows[0].widgets[0];
    expect(widget.filter).toBeDefined();
    expect(widget.filter !== undefined && 'all' in widget.filter && widget.filter.all).toHaveLength(
      1,
    );
  });

  it('Band by… offers a way back — Default clears the override', () => {
    const onChange = editSetup(oneRow([{ id: 'bd', kind: 'board', group: 'priority' }]));
    fireEvent.click(within(screen.getByTestId('widget-bd')).getByTestId('widget-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Band by…' }));
    // The item names the band the board returns to.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Default (Status)' }));
    const widget = lastDashboard(onChange).rows[0].widgets[0];
    expect('group' in widget).toBe(false);
  });

  it('renaming a custom-titled widget shows the default as placeholder, and empty clears', () => {
    const onChange = editSetup(
      oneRow([{ id: 'a', kind: 'number', agg: 'count', title: 'Custom' }]),
    );
    fireEvent.click(within(screen.getByTestId('widget-a')).getByTestId('widget-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    const input = screen.getByLabelText('Widget title') as HTMLInputElement;
    expect(input.value).toBe('Custom');
    expect(input.placeholder).toBe('Records');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    // The override is GONE — the header returns to the computed default —
    // rather than the empty commit being swallowed as a cancel.
    expect('title' in lastDashboard(onChange).rows[0].widgets[0]).toBe(false);
  });

  it('a global filter rule lands in spec.global, and an emptied group deletes the key', () => {
    const onChange = editSetup(oneRow([countWidget('a')]));
    fireEvent.click(screen.getByTestId('dashboard-global-filter'));
    fireEvent.click(screen.getByText('Add filter'));
    const withRule = lastDashboard(onChange);
    expect(
      withRule.global !== undefined && 'all' in withRule.global && withRule.global.all,
    ).toHaveLength(1);

    cleanup();
    const seeded = rowsPresentation({
      rows: [{ id: 'r1', widgets: [countWidget('a')] }],
      global: { all: [{ field: 'status', op: 'equals', value: 'todo' }] },
    });
    const onChange2 = editSetup(seeded);
    fireEvent.click(screen.getByTestId('dashboard-global-filter'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter' }));
    const next = lastDashboard(onChange2);
    expect('global' in next).toBe(false);
    expect(next.rows).toHaveLength(1);
  });

  /**
   * View embeds pass the same two layers (review round): the Global filter
   * and the widget's own apply over the saved view's rows, so the Global
   * popover's "every widget's rows pass it" is literally true — and a
   * widget filter on an embed is read, never unread YAML.
   */
  const embedVault = (): Entry[] => [
    makeEntry({
      path: 'types/work-item.md',
      title: 'Work item',
      type: 'Type',
      properties: {
        fields: { status: { kind: 'status' }, estimate: { kind: 'number' } },
        statuses: [
          { id: 'todo', group: 'active', color: 'blue' },
          { id: 'doing', group: 'active', color: 'green' },
        ],
      } as unknown as Entry['properties'],
    }),
    makeEntry({
      path: 'items/a.md',
      title: 'Alpha',
      type: 'Work item',
      properties: { status: 'todo', estimate: 3 },
    }),
    makeEntry({
      path: 'items/b.md',
      title: 'Beta',
      type: 'Work item',
      properties: { status: 'doing', estimate: 5 },
    }),
  ];

  it("a view widget's own filter narrows the embedded rows", () => {
    const entries = embedVault();
    useVaultStore.setState({ entries, views: lists() });
    render(
      <DashboardView
        entries={records(entries)}
        presentation={oneRow([
          {
            id: 'v',
            kind: 'view',
            list: 'delivery',
            filter: { all: [{ field: 'status', op: 'equals', value: 'doing' }] },
          },
        ])}
        schema={buildSchema(entries)}
      />,
    );
    const widget = screen.getByTestId('widget-v');
    expect(within(widget).getByText('Beta')).toBeTruthy();
    expect(within(widget).queryByText('Alpha')).toBeNull();
  });

  it('the Global filter narrows a view embed too', () => {
    const entries = embedVault();
    useVaultStore.setState({ entries, views: lists() });
    render(
      <DashboardView
        entries={records(entries)}
        presentation={rowsPresentation({
          rows: [{ id: 'r1', widgets: [{ id: 'v', kind: 'view', list: 'delivery' }] }],
          global: { all: [{ field: 'status', op: 'equals', value: 'todo' }] },
        })}
        schema={buildSchema(entries)}
      />,
    );
    const widget = screen.getByTestId('widget-v');
    expect(within(widget).getByText('Alpha')).toBeTruthy();
    expect(within(widget).queryByText('Beta')).toBeNull();
  });

  it("a view widget's Filter… roster comes from the embed, not the dashboard's own rows", () => {
    const entries = embedVault();
    useVaultStore.setState({ entries, views: lists() });
    // The dashboard's own rows carry a DIFFERENT universe on purpose — if
    // the roster leaked from them, the seeded rule would name `zzz`.
    const own = [
      makeEntry({ path: 'items/z.md', title: 'Zed', type: null, properties: { zzz: 'x' } }),
    ];
    const onChange = vi.fn();
    render(
      <DashboardView
        entries={own}
        presentation={oneRow([{ id: 'v', kind: 'view', list: 'delivery' }])}
        schema={buildSchema(own)}
        onPresentationChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('dashboard-edit-toggle'));
    fireEvent.click(within(screen.getByTestId('widget-v')).getByTestId('widget-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Filter…' }));
    fireEvent.click(screen.getByText('Add filter'));
    const widget = lastDashboard(onChange).rows[0].widgets[0];
    // Seeded from the embed's List: its first declared field, not `zzz`.
    expect(widget.filter).toMatchObject({ all: [{ field: 'status' }] });
  });
});
