import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
      <ChartView entries={records(entries)} presentation={view()} schema={buildSchema(entries)} />,
    );
    const bars = screen.getAllByTestId('chart-bar');
    expect(bars.map((b) => b.getAttribute('data-label'))).toEqual(['Todo', 'Doing']);
    expect(bars.map((b) => b.getAttribute('data-value'))).toEqual(['2', '1']);
    expect(screen.getByTestId('chart-view').getAttribute('data-chart-measure')).toBe('Count');
  });

  it('draws a line with a point per band when asked for one', () => {
    const entries = vault();
    render(
      <ChartView
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
        entries={records(entries)}
        presentation={view({ chart: { kind: 'donut' } })}
        schema={buildSchema(entries)}
      />,
    );
    // Two bands hold records; a third declared status would contribute an arc
    // of length zero, which paints a hairline at twelve o'clock.
    expect(screen.getAllByTestId('chart-arc')).toHaveLength(2);
    expect(screen.getAllByTestId('chart-legend-item')).toHaveLength(2);
  });

  it('sums a numeric property when the measure says so', () => {
    const entries = vault();
    render(
      <ChartView
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
      <ChartView entries={records(entries)} presentation={view({ group: [] })} schema={schema} />,
    );
    expect(screen.getByTestId('chart-empty').getAttribute('data-reason')).toBe('no-group');
    expect(screen.getByText(/under Group in view settings/)).toBeTruthy();
    unmount();

    render(
      <ChartView
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

  // Every colour must come from the token layer, so the chart follows the
  // theme instead of shipping its own palette.
  it('paints only in tokens — no literal hex anywhere in the svg', () => {
    const entries = vault();
    const { container } = render(
      <ChartView entries={records(entries)} presentation={view()} schema={buildSchema(entries)} />,
    );
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
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
