import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { DashboardView } from '@/views/DashboardView';
import { buildSchema } from '@/engine/schema';
import { parseListYaml } from '@/engine/views';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import type { DashboardWidget, Entry, ListFile, Presentation } from '@/engine/types';

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
    expect(screen.getByText('No blocks yet')).toBeTruthy();
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
      within(widget).getByText("Pick a property to band by in the widget's settings."),
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
