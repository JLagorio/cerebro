import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ownsEscape, pushLayer, resetLayers } from '@/components/ui/layers';
import { DashboardView, handleWidgetDragEnd } from '@/views/DashboardView';
import type { DragEndEvent } from '@dnd-kit/core';
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

  it('a board widget with no resolvable band asks for configuration, not "no data" — on a host that can edit', () => {
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
        onPresentationChange={vi.fn()}
      />,
    );
    const widget = screen.getByTestId('widget-bd');
    expect(widget.querySelector('[data-testid="board-view"]')).toBeNull();
    expect(
      within(widget).getByText('Toggle Edit and pick Band by… in the widget menu.'),
    ).toBeTruthy();
  });

  // Same no-band gap, a read-only host: no `onPresentationChange` means no
  // Edit corner exists at all, so the note cannot send the reader to one.
  it('a board widget with no resolvable band on a read-only host names the gap, not a toggle', () => {
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
    expect(within(widget).getByText('No status property to band by.')).toBeTruthy();
    expect(within(widget).queryByText(/Toggle Edit/)).toBeNull();
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

  // moveWithinRow clamps at the row's own ends rather than wrapping — Move
  // left on the leftmost widget returns the SAME spec reference it was
  // handed (engine/dashboard.test.ts's own "clamped" case). Without an
  // identity check, `commit` wrote that no-op straight to disk anyway.
  it('Move left on the leftmost widget is a no-op — nothing commits', () => {
    const onChange = editSetup(oneRow([countWidget('a'), countWidget('b')]));
    fireEvent.click(within(screen.getByTestId('widget-a')).getByTestId('widget-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move left' }));
    expect(onChange).not.toHaveBeenCalled();
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

  // A minted chart widget has no `group` — engine/dashboard.ts's
  // WidgetPatch docstring says the menu only offers the key on the kinds
  // that read it, and ChartWidget reads `widget.group` for its X axis the
  // same way BoardWidget reads it for its band. Without this item a
  // group-less chart was a permanent dead end: no control on the tile could
  // ever set the one property its own no-group refusal demands.
  it("a chart widget's menu offers X axis…, not Band by…, and writes widget.group", () => {
    const onChange = editSetup(oneRow([{ id: 'ch', kind: 'chart' }]));
    fireEvent.click(within(screen.getByTestId('widget-ch')).getByTestId('widget-menu'));
    expect(screen.queryByRole('menuitem', { name: 'Band by…' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'X axis…' }));
    // The same groupable roster as a board's Band by… — status and select.
    expect(screen.queryByRole('menuitem', { name: 'Estimate' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Priority' }));
    expect(lastDashboard(onChange).rows[0].widgets[0]).toMatchObject({
      kind: 'chart',
      group: 'priority',
    });
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

/**
 * Cross-row drag-and-drop (M44.4 Task 6). The handler is pure and tested by
 * synthesizing DragEndEvents directly — the BoardView `handleDragEnd` pattern;
 * no DOM drag. Slot ids are `slot:<rowId>:<index>` plus one `slot:new-row`
 * after the last row, globally unique because dnd-kit's droppable registry is
 * a Map and a duplicate id silently kills a target.
 */
describe('handleWidgetDragEnd (M44.4)', () => {
  const drag = (activeId: string, overId: string | null): DragEndEvent =>
    ({
      active: { id: activeId },
      over: overId === null ? null : { id: overId },
    }) as unknown as DragEndEvent;

  const twoRowSpec = (): DashboardSpec => ({
    rows: [
      { id: 'r1', widgets: [countWidget('a'), countWidget('b')] },
      { id: 'r2', widgets: [countWidget('c')] },
    ],
  });

  const ids = (spec: DashboardSpec) => spec.rows.map((r) => r.widgets.map((w) => w.id));

  it('drops into a slot across rows and commits the moved shape', () => {
    const commit = vi.fn();
    const toast = vi.fn();
    handleWidgetDragEnd(drag('c', 'slot:r1:1'), { spec: twoRowSpec(), commit, toast });
    expect(toast).not.toHaveBeenCalled();
    // c lands between a and b; the row it emptied does not survive.
    expect(ids(commit.mock.calls[0][0] as DashboardSpec)).toEqual([['a', 'c', 'b']]);
  });

  it('a full row toasts the exact rule sentence and commits nothing', () => {
    const commit = vi.fn();
    const toast = vi.fn();
    const full: DashboardSpec = {
      rows: [
        { id: 'full', widgets: ['a', 'b', 'c', 'd'].map(countWidget) },
        { id: 'r2', widgets: [countWidget('e')] },
      ],
    };
    handleWidgetDragEnd(drag('e', 'slot:full:0'), { spec: full, commit, toast });
    expect(commit).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('A row holds at most four widgets');
  });

  it('the end-of-dashboard slot puts the widget alone in a trailing row', () => {
    const commit = vi.fn();
    const toast = vi.fn();
    handleWidgetDragEnd(drag('a', 'slot:new-row'), { spec: twoRowSpec(), commit, toast });
    expect(ids(commit.mock.calls[0][0] as DashboardSpec)).toEqual([['b'], ['c'], ['a']]);
  });

  it('no drop target, or one that is not a slot, is a no-op', () => {
    const commit = vi.fn();
    const toast = vi.fn();
    handleWidgetDragEnd(drag('a', null), { spec: twoRowSpec(), commit, toast });
    // A widget under the pointer is not a target — only slots are.
    handleWidgetDragEnd(drag('a', 'b'), { spec: twoRowSpec(), commit, toast });
    expect(commit).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('an identity drop — either slot flanking the widget — commits nothing', () => {
    const commit = vi.fn();
    const toast = vi.fn();
    handleWidgetDragEnd(drag('a', 'slot:r1:0'), { spec: twoRowSpec(), commit, toast });
    handleWidgetDragEnd(drag('a', 'slot:r1:1'), { spec: twoRowSpec(), commit, toast });
    // The last lone widget dragged to the trailing strip lands where it
    // already was — same widget matrix, even though moveToEnd mints a fresh
    // row id for it.
    handleWidgetDragEnd(drag('c', 'slot:new-row'), { spec: twoRowSpec(), commit, toast });
    expect(commit).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('a same-row forward drop lands where the gap was, not one past it', () => {
    const commit = vi.fn();
    const toast = vi.fn();
    const spec: DashboardSpec = { rows: [{ id: 'r1', widgets: ['a', 'b', 'c'].map(countWidget) }] };
    // Slot 2 is the gap between b and c ON SCREEN (the dragged widget still
    // counts); remove-then-insert would land one past it unadjusted.
    handleWidgetDragEnd(drag('a', 'slot:r1:2'), { spec, commit, toast });
    expect(ids(commit.mock.calls[0][0] as DashboardSpec)).toEqual([['b', 'a', 'c']]);
  });

  it('an out-of-range slot index clamps to the row end', () => {
    const commit = vi.fn();
    const toast = vi.fn();
    handleWidgetDragEnd(drag('c', 'slot:r1:99'), { spec: twoRowSpec(), commit, toast });
    expect(ids(commit.mock.calls[0][0] as DashboardSpec)).toEqual([['a', 'b', 'c']]);
  });
});

describe('DashboardView drag chrome (M44.4)', () => {
  it('grips and slots render only in Edit mode', () => {
    const entries = editVault();
    render(
      <DashboardView
        entries={records(entries)}
        presentation={oneRow([countWidget('a'), countWidget('b')])}
        schema={buildSchema(entries)}
        onPresentationChange={vi.fn()}
      />,
    );
    expect(screen.queryAllByTestId('widget-grip')).toHaveLength(0);
    expect(screen.queryAllByTestId('dashboard-slot')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('dashboard-edit-toggle'));
    expect(screen.getAllByTestId('widget-grip')).toHaveLength(2);
    // One row of two widgets: slots 0..2 inside it, plus the new-row strip.
    expect(screen.getAllByTestId('dashboard-slot')).toHaveLength(4);
  });

  it('a read-only host renders neither grips nor slots', () => {
    const entries = editVault();
    render(
      <DashboardView
        entries={records(entries)}
        presentation={oneRow([countWidget('a')])}
        schema={buildSchema(entries)}
      />,
    );
    expect(screen.queryAllByTestId('widget-grip')).toHaveLength(0);
    expect(screen.queryAllByTestId('dashboard-slot')).toHaveLength(0);
  });

  /**
   * A live widget drag owns Escape (M46.2). dnd-kit cancels correctly, but
   * from a `document` bubble listener with no `preventDefault` and no
   * `stopPropagation` — so the same keystroke also reached the surface behind
   * the dashboard. A `'gesture'` layer for the drag's life makes that surface
   * defer through the `ownsEscape` it already asks; a capture listener that
   * swallowed the key would beat dnd-kit to it and cancel nothing.
   */
  describe('Escape while a widget drag is live', () => {
    beforeEach(() => resetLayers());
    afterEach(() => resetLayers());

    const announced = () =>
      [...document.querySelectorAll('[role="status"]')].map((n) => n.textContent).join(' ');

    function dashboard() {
      const entries = editVault();
      render(
        <DashboardView
          entries={records(entries)}
          presentation={oneRow([countWidget('a'), countWidget('b')])}
          schema={buildSchema(entries)}
          onPresentationChange={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByTestId('dashboard-edit-toggle'));
    }

    /**
     * The keyboard sensor's pick-up. The await is not optional:
     * `KeyboardSensor.attach` adds its own keydown listener inside a
     * `setTimeout(0)`, so a synchronous Escape never reaches dnd-kit at all.
     */
    const pickUp = async () => {
      const grip = screen.getAllByTestId('widget-grip')[0];
      grip.focus();
      fireEvent.keyDown(grip, { key: ' ', code: 'Space' });
      // Vacuity guard: with no drag in flight this case is about nothing.
      expect(announced()).toContain('Picked up draggable item');
      await new Promise((r) => setTimeout(r, 0));
      return grip;
    };

    it('takes Escape off the surface underneath, and hands it back on the cancel', async () => {
      dashboard();
      // What DetailPanel and Dialog both register; their handlers ask the
      // stack who owns the keystroke.
      pushLayer('panel');
      /**
       * And a REAL listener in DetailPanel's own phase. The `ownsEscape`
       * assertions around this read the stack BEFORE and AFTER the keystroke;
       * the defect the review found was a layer released DURING it, which only
       * a listener can see — dnd-kit cancels from `document` bubble, one phase
       * before the `window` bubble the panel listens on.
       */
      const panelClosed = vi.fn();
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && ownsEscape('panel')) panelClosed();
      };
      window.addEventListener('keydown', onKey);

      try {
        const grip = await pickUp();
        expect(ownsEscape('panel')).toBe(false);

        fireEvent.keyDown(grip, { key: 'Escape', code: 'Escape' });

        // dnd-kit's cancel still ran — the proof the layer did not swallow.
        expect(announced()).toContain('Dragging was cancelled');
        expect(panelClosed).not.toHaveBeenCalled();
        // Handed back, but only once the dispatch is over.
        await new Promise((r) => setTimeout(r, 0));
        expect(ownsEscape('panel')).toBe(true);
      } finally {
        window.removeEventListener('keydown', onKey);
      }
    });

    it('hands the layer back on a drop too', async () => {
      dashboard();
      pushLayer('panel');
      const grip = await pickUp();
      // Space again is the keyboard sensor's DROP, not a cancel.
      fireEvent.keyDown(grip, { key: ' ', code: 'Space' });
      expect(ownsEscape('panel')).toBe(true);
    });

    it('hands the layer back when the dashboard unmounts mid-drag', async () => {
      dashboard();
      pushLayer('panel');
      await pickUp();

      cleanup();

      // A leaked gesture layer sits on the stack forever, and every later
      // Escape in the app finds it there instead of the surface it was
      // aimed at.
      expect(ownsEscape('panel')).toBe(true);
    });
  });
});

/**
 * Resize (M44.4 Task 7) — the ColumnResizer split, never ResizeHandle's
 * fire-every-move: pointermoves PAINT (direct style on the shells / the row)
 * and the release COMMITS exactly once. A resize writes YAML, and the repo
 * already learned what a write per pixel does to a drag (TableView's own
 * docstring: it "barely worked").
 *
 * The gestures follow the useSortableList jsdom recipe: fake per-element
 * getBoundingClientRect, then real MouseEvents — jsdom implements no
 * PointerEvent, and testing-library's synthetic one carries no coordinates,
 * while the handlers only ever read clientX/clientY off the native event.
 */
describe('DashboardView resize (M44.4)', () => {
  const resizeSetup = (presentation: Presentation) => {
    const entries = editVault();
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

  const dash = (onChange: ReturnType<typeof vi.fn>): DashboardSpec => {
    const next = onChange.mock.calls.at(-1)?.[0] as Presentation;
    if (next.dashboard === undefined) throw new Error('expected a dashboard on the presentation');
    return next.dashboard;
  };

  // jsdom has no layout, so the px widths the seam measures at gesture start
  // come from here.
  const rect = (el: HTMLElement, left: number, width: number) => {
    el.getBoundingClientRect = () => ({ left, width, top: 0, height: 300 }) as DOMRect;
  };

  it('a seam drag paints between moves and persists both weights exactly once on release', () => {
    const onChange = resizeSetup(
      rowsPresentation({
        rows: [
          {
            id: 'r1',
            widgets: [
              { id: 'a', kind: 'number', agg: 'count', w: 1 },
              { id: 'b', kind: 'number', agg: 'count', w: 2 },
            ],
          },
        ],
      }),
    );
    // 200 + 400px, matching the 1:2 weights.
    rect(screen.getByTestId('widget-a'), 0, 200);
    rect(screen.getByTestId('widget-b'), 212, 400);

    act(() => {
      screen
        .getByTestId('dashboard-seam')
        .dispatchEvent(new MouseEvent('pointerdown', { clientX: 200, bubbles: true }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 250 }));
    });
    // Mid-gesture the shells repaint — +50px of a 600px pair holding weight 3
    // is 250/600·3 = 1.25 — but the door has not opened: paint is not persist.
    expect(screen.getByTestId('widget-a').style.flexGrow).toBe('1.25');
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300 }));
    });
    expect(screen.getByTestId('widget-a').style.flexGrow).toBe('1.5');
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', { clientX: 300 }));
    });
    // ONE write carries both: the px-proportional split of the pair's summed
    // weight — 300/600·3 = 1.5 each — each floored at 1.
    expect(onChange).toHaveBeenCalledTimes(1);
    const weights = dash(onChange).rows[0].widgets.map((w) => w.w);
    expect(weights).toEqual([1.5, 1.5]);
    for (const w of weights) expect(w).toBeGreaterThanOrEqual(1);
  });

  it('a seam drag floors both weights at one', () => {
    const onChange = resizeSetup(
      rowsPresentation({
        rows: [
          {
            id: 'r1',
            widgets: [
              { id: 'a', kind: 'number', agg: 'count' },
              { id: 'b', kind: 'number', agg: 'count' },
            ],
          },
        ],
      }),
    );
    rect(screen.getByTestId('widget-a'), 0, 300);
    rect(screen.getByTestId('widget-b'), 312, 300);
    act(() => {
      screen
        .getByTestId('dashboard-seam')
        .dispatchEvent(new MouseEvent('pointerdown', { clientX: 300, bubbles: true }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 20 }));
      window.dispatchEvent(new MouseEvent('pointerup', { clientX: 20 }));
    });
    // 20/600 of weight 2 is 0.07, floored to 1; the other side keeps its share.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(dash(onChange).rows[0].widgets.map((w) => w.w)).toEqual([1, 1.93]);
  });

  it('a row-edge drag paints the clamp and persists h = 640 once', () => {
    const onChange = resizeSetup(
      rowsPresentation({ rows: [{ id: 'r1', widgets: [countWidget('a')] }] }),
    );
    act(() => {
      screen
        .getByTestId('dashboard-row-edge')
        .dispatchEvent(new MouseEvent('pointerdown', { clientY: 300, bubbles: true }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 900 }));
    });
    // Painted AT the clamp — the drag never draws a height the commit would
    // then refuse — and not yet persisted.
    expect(screen.getByTestId('dashboard-row').style.height).toBe('640px');
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', { clientY: 900 }));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(dash(onChange).rows[0].h).toBe(640);
  });

  it('held arrow presses accumulate and settle ONE commit on blur', () => {
    const onChange = resizeSetup(
      rowsPresentation({ rows: [{ id: 'r1', widgets: [countWidget('a')] }] }),
    );
    const edge = screen.getByTestId('dashboard-row-edge');
    // A held key: one press, then repeat ticks. Commit-per-press here would
    // be one YAML write and vault rescan per tick — the failure ColumnResizer's
    // docstring records fixing; the pending ref accumulates instead.
    fireEvent.keyDown(edge, { key: 'ArrowDown' });
    for (let i = 0; i < 4; i += 1) fireEvent.keyDown(edge, { key: 'ArrowDown', repeat: true });
    // Five presses painted (300 + 5·12 = 360)…
    expect(screen.getByTestId('dashboard-row').style.height).toBe('360px');
    // …but nothing persisted until the handle is left.
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(edge);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(dash(onChange).rows[0].h).toBe(360);
  });

  it('Escape abandons what the arrows built — no write, height restored', () => {
    const onChange = resizeSetup(
      rowsPresentation({ rows: [{ id: 'r1', widgets: [countWidget('a')] }] }),
    );
    const edge = screen.getByTestId('dashboard-row-edge');
    fireEvent.keyDown(edge, { key: 'ArrowDown' });
    expect(screen.getByTestId('dashboard-row').style.height).toBe('312px');
    fireEvent.keyDown(edge, { key: 'Escape' });
    expect(screen.getByTestId('dashboard-row').style.height).toBe('300px');
    // The Escape-triggered blur finds nothing pending, so it writes nothing.
    fireEvent.blur(edge);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a cancelled seam drag cleans up and commits once at the cancel coords', () => {
    const onChange = resizeSetup(
      rowsPresentation({
        rows: [
          {
            id: 'r1',
            widgets: [
              { id: 'a', kind: 'number', agg: 'count', w: 1 },
              { id: 'b', kind: 'number', agg: 'count', w: 2 },
            ],
          },
        ],
      }),
    );
    rect(screen.getByTestId('widget-a'), 0, 200);
    rect(screen.getByTestId('widget-b'), 212, 400);
    act(() => {
      screen
        .getByTestId('dashboard-seam')
        .dispatchEvent(new MouseEvent('pointerdown', { clientX: 200, bubbles: true }));
    });
    expect(document.body.classList.contains('cb-resizing')).toBe(true);
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300 }));
      window.dispatchEvent(new MouseEvent('pointercancel', { clientX: 300 }));
    });
    // The cancel is the ColumnResizer contract: same handler as pointerup —
    // listeners off, body class off, one commit at the cancel's coords.
    expect(document.body.classList.contains('cb-resizing')).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(dash(onChange).rows[0].widgets.map((w) => w.w)).toEqual([1.5, 1.5]);
    // The listeners really are gone: a stray move after the cancel neither
    // paints nor writes again.
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 500 }));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('a seam press that never moves writes nothing and restores the weights', () => {
    const onChange = resizeSetup(
      rowsPresentation({
        rows: [
          {
            id: 'r1',
            widgets: [
              { id: 'a', kind: 'number', agg: 'count', w: 1 },
              { id: 'b', kind: 'number', agg: 'count', w: 2 },
            ],
          },
        ],
      }),
    );
    // Px deliberately OFF the 1:2 weight ratio (minWidth clamps do this in
    // real layout): had the release committed the px split of a mere click,
    // it would have written [1.4, 1.6] out of nowhere.
    rect(screen.getByTestId('widget-a'), 0, 280);
    rect(screen.getByTestId('widget-b'), 292, 320);
    act(() => {
      screen
        .getByTestId('dashboard-seam')
        .dispatchEvent(new MouseEvent('pointerdown', { clientX: 280, bubbles: true }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', { clientX: 280 }));
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('widget-a').style.flexGrow).toBe('1');
    expect(screen.getByTestId('widget-b').style.flexGrow).toBe('2');
    expect(document.body.classList.contains('cb-resizing')).toBe(false);
  });

  /**
   * Abandoning a pointer resize (M46.2). The row edge's ARROWS have taken
   * Escape since M44.4 (the case above); neither pointer loop took any, so a
   * drag begun by accident could only be ended by dropping it, and the release
   * then wrote the width or height the user was backing out of.
   */
  describe('Escape while a pointer resize is live', () => {
    beforeEach(() => resetLayers());
    afterEach(() => {
      resetLayers();
      document.body.classList.remove('cb-resizing');
    });

    const escape = () =>
      act(() => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });

    const seamRow = () =>
      rowsPresentation({
        rows: [
          {
            id: 'r1',
            widgets: [
              { id: 'a', kind: 'number', agg: 'count', w: 1 },
              { id: 'b', kind: 'number', agg: 'count', w: 2 },
            ],
          },
        ],
      });

    /** 200 + 400px, matching the 1:2 weights. */
    const measure = () => {
      rect(screen.getByTestId('widget-a'), 0, 200);
      rect(screen.getByTestId('widget-b'), 212, 400);
    };
    const grabSeam = (clientX: number) =>
      act(() => {
        screen
          .getByTestId('dashboard-seam')
          .dispatchEvent(new MouseEvent('pointerdown', { clientX, bubbles: true }));
      });
    const moveX = (clientX: number) =>
      act(() => {
        window.dispatchEvent(new MouseEvent('pointermove', { clientX }));
      });
    const upX = (clientX: number) =>
      act(() => {
        window.dispatchEvent(new MouseEvent('pointerup', { clientX }));
      });

    it('a seam drag goes back to the rendered weights and the release writes nothing', () => {
      const onChange = resizeSetup(seamRow());
      measure();
      grabSeam(200);
      moveX(300);
      expect(screen.getByTestId('widget-a').style.flexGrow).toBe('1.5');

      escape();

      expect(screen.getByTestId('widget-a').style.flexGrow).toBe('1');
      expect(screen.getByTestId('widget-b').style.flexGrow).toBe('2');
      expect(document.body.classList.contains('cb-resizing')).toBe(false);
      upX(300);
      // Without the cancel this release writes [1.5, 1.5] — the defect.
      expect(onChange).not.toHaveBeenCalled();
    });

    it('a cancelled seam drag leaves a later one able to write', () => {
      const onChange = resizeSetup(seamRow());
      measure();
      grabSeam(200);
      moveX(300);
      escape();
      upX(300);

      // A DIFFERENT split, so the assertion can tell the two worlds apart:
      // cancelling a drag to 300 and repeating it lands on the very weights
      // an uncancelled first drag would have produced.
      measure();
      grabSeam(200);
      moveX(400);
      upX(400);

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(dash(onChange).rows[0].widgets.map((w) => w.w)).toEqual([2, 1]);
    });

    it('a seam drag keeps the keystroke away from the surface behind, and hands it back', () => {
      resizeSetup(seamRow());
      measure();
      const onWindow = vi.fn();
      // What DetailPanel and Dialog both register; their handlers ask the
      // stack who owns the keystroke.
      pushLayer('panel');
      grabSeam(200);
      moveX(300);
      expect(ownsEscape('panel')).toBe(false);
      window.addEventListener('keydown', onWindow);
      try {
        escape();
        expect(onWindow).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener('keydown', onWindow);
      }
      expect(ownsEscape('panel')).toBe(true);
    });

    it('a seam drag caught by an unmount strands nothing', () => {
      const onChange = resizeSetup(seamRow());
      measure();
      pushLayer('panel');
      grabSeam(200);
      moveX(300);
      expect(document.body.classList.contains('cb-resizing')).toBe(true);

      cleanup();
      upX(300);

      expect(document.body.classList.contains('cb-resizing')).toBe(false);
      expect(onChange).not.toHaveBeenCalled();
      expect(ownsEscape('panel')).toBe(true);
    });

    const oneRowSpec = () =>
      rowsPresentation({ rows: [{ id: 'r1', widgets: [countWidget('a')] }] });
    const grabEdge = (clientY: number) =>
      act(() => {
        screen
          .getByTestId('dashboard-row-edge')
          .dispatchEvent(new MouseEvent('pointerdown', { clientY, bubbles: true }));
      });
    const moveY = (clientY: number) =>
      act(() => {
        window.dispatchEvent(new MouseEvent('pointermove', { clientY }));
      });

    it('a row-edge drag goes back to the stored height and the release writes nothing', () => {
      const onChange = resizeSetup(oneRowSpec());
      grabEdge(300);
      moveY(500);
      expect(screen.getByTestId('dashboard-row').style.height).toBe('500px');

      escape();

      expect(screen.getByTestId('dashboard-row').style.height).toBe('300px');
      expect(document.body.classList.contains('cb-resizing')).toBe(false);
      act(() => {
        window.dispatchEvent(new MouseEvent('pointerup', { clientY: 500 }));
      });
      expect(onChange).not.toHaveBeenCalled();
    });

    it('a row-edge drag takes Escape off the surface underneath, and hands it back', () => {
      resizeSetup(oneRowSpec());
      pushLayer('panel');
      grabEdge(300);
      moveY(500);
      expect(ownsEscape('panel')).toBe(false);
      escape();
      expect(ownsEscape('panel')).toBe(true);
    });

    it('a row-edge drag caught by an unmount strands nothing', () => {
      const onChange = resizeSetup(oneRowSpec());
      pushLayer('panel');
      grabEdge(300);
      moveY(500);

      cleanup();
      act(() => {
        window.dispatchEvent(new MouseEvent('pointerup', { clientY: 500 }));
      });

      expect(document.body.classList.contains('cb-resizing')).toBe(false);
      expect(onChange).not.toHaveBeenCalled();
      expect(ownsEscape('panel')).toBe(true);
    });
  });

  it('seams and row edges render only in Edit mode', () => {
    const entries = editVault();
    render(
      <DashboardView
        entries={records(entries)}
        presentation={oneRow([countWidget('a'), countWidget('b')])}
        schema={buildSchema(entries)}
        onPresentationChange={vi.fn()}
      />,
    );
    expect(screen.queryAllByTestId('dashboard-seam')).toHaveLength(0);
    expect(screen.queryAllByTestId('dashboard-row-edge')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('dashboard-edit-toggle'));
    // Two widgets share one seam; each row owns one edge.
    expect(screen.getAllByTestId('dashboard-seam')).toHaveLength(1);
    expect(screen.getAllByTestId('dashboard-row-edge')).toHaveLength(1);
  });
});
