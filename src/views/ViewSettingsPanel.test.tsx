// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ColumnDef } from '@/engine/columns';
import { buildSchema } from '@/engine/schema';
import type { GroupSpec, ListDefinition, Presentation } from '@/engine/types';
import { MAX_SORT_KEYS } from '@/engine/views';
import { ViewSettingsPanel } from './ViewSettingsPanel';

afterEach(cleanup);

const fields: ColumnDef[] = [
  { name: 'status', kind: 'status' },
  { name: 'priority', kind: 'select' },
  { name: 'due', kind: 'date' },
  { name: 'estimate', kind: 'number' },
];

const listWith = (presentation: Partial<Presentation>): ListDefinition => ({
  name: 'Delivery',
  icon: null,
  color: null,
  order: null,
  source: { type: 'Work item', project: null },
  views: [
    {
      id: 'grid',
      name: 'All work',
      icon: null,
      filters: null,
      presentation: {
        type: 'table',
        group: [],
        sort: [],
        columns: [{ field: 'status' }],
        ...presentation,
      },
    },
  ],
});

function setup(presentation: Partial<Presentation> = {}, extraFields: ColumnDef[] = []) {
  const onChange = vi.fn();
  render(
    <ViewSettingsPanel
      list={listWith(presentation)}
      viewId="grid"
      fields={[...fields, ...extraFields]}
      schema={buildSchema([])}
      onChange={onChange}
      onClose={vi.fn()}
    />,
  );
  const nextPresentation = () =>
    (onChange.mock.calls.at(-1)?.[0] as ListDefinition).views[0].presentation;
  return { onChange, nextPresentation };
}

/**
 * `ViewSettingsPanel` is 1,000 lines and had NO test file — the plan lists it
 * under test debt this milestone must not inherit. These cover the sections
 * M16.26 touched; the rest is still uncovered.
 */
describe('load limit (M16.26)', () => {
  it('starts at All, because every view rendered its records in full', () => {
    setup();
    expect(screen.getByTestId('view-settings-load limit').textContent).toContain('All');
  });

  it('picks a limit', () => {
    const { nextPresentation } = setup();
    fireEvent.click(screen.getByTestId('view-settings-load limit'));
    fireEvent.click(screen.getByTestId('view-limit-25'));
    expect(nextPresentation().limit).toBe(25);
  });

  /**
   * "All" is an ABSENT key, not `limit: 0` or `limit: Infinity` — a view that
   * never wanted a limit must carry nothing about one in its YAML, and the
   * parser drops a non-positive limit anyway.
   */
  it('All clears the key rather than storing a sentinel', () => {
    const { nextPresentation } = setup({ limit: 50 });
    fireEvent.click(screen.getByTestId('view-settings-load limit'));
    fireEvent.click(screen.getByTestId('view-limit-all'));
    expect(nextPresentation().limit).toBeUndefined();
  });
});

/**
 * `hideEmpty` has been honoured by `grouping.ts:140` since M9.1 and NO UI ever
 * set it, so the only way to drop the empty bands a twelve-option select
 * produces was to hand-edit the YAML (M16.26).
 */
describe('hide empty groups (M16.26)', () => {
  const grouped = { group: [{ field: 'status' }] as GroupSpec[] };

  it('offers a toggle per band level', () => {
    setup(grouped);
    fireEvent.click(screen.getByTestId('view-settings-group'));
    expect(screen.getByLabelText('Hide empty status groups')).toBeTruthy();
  });

  it('sets it on the level it belongs to', () => {
    const { nextPresentation } = setup({
      group: [{ field: 'status' }, { field: 'priority' }],
    });
    fireEvent.click(screen.getByTestId('view-settings-group'));
    fireEvent.click(screen.getByLabelText('Hide empty priority groups'));
    expect(nextPresentation().group).toEqual([
      { field: 'status' },
      { field: 'priority', hideEmpty: true },
    ]);
  });

  /**
   * Off is the default, so it is stored as an ABSENT key rather than `false`
   * — the rule every other optional presentation key follows, and what keeps
   * a view that never touched this from growing a line about it.
   */
  it('turning it back off removes the key instead of writing false', () => {
    const { nextPresentation } = setup({ group: [{ field: 'status', hideEmpty: true }] });
    fireEvent.click(screen.getByTestId('view-settings-group'));
    fireEvent.click(screen.getByLabelText('Hide empty status groups'));
    expect(nextPresentation().group).toEqual([{ field: 'status' }]);
  });

  /**
   * A relation level NESTS rather than bands, so it has no groups that could
   * be empty — offering the switch there would be a control that does nothing.
   */
  it('no toggle for a nesting level', () => {
    setup({
      group: [{ field: 'children', descend: { direction: 'forward', field: 'children' } }],
    });
    fireEvent.click(screen.getByTestId('view-settings-group'));
    expect(screen.queryByLabelText(/^Hide empty/)).toBeNull();
  });
});

/**
 * Card settings, gated on the capability each one actually needs (M16.29).
 *
 * The whole card section hung off `showsCards`, which is true for the board
 * AND the gallery — so a gallery offered "Color columns", wrote
 * `colorColumns: true` into its view file, and changed nothing on screen: a
 * gallery has no columns to colour. "Card preview" was the same shape, read
 * only by the board's card. And "Card size" appeared TWICE for both kinds,
 * once in the root panel and once inside Cards, writing two different keys.
 */
describe('card settings (M16.29)', () => {
  const openCards = () => fireEvent.click(screen.getByTestId('view-settings-cards'));

  it('offers Color columns on the board, whose groups ARE columns', () => {
    setup({ type: 'board' });
    openCards();
    expect(screen.getByLabelText('Color columns')).toBeTruthy();
  });

  /** Anywhere in the panel: the dead controls used to sit on the ROOT page,
   * beside the Cards row rather than inside it. */
  const absent = (query: () => unknown) => {
    expect(query()).toBeNull();
    openCards();
    expect(query()).toBeNull();
  };

  it('does not offer Color columns on a gallery, which has no columns', () => {
    setup({ type: 'gallery' });
    absent(() => screen.queryByLabelText('Color columns'));
  });

  it('does not offer Card preview on a gallery, whose card draws no snippet', () => {
    setup({ type: 'gallery' });
    absent(() => screen.queryByText('Card preview'));
  });

  it('does not offer a cover on the board, whose card draws none', () => {
    setup({ type: 'board' }, [{ name: 'artwork', kind: 'files' }]);
    absent(() => screen.queryByText('Card cover'));
    expect(screen.queryByLabelText('Fit media')).toBeNull();
  });

  /** Card size lived in the root panel AND in Cards, writing `cardSize` in one
   * place and `gallery.size` in the other — two controls, two keys, one
   * setting, and only one of them was read by any given layout. */
  it('states card size exactly once, on the Cards page', () => {
    setup({ type: 'gallery' });
    expect(screen.queryByText('Card size')).toBeNull();
    openCards();
    expect(screen.getAllByText('Card size')).toHaveLength(1);
  });

  it('writes one card-size key, whichever card layout set it', () => {
    const { nextPresentation } = setup({ type: 'gallery' });
    openCards();
    fireEvent.change(screen.getByDisplayValue('Medium'), { target: { value: 'large' } });
    expect(nextPresentation().cardSize).toBe('large');
    expect(nextPresentation().gallery).toBeUndefined();
  });

  /** Off is the default, so it is an ABSENT key rather than `false` — the rule
   * every optional presentation key follows. */
  it('deletes colorColumns rather than storing a false when switched back off', () => {
    const { nextPresentation } = setup({ type: 'board', colorColumns: true });
    openCards();
    fireEvent.click(screen.getByLabelText('Color columns'));
    expect(nextPresentation()).not.toHaveProperty('colorColumns');
  });

  it('has no Cards row at all on a layout that draws no cards', () => {
    setup({ type: 'table' });
    expect(screen.queryByTestId('view-settings-cards')).toBeNull();
  });
});

/**
 * The Chart page's footnote named a shape the chart was not drawing (M16.29).
 *
 * "The bars come from the view's grouping" is correct for a bar chart and a
 * lie for the other two thirds of the control right above it: a donut has
 * slices and a line has points. The one sentence explaining where a chart's X
 * axis comes from — which was the Group row alone until `xField` joined this
 * page (M44.3) — was the sentence describing the wrong chart.
 */
/**
 * Row height and "Wrap all columns" are settings for the WHOLE table, and the
 * only place either could be reached was the Name column's header menu
 * (M16.29). Not view settings, where every other whole-view setting lives, and
 * not any other column's menu — so a user looking for them opened Priority's
 * menu, found neither, and had no reason to think Name's was different.
 */
describe('row settings (M16.29)', () => {
  const openRows = () => fireEvent.click(screen.getByTestId('view-settings-rows'));

  it('reports the current height on the root row', () => {
    setup({ rowHeight: 'tall' });
    expect(screen.getByTestId('view-settings-rows').textContent).toContain('Tall');
  });

  it('sets the row height', () => {
    const { nextPresentation } = setup();
    openRows();
    fireEvent.click(screen.getByTestId('row-height-compact'));
    expect(nextPresentation().rowHeight).toBe('compact');
  });

  it('wraps every column at once', () => {
    const { nextPresentation } = setup({ columns: [{ field: 'status' }, { field: 'due' }] });
    openRows();
    fireEvent.click(screen.getByLabelText('Wrap all columns'));
    expect(nextPresentation().columns).toEqual([
      { field: 'status', wrap: true },
      { field: 'due', wrap: true },
    ]);
  });

  /** Unwrapping deletes the key rather than storing `wrap: false` per column. */
  it('unwraps them the same way, without leaving a false behind', () => {
    const { nextPresentation } = setup({
      columns: [
        { field: 'status', wrap: true },
        { field: 'due', wrap: true },
      ],
    });
    openRows();
    fireEvent.click(screen.getByLabelText('Wrap all columns'));
    expect(nextPresentation().columns).toEqual([{ field: 'status' }, { field: 'due' }]);
  });

  /** A board has no rows to make taller and no columns to wrap. */
  it('is absent on a layout that draws no table', () => {
    setup({ type: 'board' });
    expect(screen.queryByTestId('view-settings-rows')).toBeNull();
  });
});

describe('chart settings (M16.29)', () => {
  const openChart = () => fireEvent.click(screen.getByTestId('view-settings-chart'));

  it('says bars for a bar chart', () => {
    setup({ type: 'chart', group: [{ field: 'status' }] });
    openChart();
    expect(screen.getByText(/^The bars come from/)).toBeTruthy();
  });

  it('says slices for a donut', () => {
    setup({ type: 'chart', group: [{ field: 'status' }], chart: { kind: 'donut' } });
    openChart();
    expect(screen.getByText(/^The slices come from/)).toBeTruthy();
  });

  it('says points for a line', () => {
    setup({ type: 'chart', group: [{ field: 'status' }], chart: { kind: 'line' } });
    openChart();
    expect(screen.getByText(/^The points come from/)).toBeTruthy();
  });

  /** The ungrouped wording is the same sentence, and drifted the same way. */
  it('names the shape in the ungrouped case too', () => {
    setup({ type: 'chart', group: [], chart: { kind: 'donut' } });
    openChart();
    expect(screen.getByText(/^The slices come from .* this view has none yet/)).toBeTruthy();
  });
});

/**
 * Every M44.2 chart setting gets a panel control, and `patch` stores only
 * DEVIATIONS: a value equal to its default is a deleted key, and a key the
 * current kind cannot read is deleted too — so switching kinds sheds the
 * settings the new kind has no use for, and the YAML never claims a setting
 * the chart is not drawing.
 */
describe('chart controls (M44.2)', () => {
  const openChart = () => fireEvent.click(screen.getByTestId('view-settings-chart'));
  const NONE = '__none__';
  const chartSetup = (chart?: Presentation['chart']) =>
    setup({ type: 'chart', group: [{ field: 'status' }], chart });

  it('stores horizontal only while true, and deletes it when switched back', () => {
    const first = chartSetup();
    openChart();
    fireEvent.click(screen.getByRole('switch', { name: 'Horizontal' }));
    expect(first.nextPresentation().chart).toEqual({ horizontal: true });
    cleanup();
    const second = chartSetup({ horizontal: true });
    openChart();
    fireEvent.click(screen.getByRole('switch', { name: 'Horizontal' }));
    expect(second.nextPresentation().chart).toBeUndefined();
  });

  it('a height preset off m is stored, and m is deleted', () => {
    const first = chartSetup();
    openChart();
    fireEvent.click(screen.getByRole('tab', { name: 'XL' }));
    expect(first.nextPresentation().chart).toEqual({ height: 'xl' });
    cleanup();
    const second = chartSetup({ height: 'xl' });
    openChart();
    fireEvent.click(screen.getByRole('tab', { name: 'M' }));
    expect(second.nextPresentation().chart).toBeUndefined();
  });

  it('legend is stored only off the kind default — a donut stores false, a bar stores true', () => {
    const first = chartSetup();
    openChart();
    fireEvent.click(screen.getByRole('switch', { name: 'Legend' }));
    expect(first.nextPresentation().chart).toEqual({ legend: true });
    cleanup();
    const second = chartSetup({ kind: 'donut' });
    openChart();
    fireEvent.click(screen.getByRole('switch', { name: 'Legend' }));
    expect(second.nextPresentation().chart).toEqual({ kind: 'donut', legend: false });
  });

  /** A number chart reads NO axis (M44.2), so the M44.3 axis keys —
   * `xField`, `groupBy` and both hidden rosters — are shed with the rest. */
  it('switching to the number kind keeps the measure and drops the axis-only settings', () => {
    const { nextPresentation } = chartSetup({
      sort: 'value-desc',
      horizontal: true,
      height: 'l',
      legend: true,
      xField: 'priority',
      groupBy: 'status',
      hidden: ['todo'],
      hiddenG: ['active'],
    });
    openChart();
    fireEvent.change(screen.getByDisplayValue('Bar'), { target: { value: 'number' } });
    expect(nextPresentation().chart).toEqual({ kind: 'number' });
  });

  it('stores a band sort, and Declared order deletes it', () => {
    const first = chartSetup();
    openChart();
    fireEvent.change(screen.getByDisplayValue('Declared order'), {
      target: { value: 'value-desc' },
    });
    expect(first.nextPresentation().chart).toEqual({ sort: 'value-desc' });
    cleanup();
    const second = chartSetup({ sort: 'value-desc' });
    openChart();
    fireEvent.change(screen.getByDisplayValue('Biggest first'), { target: { value: NONE } });
    expect(second.nextPresentation().chart).toBeUndefined();
  });

  it('a palette stores its hue, and Shade by value appears only once there is one', () => {
    const first = chartSetup();
    openChart();
    expect(screen.queryByRole('switch', { name: 'Shade by value' })).toBeNull();
    fireEvent.change(screen.getByDisplayValue('By option colour'), { target: { value: 'blue' } });
    expect(first.nextPresentation().chart).toEqual({ palette: 'blue' });
    cleanup();
    const second = chartSetup({ palette: 'blue' });
    openChart();
    fireEvent.click(screen.getByRole('switch', { name: 'Shade by value' }));
    expect(second.nextPresentation().chart).toEqual({ palette: 'blue', colorByValue: true });
  });

  /** The hide-flavoured keys invert at the control: the switch says what the
   * user sees ("Grid lines on"), the spec stores the deviation. */
  it('turning Grid lines off stores hideGrid, and the line and donut extras store true', () => {
    const first = chartSetup();
    openChart();
    fireEvent.click(screen.getByRole('switch', { name: 'Grid lines' }));
    expect(first.nextPresentation().chart).toEqual({ hideGrid: true });
    cleanup();
    const second = chartSetup({ kind: 'line' });
    openChart();
    fireEvent.click(screen.getByRole('switch', { name: 'Smooth line' }));
    expect(second.nextPresentation().chart).toEqual({ kind: 'line', smooth: true });
    cleanup();
    const third = chartSetup({ kind: 'donut' });
    openChart();
    fireEvent.click(screen.getByRole('switch', { name: 'Centre total' }));
    expect(third.nextPresentation().chart).toEqual({ kind: 'donut', hideDonutCenter: true });
  });

  /** `HBarChart` draws no grid and no axis by design — it labels its own
   * bands — so on a horizontal bar those two switches would change nothing,
   * and a stored `hideGrid`/`hideAxis` would be a key nothing reads. */
  it('a horizontal bar hides the grid and axis switches, and patch drops their keys', () => {
    const { nextPresentation } = chartSetup({ horizontal: true, hideGrid: true, hideAxis: true });
    openChart();
    expect(screen.queryByRole('switch', { name: 'Grid lines' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Axis labels' })).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Value labels' }));
    expect(nextPresentation().chart).toEqual({ horizontal: true, hideLabels: true });
  });

  /** `DonutChart` reads none of `hideGrid`/`hideAxis`/`hideLabels`/`height` —
   * they only drive the Axes path and the bar/line svg geometry — so
   * switching a spec that carries all four into a donut must shed them
   * rather than leave stored words the renderer never looks at. */
  it('switching to donut drops the settings only bar/line render', () => {
    const { nextPresentation } = chartSetup({
      hideGrid: true,
      hideAxis: true,
      hideLabels: true,
      height: 'xl',
      // A donut ignores `groupBy` (M44.3), so the second dimension and its
      // hidden roster are shed with the bar/line-only style keys.
      groupBy: 'priority',
      hiddenG: ['low'],
    });
    openChart();
    fireEvent.change(screen.getByDisplayValue('Bar'), { target: { value: 'donut' } });
    expect(nextPresentation().chart).toEqual({ kind: 'donut' });
  });

  /** The old patch rebuilt from a four-key allowlist, so a hand-edited
   * `sort:`/`height:` was DROPPED the next time any control was touched. */
  it('touching an unrelated control preserves every stored M44.2 key', () => {
    const { nextPresentation } = chartSetup({ sort: 'value-desc', height: 'xl' });
    openChart();
    fireEvent.click(screen.getByRole('switch', { name: 'Omit zero values' }));
    expect(nextPresentation().chart).toEqual({ sort: 'value-desc', height: 'xl', omitZero: true });
  });
});

/**
 * The chart names its own axis (M44.3): `xField` overrides the view grouping,
 * `groupBy` adds the second dimension. The panel's patch must also carry the
 * legend's `hidden`/`hiddenG` — written through onChartChange, not by any
 * control here — and drop each exactly when its dimension changes, because
 * stale keys name bands or series that no longer exist.
 */
describe('chart axis pickers (M44.3)', () => {
  const openChart = () => fireEvent.click(screen.getByTestId('view-settings-chart'));
  const NONE = '__none__';
  const chartSetup = (chart?: Presentation['chart'], extra: ColumnDef[] = []) =>
    setup({ type: 'chart', group: [{ field: 'status' }], chart }, extra);

  it('the X axis select stores xField, and the View grouping sentinel deletes it', () => {
    const first = chartSetup();
    openChart();
    fireEvent.change(screen.getByDisplayValue('View grouping'), { target: { value: 'priority' } });
    expect(first.nextPresentation().chart).toEqual({ xField: 'priority' });
    cleanup();
    const second = chartSetup({ xField: 'priority' });
    openChart();
    fireEvent.change(screen.getByDisplayValue('Priority'), { target: { value: NONE } });
    expect(second.nextPresentation().chart).toBeUndefined();
  });

  /** Only bar and line stack: a donut ignores `groupBy` and a number chart
   * reads no axis at all — a picker there would write a key nothing reads. */
  it('the Group by select stores groupBy, and appears only for bar and line', () => {
    const first = chartSetup();
    openChart();
    fireEvent.change(screen.getByDisplayValue('None'), { target: { value: 'priority' } });
    expect(first.nextPresentation().chart).toEqual({ groupBy: 'priority' });
    cleanup();
    chartSetup({ kind: 'donut' });
    openChart();
    expect(screen.getByText('X axis')).toBeTruthy();
    expect(screen.queryByText('Group by')).toBeNull();
    cleanup();
    chartSetup({ kind: 'number' });
    openChart();
    expect(screen.queryByText('X axis')).toBeNull();
    expect(screen.queryByText('Group by')).toBeNull();
  });

  it('an unrelated control preserves hidden and hiddenG', () => {
    const { nextPresentation } = chartSetup({
      groupBy: 'priority',
      hidden: ['todo'],
      hiddenG: ['low'],
    });
    openChart();
    fireEvent.click(screen.getByRole('switch', { name: 'Omit zero values' }));
    expect(nextPresentation().chart).toEqual({
      groupBy: 'priority',
      hidden: ['todo'],
      hiddenG: ['low'],
      omitZero: true,
    });
  });

  it('changing the X axis drops hidden and keeps hiddenG — and vice versa', () => {
    const extra: ColumnDef[] = [{ name: 'team', kind: 'select' }];
    const first = chartSetup({ groupBy: 'team', hidden: ['todo'], hiddenG: ['a'] }, extra);
    openChart();
    fireEvent.change(screen.getByDisplayValue('View grouping'), { target: { value: 'priority' } });
    expect(first.nextPresentation().chart).toEqual({
      xField: 'priority',
      groupBy: 'team',
      hiddenG: ['a'],
    });
    cleanup();
    const second = chartSetup(
      { xField: 'priority', groupBy: 'status', hidden: ['high'], hiddenG: ['active'] },
      extra,
    );
    openChart();
    fireEvent.change(screen.getByDisplayValue('Status'), { target: { value: 'team' } });
    expect(second.nextPresentation().chart).toEqual({
      xField: 'priority',
      groupBy: 'team',
      hidden: ['high'],
    });
  });

  /** The matrix's remaining cells (Task 4 review): set→different-field on X,
   * and set→absent on Group by. Each drops exactly its own roster — the other
   * dimension's bands or series did not change, so its keys stay. */
  it('a set X axis moving to another field drops hidden; Group by cleared drops hiddenG', () => {
    const extra: ColumnDef[] = [{ name: 'team', kind: 'select' }];
    const first = chartSetup(
      { xField: 'priority', groupBy: 'team', hidden: ['todo'], hiddenG: ['a'] },
      extra,
    );
    openChart();
    fireEvent.change(screen.getByDisplayValue('Priority'), { target: { value: 'status' } });
    expect(first.nextPresentation().chart).toEqual({
      xField: 'status',
      groupBy: 'team',
      hiddenG: ['a'],
    });
    cleanup();
    const second = chartSetup({ groupBy: 'priority', hidden: ['todo'], hiddenG: ['low'] });
    openChart();
    fireEvent.change(screen.getByDisplayValue('Priority'), { target: { value: NONE } });
    expect(second.nextPresentation().chart).toEqual({ hidden: ['todo'] });
  });

  /** Multi-series lines never read `area` — overlapping washes at one opacity
   * are unreadable, so LineChart draws the fill single-series only. A switch
   * under groupBy would be dead, and a stored `area` a key nothing reads. */
  it('Area fill is absent under groupBy, and patch drops a seeded area', () => {
    chartSetup({ kind: 'line' });
    openChart();
    expect(screen.getByRole('switch', { name: 'Area fill' })).toBeTruthy();
    cleanup();
    chartSetup({ kind: 'line', groupBy: 'priority' });
    openChart();
    expect(screen.queryByRole('switch', { name: 'Area fill' })).toBeNull();
    cleanup();
    const { nextPresentation } = chartSetup({ kind: 'line', groupBy: 'priority', area: true });
    openChart();
    fireEvent.click(screen.getByRole('switch', { name: 'Omit zero values' }));
    expect(nextPresentation().chart).toEqual({ kind: 'line', groupBy: 'priority', omitZero: true });
  });
});

describe('sort page (M16.26)', () => {
  const twoKeys = {
    sort: [
      { field: 'status', dir: 'asc' as const },
      { field: 'due', dir: 'desc' as const },
    ],
  };

  it('a grip promotes a key from the keyboard', () => {
    const { nextPresentation } = setup(twoKeys);
    fireEvent.click(screen.getByTestId('view-settings-sort'));
    fireEvent.keyDown(screen.getByLabelText(/^Reorder Due/), { key: 'ArrowUp' });
    expect(nextPresentation().sort.map((s) => s.field)).toEqual(['due', 'status']);
  });

  /**
   * This page enforced NO cap while the toolbar's chain builder passed
   * `max={4}`, so the same view accepted a fifth key here and refused it
   * there.
   */
  it('caps the chain at the same number of keys the toolbar does', () => {
    setup({
      sort: Array.from({ length: MAX_SORT_KEYS }, (_, i) => ({
        field: `f${i}`,
        dir: 'asc' as const,
      })),
    });
    fireEvent.click(screen.getByTestId('view-settings-sort'));
    expect(screen.queryByText('Add a sort…')).toBeNull();
    expect(screen.getByText(new RegExp(`${MAX_SORT_KEYS} keys is the maximum`))).toBeTruthy();
  });
});

/**
 * The root page's rows were all ungated except Group and Rows, so the tenth
 * view kind (M29.45) arrived showing five of them — and one, Properties,
 * configures a record layout the whiteboard does not have. A canvas is a
 * `.mmd` file; nothing on it reads `columns`. That is the calendar's M16.3
 * bug ("a control that changes nothing"), reached through an ungated row
 * rather than a wrong capability, which is why it survived the capability
 * table this milestone built.
 */
describe('the root page on a canvas (M29.46)', () => {
  it('does not offer Properties on a whiteboard, which draws no columns', () => {
    setup({ type: 'whiteboard' });
    expect(screen.queryByText('Properties')).toBeNull();
  });

  /** Filter, Sort and Load limit stay: they decide which records the canvas
   *  can place (M29.47), so they are live controls there, not dead ones. */
  it('keeps the rows that decide which records the canvas can place', () => {
    setup({ type: 'whiteboard' });
    expect(screen.getByText('Filter')).toBeTruthy();
    expect(screen.getByText('Sort')).toBeTruthy();
    expect(screen.getByText('Load limit')).toBeTruthy();
  });

  it('still offers Properties on a table', () => {
    setup({ type: 'table' });
    expect(screen.getByText('Properties')).toBeTruthy();
  });
});

/**
 * M44.4 Task 8: the canvas's own Edit mode became the widget editor (add
 * popover, menu, drag, resize, filters) in Tasks 1-7, so this page shrinks to
 * the Global filter plus a pointer back to the canvas — a second flat-widget
 * editor over the same rows would only drift from it.
 */
describe('blocks page (M44.4)', () => {
  const oneWidget: Partial<Presentation> = {
    type: 'dashboard',
    group: [],
    dashboard: { rows: [{ id: 'r', widgets: [{ id: 'a', kind: 'table' }] }] },
  };

  it('counts widgets and points at the canvas instead of editing blocks', () => {
    setup(oneWidget);
    fireEvent.click(screen.getByTestId('view-settings-blocks'));
    expect(screen.getByText('1 widget')).toBeTruthy();
    expect(screen.getByText(/edited on the dashboard itself/i)).toBeTruthy();
    expect(screen.queryByTestId('add-number-block')).toBeNull();
    expect(screen.queryByTestId('block-row-a')).toBeNull();
  });

  it('shows the widget count on the nav row without opening the page', () => {
    setup(oneWidget);
    expect(screen.getByTestId('view-settings-blocks').textContent).toContain('1');
  });

  it('reads zero widgets off an absent dashboard rather than throwing', () => {
    setup({ type: 'dashboard', group: [] });
    fireEvent.click(screen.getByTestId('view-settings-blocks'));
    expect(screen.getByText('0 widgets')).toBeTruthy();
  });

  it('wires the Global filter to spec.global', () => {
    const { nextPresentation } = setup(oneWidget);
    fireEvent.click(screen.getByTestId('view-settings-blocks'));
    fireEvent.click(screen.getByText('Add filter'));
    expect(nextPresentation().dashboard?.global).toEqual({
      all: [{ field: 'status', op: 'is_not_empty' }],
    });
    // The widget rows themselves are untouched — this page no longer writes
    // them at all.
    expect(nextPresentation().dashboard?.rows).toEqual(oneWidget.dashboard?.rows);
  });

  it('an emptied Global filter deletes the key rather than storing an empty group', () => {
    const withGlobal: Partial<Presentation> = {
      type: 'dashboard',
      group: [],
      dashboard: { rows: [], global: { all: [{ field: 'status', op: 'is_not_empty' }] } },
    };
    const { nextPresentation } = setup(withGlobal);
    fireEvent.click(screen.getByTestId('view-settings-blocks'));
    fireEvent.click(screen.getByLabelText('Remove filter'));
    expect(nextPresentation().dashboard?.global).toBeUndefined();
  });
});
