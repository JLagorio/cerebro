import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChartView, sliceColor } from '@/views/ChartView';
import { buildSchema } from '@/engine/schema';
import { makeEntry } from '@/test/factories';
import type { ChartSlice } from '@/engine/chart';
import type { Entry, Presentation } from '@/engine/types';

/**
 * The chart's rendering (M16.27).
 *
 * Written as inline SVG on purpose — a charting library would be a runtime
 * dependency and a CSP surface for three shapes the browser already draws.
 * What these pin is the part a hand-written chart gets wrong: an axis that
 * cannot be read, a colour that is not a token, and a canvas that goes blank
 * instead of saying why.
 */

const vault = (): Entry[] => [
  makeEntry({
    path: 'types/work-item.md',
    title: 'Work item',
    type: 'Type',
    properties: {
      fields: { status: { kind: 'status' }, estimate: { kind: 'number' } },
      statuses: [
        { id: 'todo', group: 'active', color: 'blue' },
        { id: 'doing', group: 'active', color: 'orange' },
      ],
    } as unknown as Entry['properties'],
  }),
  makeEntry({
    path: 'items/a.md',
    title: 'A',
    type: 'Work item',
    properties: { status: 'todo', estimate: 3 },
  }),
  makeEntry({
    path: 'items/b.md',
    title: 'B',
    type: 'Work item',
    properties: { status: 'todo', estimate: 5 },
  }),
  makeEntry({
    path: 'items/c.md',
    title: 'C',
    type: 'Work item',
    properties: { status: 'doing', estimate: 2 },
  }),
];

/** vault() plus a third status and record — a curve needs three points. */
const wide = (): Entry[] => {
  const entries = vault();
  (
    entries[0].properties as unknown as { statuses: { id: string; group: string; color: string }[] }
  ).statuses.push({ id: 'done', group: 'done', color: 'green' });
  entries.push(
    makeEntry({
      path: 'items/d.md',
      title: 'D',
      type: 'Work item',
      properties: { status: 'done', estimate: 1 },
    }),
  );
  return entries;
};

/** vault() with a second groupable dimension — the stacked/series fixture. */
const stacked = (): Entry[] => [
  makeEntry({
    path: 'types/work-item.md',
    title: 'Work item',
    type: 'Type',
    properties: {
      fields: {
        status: { kind: 'status' },
        estimate: { kind: 'number' },
        priority: {
          kind: 'select',
          options: [
            { id: 'high', color: 'red' },
            { id: 'low', color: 'gray' },
          ],
        },
      },
      statuses: [
        { id: 'todo', group: 'active', color: 'blue' },
        { id: 'doing', group: 'active', color: 'orange' },
      ],
    } as unknown as Entry['properties'],
  }),
  makeEntry({
    path: 'items/a.md',
    title: 'A',
    type: 'Work item',
    properties: { status: 'todo', priority: 'high', estimate: 3 },
  }),
  makeEntry({
    path: 'items/b.md',
    title: 'B',
    type: 'Work item',
    properties: { status: 'todo', priority: 'low', estimate: 5 },
  }),
  // Doing holds no `low` row — the gap-rule band for a multi-series line.
  makeEntry({
    path: 'items/c.md',
    title: 'C',
    type: 'Work item',
    properties: { status: 'doing', priority: 'high', estimate: 2 },
  }),
];

const records = (entries: Entry[]) => entries.filter((e) => e.path.startsWith('items/'));

const view = (over: Partial<Presentation> = {}): Presentation => ({
  type: 'chart',
  group: [{ field: 'status' }],
  sort: [],
  columns: [],
  ...over,
});

afterEach(cleanup);

describe('ChartView', () => {
  it('draws one bar per band, labelled with what it measures', () => {
    const entries = vault();
    render(
      <ChartView
        filtered={false}
        entries={records(entries)}
        presentation={view()}
        schema={buildSchema(entries)}
      />,
    );
    const bars = screen.getAllByTestId('chart-bar');
    expect(bars.map((b) => b.getAttribute('data-label'))).toEqual(['Todo', 'Doing']);
    expect(bars.map((b) => b.getAttribute('data-value'))).toEqual(['2', '1']);
    expect(screen.getByTestId('chart-view').getAttribute('data-chart-measure')).toBe('Count');
  });

  it('height preset drives the svg viewBox', () => {
    const entries = vault();
    const { container } = render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { height: 'xl' } })}
        schema={buildSchema(entries)}
        filtered={false}
      />,
    );
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 640 560');
  });

  it('draws a line with a point per band when asked for one', () => {
    const entries = vault();
    render(
      <ChartView
        filtered={false}
        entries={records(entries)}
        presentation={view({ chart: { kind: 'line' } })}
        schema={buildSchema(entries)}
      />,
    );
    expect(screen.getByTestId('chart-line')).toBeTruthy();
    expect(screen.getAllByTestId('chart-point')).toHaveLength(2);
    expect(screen.queryAllByTestId('chart-bar')).toHaveLength(0);
  });

  it('draws a donut as arcs plus a legend, and never a zero-length arc', () => {
    const entries = vault();
    render(
      <ChartView
        filtered={false}
        entries={records(entries)}
        presentation={view({ chart: { kind: 'donut' } })}
        schema={buildSchema(entries)}
      />,
    );
    // Two bands hold records; a third declared status would contribute an arc
    // of length zero, which paints a hairline at twelve o'clock.
    expect(screen.getAllByTestId('chart-arc')).toHaveLength(2);
    // Each legend row carries its band's value, not just its name.
    expect(screen.getAllByTestId('chart-legend-item').map((r) => r.textContent)).toEqual([
      'Todo2',
      'Doing1',
    ]);
  });

  it('sums a numeric property when the measure says so', () => {
    const entries = vault();
    render(
      <ChartView
        filtered={false}
        entries={records(entries)}
        presentation={view({ chart: { agg: 'sum', value: 'estimate' } })}
        schema={buildSchema(entries)}
      />,
    );
    expect(screen.getAllByTestId('chart-bar').map((b) => b.getAttribute('data-value'))).toEqual([
      '8',
      '2',
    ]);
    expect(screen.getByTestId('chart-view').getAttribute('data-chart-measure')).toBe(
      'Sum of Estimate',
    );
  });

  // The chart has no grouping of its own: it reads the same chain the board
  // and list read, so re-opening a board as a chart charts the board's columns.
  it('takes its X axis from the view’s grouping chain', () => {
    const entries = vault();
    render(
      <ChartView
        filtered={false}
        entries={records(entries)}
        presentation={view({ group: [{ field: 'status', dir: 'desc' }] })}
        schema={buildSchema(entries)}
      />,
    );
    expect(screen.getAllByTestId('chart-bar').map((b) => b.getAttribute('data-label'))).toEqual([
      'Doing',
      'Todo',
    ]);
  });

  it('says which control fixes an unchartable view rather than going blank', () => {
    const entries = vault();
    const schema = buildSchema(entries);
    const { unmount } = render(
      <ChartView
        filtered={false}
        entries={records(entries)}
        presentation={view({ group: [] })}
        schema={schema}
      />,
    );
    expect(screen.getByTestId('chart-empty').getAttribute('data-reason')).toBe('no-group');
    // Both controls fix it now (M44.3): an xField in chart settings, or the
    // view grouping the axis defaults to.
    expect(screen.getByText(/Pick an X axis in chart settings, or group the view/)).toBeTruthy();
    unmount();

    render(
      <ChartView
        filtered={false}
        entries={records(entries)}
        presentation={view({ chart: { agg: 'avg' } })}
        schema={schema}
      />,
    );
    expect(screen.getByTestId('chart-empty').getAttribute('data-reason')).toBe('no-value-field');
  });

  it('blames the filters when they are what emptied the view', () => {
    const entries = vault();
    render(<ChartView entries={[]} presentation={view()} schema={buildSchema(entries)} filtered />);
    expect(screen.getByText('Nothing matches these filters')).toBeTruthy();
  });

  it('renders a number chart as one big stat, no axes', () => {
    const entries = vault();
    const { container } = render(
      <ChartView
        entries={records(entries)}
        presentation={view({ group: [], chart: { kind: 'number' } })}
        schema={buildSchema(entries)}
        filtered={false}
      />,
    );
    const stat = screen.getByTestId('chart-number');
    expect(stat.textContent).toContain('3');
    expect(stat.textContent).toContain('Count');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('horizontal bars grow along x, one per band', () => {
    const entries = vault();
    render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { horizontal: true } })}
        schema={buildSchema(entries)}
        filtered={false}
      />,
    );
    const bars = screen.getAllByTestId('chart-bar');
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) expect(Number(bar.getAttribute('height'))).toBeLessThanOrEqual(40);
  });

  it('hideGrid keeps the base line and drops the rest', () => {
    const entries = vault();
    const schema = buildSchema(entries);
    const on = render(
      <ChartView
        entries={records(entries)}
        presentation={view()}
        schema={schema}
        filtered={false}
      />,
    );
    expect(on.container.querySelectorAll('[data-testid="chart-grid-line"]').length).toBeGreaterThan(
      0,
    );
    cleanup();
    const { container } = render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { hideGrid: true } })}
        schema={schema}
        filtered={false}
      />,
    );
    expect(container.querySelectorAll('[data-testid="chart-grid-line"]').length).toBe(0);
    // The base line survives — a floating chart with no ground reads broken.
    expect(container.querySelectorAll('svg line').length).toBe(1);
  });

  it('hideAxis drops tick numbers and band labels', () => {
    const entries = vault();
    const schema = buildSchema(entries);
    const on = render(
      <ChartView
        entries={records(entries)}
        presentation={view()}
        schema={schema}
        filtered={false}
      />,
    );
    expect(on.container.querySelectorAll('[data-testid="chart-tick"]').length).toBeGreaterThan(0);
    cleanup();
    const { container } = render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { hideAxis: true } })}
        schema={schema}
        filtered={false}
      />,
    );
    expect(container.querySelectorAll('[data-testid="chart-tick"]').length).toBe(0);
    // Everything textual left in the svg is a value label — no ticks, no
    // measure label, no band labels under the axis.
    const texts = [...container.querySelectorAll('svg text')].map((t) => t.textContent);
    expect(texts).toEqual(['2', '1']);
  });

  it('a smooth line is a curve, a plain line is segments', () => {
    // Three bands: a Catmull-Rom curve through two points is just the segment.
    const entries = wide();
    const schema = buildSchema(entries);
    const plain = render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { kind: 'line' } })}
        schema={schema}
        filtered={false}
      />,
    );
    const straight = plain.container.querySelector('[data-testid="chart-line"]')?.getAttribute('d');
    expect(straight).toMatch(/^M/);
    expect(straight).not.toContain('C');
    cleanup();
    const { container } = render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { kind: 'line', smooth: true } })}
        schema={schema}
        filtered={false}
      />,
    );
    expect(container.querySelector('[data-testid="chart-line"]')?.getAttribute('d')).toContain('C');
  });

  it('smooth degrades to straight segments when there are fewer than three points', () => {
    const entries = vault();
    const { container } = render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { kind: 'line', smooth: true } })}
        schema={buildSchema(entries)}
        filtered={false}
      />,
    );
    const d = container.querySelector('[data-testid="chart-line"]')?.getAttribute('d');
    expect(d).toMatch(/^M/);
    expect(d).not.toContain('C');
  });

  it('area fill draws a closed wash under the line', () => {
    const entries = vault();
    render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { kind: 'line', area: true } })}
        schema={buildSchema(entries)}
        filtered={false}
      />,
    );
    expect(screen.getByTestId('chart-area')).toBeTruthy();
    expect(screen.getByTestId('chart-area').getAttribute('d')).toContain('Z');
  });

  it('hideDonutCenter empties the ring', () => {
    const entries = vault();
    const schema = buildSchema(entries);
    render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { kind: 'donut' } })}
        schema={schema}
        filtered={false}
      />,
    );
    expect(screen.getAllByTestId('chart-donut-total')).toHaveLength(1);
    cleanup();
    const { container } = render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { kind: 'donut', hideDonutCenter: true } })}
        schema={schema}
        filtered={false}
      />,
    );
    expect(container.querySelectorAll('[data-testid="chart-donut-total"]').length).toBe(0);
  });

  it('legend: true puts a legend under a bar chart, and a donut can refuse its own', () => {
    const entries = vault();
    const schema = buildSchema(entries);
    render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { legend: true } })}
        schema={schema}
        filtered={false}
      />,
    );
    expect(screen.getAllByTestId('chart-legend-item').length).toBeGreaterThan(0);
    cleanup();
    render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { kind: 'donut', legend: false } })}
        schema={schema}
        filtered={false}
      />,
    );
    expect(screen.queryAllByTestId('chart-legend-item').length).toBe(0);
  });

  // A no-palette line draws every point in one uniform stroke (LineChart's
  // `stroke = 'var(--cortex-500)'`); a legend that swatched per-band option
  // hues here would show colours nothing on the chart actually uses.
  it('a no-palette line legend swatches to the line colour, not per-band hues', () => {
    const entries = vault();
    const { container } = render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { kind: 'line', legend: true } })}
        schema={buildSchema(entries)}
        filtered={false}
      />,
    );
    // Each legend item renders two spans — the colour swatch, then the
    // formatted value — so scope to the swatch by its rounded-sm class.
    const swatches = [
      ...container.querySelectorAll('[data-testid="chart-legend-item"] span.rounded-sm'),
    ];
    expect(swatches.length).toBeGreaterThan(0);
    expect(
      swatches.every((s) => (s as HTMLElement).style.background.includes('--cortex-500')),
    ).toBe(true);
  });

  // A palette line already colours its points via sliceColor (LineChart's
  // circle `stroke`), so the legend keeping the same per-slice call is
  // correct as-is — the fix above must not touch this path.
  it('a palette line legend keeps sliceColor’s per-slice colours', () => {
    const entries = vault();
    const { container } = render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { kind: 'line', legend: true, palette: 'purple' } })}
        schema={buildSchema(entries)}
        filtered={false}
      />,
    );
    const swatch = container.querySelector('[data-testid="chart-legend-item"] span');
    expect((swatch as HTMLElement).style.background).toContain('--opt-purple');
  });

  it('a palette paints every band the one hue, tokens only', () => {
    const entries = vault();
    const { container } = render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { palette: 'purple' } })}
        schema={buildSchema(entries)}
        filtered={false}
      />,
    );
    const fills = [...container.querySelectorAll('[data-testid="chart-bar"]')].map((b) =>
      b.getAttribute('fill'),
    );
    expect(new Set(fills).size).toBe(1);
    expect(fills[0]).toContain('--opt-purple');
  });

  it('colorByValue shades by share of the max via color-mix', () => {
    const entries = vault();
    const { container } = render(
      <ChartView
        entries={records(entries)}
        presentation={view({
          chart: { palette: 'purple', colorByValue: true, agg: 'sum', value: 'estimate' },
        })}
        schema={buildSchema(entries)}
        filtered={false}
      />,
    );
    const fills = [...container.querySelectorAll('[data-testid="chart-bar"]')].map((b) =>
      b.getAttribute('fill'),
    );
    expect(fills.some((f) => f?.startsWith('color-mix('))).toBe(true);
  });

  it('a maxed horizontal bar draws its value label inside the bar end', () => {
    // The Todo band sums to exactly its nice ceiling, so its bar spans the
    // whole plot and the outside label would run past the 640 viewBox.
    const entries = [
      vault()[0],
      makeEntry({
        path: 'items/a.md',
        title: 'A',
        type: 'Work item',
        properties: { status: 'todo', estimate: 10000 },
      }),
      makeEntry({
        path: 'items/c.md',
        title: 'C',
        type: 'Work item',
        properties: { status: 'doing', estimate: 2 },
      }),
    ];
    const { container } = render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { horizontal: true, agg: 'sum', value: 'estimate' } })}
        schema={buildSchema(entries)}
        filtered={false}
      />,
    );
    const bar = container.querySelector('[data-testid="chart-bar"][data-label="Todo"]');
    const label = bar?.parentElement?.querySelector('text:last-of-type');
    expect(label?.getAttribute('text-anchor')).toBe('end');
    expect(label?.getAttribute('fill')).toBe('var(--n-0)');
  });

  it('the caption names the deviations: cumulative and sort', () => {
    const entries = vault();
    render(
      <ChartView
        entries={records(entries)}
        presentation={view({
          chart: { agg: 'sum', value: 'estimate', cumulative: true, sort: 'value-desc' },
        })}
        schema={buildSchema(entries)}
        filtered={false}
      />,
    );
    const caption = screen.getByTestId('chart-caption');
    expect(caption.textContent).toContain('cumulative');
    expect(caption.textContent).toContain('biggest first');
  });

  /** computeChart ignores `cumulative` for a donut (a ring of running
   * totals lies), so the caption must not claim one either — even for a
   * hand-edited spec the panel itself would never produce (parseChart
   * allows the key on any kind; the vault, not the panel, is the source of
   * truth). */
  it('a donut never claims cumulative, even when the spec says so', () => {
    const entries = vault();
    render(
      <ChartView
        entries={records(entries)}
        presentation={view({
          chart: { kind: 'donut', agg: 'sum', value: 'estimate', cumulative: true },
        })}
        schema={buildSchema(entries)}
        filtered={false}
      />,
    );
    const caption = screen.getByTestId('chart-caption');
    expect(caption.textContent).not.toContain('cumulative');
  });

  // Every colour must come from the token layer, so the chart follows the
  // theme instead of shipping its own palette.
  it('paints only in tokens — no literal hex anywhere in the svg', () => {
    const entries = vault();
    const { container } = render(
      <ChartView
        filtered={false}
        entries={records(entries)}
        presentation={view()}
        schema={buildSchema(entries)}
      />,
    );
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

/**
 * The second dimension on screen (M44.3): stacked segments, one line per
 * series, and a legend that answers back — rows toggle `hidden`/`hiddenG`
 * through `onChartChange` when a host supplies one, and stay static spans
 * when none does (an embedded dashboard chart).
 */
describe('ChartView stacks, series and the interactive legend (M44.3)', () => {
  it('groupBy renders stacked segments that sum to the band height', () => {
    const entries = stacked();
    const { container } = render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { groupBy: 'priority' } })}
        schema={buildSchema(entries)}
        filtered={false}
      />,
    );
    const segments = [...container.querySelectorAll('[data-testid="chart-bar-segment"]')];
    // Todo splits high+low; Doing holds only high. No whole-band rect remains
    // underneath — the segments ARE the bar.
    expect(segments).toHaveLength(3);
    expect(container.querySelectorAll('[data-testid="chart-bar"]')).toHaveLength(0);
    const heights = (label: string) =>
      segments
        .filter((r) => r.getAttribute('data-label') === label)
        .reduce((sum, r) => sum + Number(r.getAttribute('height')), 0);
    for (const r of segments) expect(Number(r.getAttribute('height'))).toBeGreaterThan(0);
    // Values 2 vs 1 on a linear scale: the stacks keep the same ratio.
    expect(heights('Todo') / heights('Doing')).toBeCloseTo(2, 5);
    // The two Todo segments wear their series' own hues, not one paint.
    const fills = segments
      .filter((r) => r.getAttribute('data-label') === 'Todo')
      .map((r) => r.getAttribute('fill'));
    expect(new Set(fills).size).toBe(2);
    expect(fills).toContain('var(--opt-red)');
  });

  it('horizontal stacked bars run their segments along x', () => {
    const entries = stacked();
    const { container } = render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { horizontal: true, groupBy: 'priority' } })}
        schema={buildSchema(entries)}
        filtered={false}
      />,
    );
    const segments = [...container.querySelectorAll('[data-testid="chart-bar-segment"]')];
    expect(segments).toHaveLength(3);
    const widths = (label: string) =>
      segments
        .filter((r) => r.getAttribute('data-label') === label)
        .reduce((sum, r) => sum + Number(r.getAttribute('width')), 0);
    expect(widths('Todo') / widths('Doing')).toBeCloseTo(2, 5);
  });

  it('a multi-series line draws one path per visible series, strokes distinct', () => {
    const entries = stacked();
    const { container } = render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { kind: 'line', groupBy: 'priority' } })}
        schema={buildSchema(entries)}
        filtered={false}
      />,
    );
    const lines = [...container.querySelectorAll('[data-testid="chart-line"]')];
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((l) => l.getAttribute('stroke'))).size).toBe(2);
  });

  // The stack sum is not the Y extent: a line draws PART values, and against
  // a ceiling built from `data.max` (the band stack) no series could ever
  // reach the top of its own chart.
  it('a multi-series line scales to the tallest part, not the stack sum', () => {
    const entries = stacked();
    const { container } = render(
      <ChartView
        entries={records(entries)}
        presentation={view({
          chart: { kind: 'line', groupBy: 'priority', agg: 'sum', value: 'estimate' },
        })}
        schema={buildSchema(entries)}
        filtered={false}
      />,
    );
    // Parts: Todo high 3 / low 5, Doing high 2. The Todo stack is 8, so a
    // stack ceiling (10) would pin every point to the bottom half; the part
    // ceiling is niceCeiling(5) = 5, and the max part touches the top pad.
    const top = [...container.querySelectorAll('[data-testid="chart-point"]')].find(
      (p) => p.getAttribute('data-value') === '5',
    );
    expect(Number(top?.getAttribute('cy'))).toBe(16);
  });

  // Decision B (M44.3), plain half: a band without the series gets NO point —
  // and no bridge either; the path breaks into one subpath per run of
  // consecutive present bands. Doing has no `low` row.
  it('a band without the series is a gap: no point drawn there', () => {
    const entries = stacked();
    const { container } = render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { kind: 'line', groupBy: 'priority' } })}
        schema={buildSchema(entries)}
        filtered={false}
      />,
    );
    const points = [...container.querySelectorAll('[data-testid="chart-point"]')];
    expect(points.filter((p) => p.getAttribute('data-series') === 'High')).toHaveLength(2);
    expect(points.filter((p) => p.getAttribute('data-series') === 'Low')).toHaveLength(1);
  });

  // A straight connector across the missing band would be an interpolated
  // value nobody measured — the path must break, not bridge.
  it('a missing middle band breaks the path: a gap is a gap, not a bridge', () => {
    const entries = stacked();
    (
      entries[0].properties as unknown as {
        statuses: { id: string; group: string; color: string }[];
      }
    ).statuses.push({ id: 'done', group: 'done', color: 'green' });
    // `low` lives in Todo and Done but not Doing; `high` runs Todo→Doing.
    entries.push(
      makeEntry({
        path: 'items/d.md',
        title: 'D',
        type: 'Work item',
        properties: { status: 'done', priority: 'low', estimate: 1 },
      }),
    );
    const { container } = render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { kind: 'line', groupBy: 'priority' } })}
        schema={buildSchema(entries)}
        filtered={false}
      />,
    );
    const d = (label: string) =>
      container
        .querySelector(`[data-testid="chart-line"][data-series="${label}"]`)
        ?.getAttribute('d');
    expect(d('Low')?.match(/M/g)).toHaveLength(2);
    expect(d('High')?.match(/M/g)).toHaveLength(1);
  });

  // Decision B, cumulative half: the engine's plateau parts make every band
  // hold a point, so the lines are continuous.
  it('under cumulative the plateau parts make every series continuous', () => {
    const entries = stacked();
    const { container } = render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { kind: 'line', groupBy: 'priority', cumulative: true } })}
        schema={buildSchema(entries)}
        filtered={false}
      />,
    );
    const points = [...container.querySelectorAll('[data-testid="chart-point"]')];
    expect(points.filter((p) => p.getAttribute('data-series') === 'Low')).toHaveLength(2);
  });

  // With MULTIPLE series the per-series strokes ARE what is drawn, so the
  // series swatches must show them — the uniform-cortex rule is single-series
  // only (see the no-palette line legend test above).
  it('multi-series legend swatches match the drawn strokes, not cortex', () => {
    const entries = stacked();
    const { container } = render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { kind: 'line', legend: true, groupBy: 'priority' } })}
        schema={buildSchema(entries)}
        filtered={false}
      />,
    );
    const strokes = [...container.querySelectorAll('[data-testid="chart-line"]')].map((l) =>
      l.getAttribute('stroke'),
    );
    const swatches = [
      ...container.querySelectorAll('[data-testid="chart-legend-series"] span.rounded-sm'),
    ].map((s) => (s as HTMLElement).style.background);
    expect(new Set(swatches)).toEqual(new Set(strokes));
  });

  it('legend rows are buttons that toggle the band into hidden', () => {
    const entries = vault();
    const onChartChange = vi.fn();
    render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { legend: true } })}
        schema={buildSchema(entries)}
        filtered={false}
        onChartChange={onChartChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Todo/ }));
    expect(onChartChange).toHaveBeenCalledWith({ legend: true, hidden: ['todo'] });
  });

  it('unhiding drops the key, and an emptied array leaves the spec entirely', () => {
    const entries = vault();
    const onChartChange = vi.fn();
    render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { legend: true, hidden: ['todo'] } })}
        schema={buildSchema(entries)}
        filtered={false}
        onChartChange={onChartChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Todo/ }));
    expect(onChartChange).toHaveBeenCalledWith({ legend: true });
  });

  it('series legend rows toggle hiddenG', () => {
    const entries = stacked();
    const onChartChange = vi.fn();
    render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { legend: true, groupBy: 'priority' } })}
        schema={buildSchema(entries)}
        filtered={false}
        onChartChange={onChartChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /High/ }));
    expect(onChartChange).toHaveBeenCalledWith({
      legend: true,
      groupBy: 'priority',
      hiddenG: ['high'],
    });
  });

  it('a hidden row is struck through, unpressed, and shows its label only', () => {
    const entries = vault();
    render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { legend: true, hidden: ['todo'] } })}
        schema={buildSchema(entries)}
        filtered={false}
        onChartChange={vi.fn()}
      />,
    );
    const rows = screen.getAllByTestId('chart-legend-item');
    const todo = rows.find((r) => r.textContent?.startsWith('Todo'));
    // Its display value is stale by definition — the label alone remains.
    expect(todo?.textContent).toBe('Todo');
    expect(todo?.className).toContain('line-through');
    expect(todo?.className).toContain('text-n-400');
    expect(todo?.querySelector('button')?.getAttribute('aria-pressed')).toBe('false');
    const doing = rows.find((r) => r.textContent?.startsWith('Doing'));
    expect(doing?.textContent).toBe('Doing1');
    expect(doing?.querySelector('button')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('without onChartChange the legend is static — no buttons, as today', () => {
    const entries = vault();
    const { container } = render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { legend: true } })}
        schema={buildSchema(entries)}
        filtered={false}
      />,
    );
    expect(screen.getAllByTestId('chart-legend-item').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  // The all-hidden empty state without a legend would be a dead end: the
  // legend below it is the way back, and it must work.
  it('all-hidden renders the legend below the empty state as the recovery path', () => {
    const entries = vault();
    const onChartChange = vi.fn();
    render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { hidden: ['todo', 'doing'] } })}
        schema={buildSchema(entries)}
        filtered={false}
        onChartChange={onChartChange}
      />,
    );
    expect(screen.getByTestId('chart-empty').getAttribute('data-reason')).toBe('all-hidden');
    expect(screen.getAllByTestId('chart-legend-item')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /Todo/ }));
    expect(onChartChange).toHaveBeenCalledWith({ hidden: ['doing'] });
  });

  // The engine already filtered the hidden slice out of `total`, so the arcs
  // must still close the ring — their lengths sum to the circumference.
  it('a donut with hidden slices still closes its ring', () => {
    const entries = wide();
    const { container } = render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { kind: 'donut', hidden: ['todo'] } })}
        schema={buildSchema(entries)}
        filtered={false}
      />,
    );
    const arcs = [...container.querySelectorAll('[data-testid="chart-arc"]')];
    expect(arcs.length).toBeGreaterThan(0);
    const total = arcs.reduce(
      (sum, a) => sum + Number(a.getAttribute('stroke-dasharray')?.split(' ')[0]),
      0,
    );
    expect(total).toBeCloseTo(2 * Math.PI * 92, 6);
  });

  // Decision C (M44.3): the caption reads "Average of X", but a stacked BAR
  // under groupBy draws each segment as its sub-band's average and the bar as
  // their SUM — the clause names that deviation. Bars only: a multi-series
  // line draws each series' own averages and stacks nothing (the summed value
  // appears nowhere), and a donut ignores groupBy entirely.
  it('the caption says "stacked averages" only where a stack is drawn — avg + groupBy on a bar', () => {
    const entries = stacked();
    const schema = buildSchema(entries);
    render(
      <ChartView
        entries={records(entries)}
        presentation={view({ chart: { agg: 'avg', value: 'estimate', groupBy: 'priority' } })}
        schema={schema}
        filtered={false}
      />,
    );
    expect(screen.getByTestId('chart-caption').textContent).toContain('stacked averages');
    cleanup();
    render(
      <ChartView
        entries={records(entries)}
        presentation={view({
          chart: { kind: 'line', agg: 'avg', value: 'estimate', groupBy: 'priority' },
        })}
        schema={schema}
        filtered={false}
      />,
    );
    expect(screen.getByTestId('chart-caption').textContent).not.toContain('stacked averages');
    cleanup();
    render(
      <ChartView
        entries={records(entries)}
        presentation={view({
          chart: { kind: 'donut', agg: 'avg', value: 'estimate', groupBy: 'priority' },
        })}
        schema={schema}
        filtered={false}
      />,
    );
    expect(screen.getByTestId('chart-caption').textContent).not.toContain('stacked averages');
  });
});

describe('sliceColor', () => {
  const slice = (over: Partial<ChartSlice> = {}): ChartSlice => ({
    key: 'todo',
    label: 'Todo',
    color: null,
    ghost: false,
    count: 1,
    value: 1,
    display: '1',
    hue: 0,
    entries: [],
    ...over,
  });

  it('uses the band’s own colour when it declares one', () => {
    expect(sliceColor(slice({ color: 'blue' }), 0)).toBe('var(--opt-blue)');
  });

  // Grouping by a text property gives every band `color: null`, and a chart
  // drawn in one colour cannot be read at all.
  it('cycles the option palette for bands that declare no colour', () => {
    expect(sliceColor(slice({ key: 'a' }), 0)).toBe('var(--opt-gray)');
    expect(sliceColor(slice({ key: 'b' }), 1)).toBe('var(--opt-brown)');
    expect(sliceColor(slice({ key: 'c' }), 9)).toBe('var(--opt-gray)');
  });

  it('keeps the no-value bucket neutral — an absence is not one more option', () => {
    expect(sliceColor(slice({ key: '__none__', color: 'blue' }), 3)).toBe('var(--n-300)');
  });

  it('falls back to the palette for a colour word nothing recognises', () => {
    // resolveOptionColor answers `default` (neutral grey) for those, and
    // several grey bands are indistinguishable.
    expect(sliceColor(slice({ color: 'chartreuse-ish' }), 4)).toBe('var(--opt-green)');
  });
});
