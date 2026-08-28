import { describe, expect, it } from 'vitest';
import { computeChart, measureLabel, niceCeiling } from '@/engine/chart';
import { aggregateNumbers, computeRollup } from '@/engine/properties';
import { buildSchema } from '@/engine/schema';
import { makeEntry } from '@/test/factories';
import type { Entry, Presentation } from '@/engine/types';

/**
 * The chart engine (M16.27; the axis decoupled in M44.3).
 *
 * Two rules it exists to keep. Its X axis is `chart.xField` when set, and the
 * view's grouping chain's first band otherwise — so a saved board re-opened as
 * a chart still charts what the board was banded by, declared option order and
 * all. And its arithmetic is `aggregateNumbers`, the same function a rollup
 * column runs, so the bar and the number in the table beside it cannot
 * disagree.
 */

const vault = (): Entry[] => [
  makeEntry({
    path: 'types/work-item.md',
    title: 'Work item',
    type: 'Type',
    properties: {
      fields: {
        status: { kind: 'status' },
        priority: {
          kind: 'select',
          options: [
            { id: 'high', color: 'red' },
            { id: 'low', color: 'gray' },
          ],
        },
        estimate: { kind: 'number' },
        cost: { kind: 'number', format: 'currency', precision: 0 },
        note: { kind: 'text' },
      },
      statuses: [
        { id: 'todo', group: 'active', color: 'blue' },
        { id: 'doing', group: 'active', color: 'orange' },
        { id: 'done', group: 'done', color: 'green' },
      ],
    } as unknown as Entry['properties'],
  }),
  makeEntry({
    path: 'items/a.md',
    title: 'A',
    type: 'Work item',
    properties: { status: 'todo', priority: 'high', estimate: 3, cost: 1200, note: 'x' },
  }),
  makeEntry({
    path: 'items/b.md',
    title: 'B',
    type: 'Work item',
    properties: { status: 'todo', priority: 'low', estimate: 5, cost: 800, note: 'y' },
  }),
  makeEntry({
    path: 'items/c.md',
    title: 'C',
    type: 'Work item',
    properties: { status: 'doing', priority: 'high', estimate: 2, cost: 300 },
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

describe('computeChart', () => {
  it('counts records per band, in the type’s declared status order', () => {
    const entries = vault();
    const data = computeChart(records(entries), view(), buildSchema(entries));
    expect(data.blocked).toBeNull();
    expect(data.slices.map((s) => [s.label, s.value])).toEqual([
      ['Todo', 2],
      ['Doing', 1],
      // A declared status with no records is still a band — the board shows
      // that column, and the chart must agree with the board.
      ['Done', 0],
    ]);
    expect(data.total).toBe(3);
    expect(data.max).toBe(2);
    expect(data.measure).toBe('Count');
    expect(data.axis).toBe('Status');
  });

  it('carries each band’s declared colour through, so the chart matches the board', () => {
    const entries = vault();
    const data = computeChart(records(entries), view(), buildSchema(entries));
    expect(data.slices.map((s) => s.color)).toEqual(['blue', 'orange', 'green']);
  });

  it('sums and averages a numeric property', () => {
    const entries = vault();
    const schema = buildSchema(entries);
    const sum = computeChart(
      records(entries),
      view({ chart: { agg: 'sum', value: 'estimate' } }),
      schema,
    );
    expect(sum.slices.map((s) => s.value)).toEqual([8, 2, 0]);
    expect(sum.measure).toBe('Sum of Estimate');

    const avg = computeChart(
      records(entries),
      view({ chart: { agg: 'avg', value: 'estimate' } }),
      schema,
    );
    expect(avg.slices.map((s) => s.value)).toEqual([4, 2, 0]);
  });

  // The reason the arithmetic is shared rather than copied: frontmatter hands
  // back quoted numbers, and a chart that used `typeof v === 'number'` would
  // silently read them as no data at all.
  it('reads a quoted number the same way a rollup does', () => {
    const entries = [
      ...vault(),
      makeEntry({
        path: 'items/d.md',
        title: 'D',
        type: 'Work item',
        properties: { status: 'doing', estimate: '4' },
      }),
    ];
    const data = computeChart(
      records(entries),
      view({ chart: { agg: 'sum', value: 'estimate' } }),
      buildSchema(entries),
    );
    expect(data.slices.find((s) => s.label === 'Doing')?.value).toBe(6);
  });

  it('formats a measured value through the property’s own number format', () => {
    const entries = vault();
    const data = computeChart(
      records(entries),
      view({ chart: { agg: 'sum', value: 'cost' } }),
      buildSchema(entries),
    );
    // `cost` is declared as currency: a chart printing a bare 2000 beside a
    // table printing $2,000 would look like two different numbers.
    expect(data.slices[0].display).toBe('$2,000');
  });

  it('drops zero bands when asked, and keeps them otherwise', () => {
    const entries = vault();
    const schema = buildSchema(entries);
    expect(computeChart(records(entries), view(), schema).slices).toHaveLength(3);
    expect(
      computeChart(records(entries), view({ chart: { omitZero: true } }), schema).slices,
    ).toHaveLength(2);
  });

  it('honours the grouping level’s own direction, like every other layout', () => {
    const entries = vault();
    const data = computeChart(
      records(entries),
      view({ group: [{ field: 'status', dir: 'desc' }] }),
      buildSchema(entries),
    );
    expect(data.slices.map((s) => s.label)).toEqual(['Done', 'Doing', 'Todo']);
  });

  it('charts only the FIRST band level — a chart has one X axis', () => {
    const entries = vault();
    const data = computeChart(
      records(entries),
      view({ group: [{ field: 'status' }, { field: 'note' }] }),
      buildSchema(entries),
    );
    expect(data.slices.map((s) => s.label)).toEqual(['Todo', 'Doing', 'Done']);
  });

  it('xField overrides the view grouping as the axis (M44.3)', () => {
    const entries = vault();
    const data = computeChart(
      records(entries),
      view({ group: [{ field: 'status' }], chart: { xField: 'priority' } }),
      buildSchema(entries),
    );
    expect(data.blocked).toBeNull();
    expect(data.axis).toBe('Priority');
    expect(data.slices.map((s) => [s.label, s.value])).toEqual([
      ['High', 2],
      ['Low', 1],
    ]);
  });

  it('absent xField keeps the grouping-derived axis — zero migration', () => {
    const entries = vault();
    const data = computeChart(
      records(entries),
      view({ chart: { kind: 'bar' } }),
      buildSchema(entries),
    );
    expect(data.axis).toBe('Status');
    expect(data.slices.map((s) => s.label)).toEqual(['Todo', 'Doing', 'Done']);
  });

  it('xField with no grouping at all still draws', () => {
    const entries = vault();
    const data = computeChart(
      records(entries),
      view({ group: [], chart: { xField: 'status' } }),
      buildSchema(entries),
    );
    expect(data.blocked).toBeNull();
    expect(data.axis).toBe('Status');
    expect(data.slices.map((s) => s.value)).toEqual([2, 1, 0]);
  });

  it('a number chart totals every row and needs no grouping', () => {
    const entries = vault();
    const data = computeChart(
      records(entries),
      view({ group: [], chart: { kind: 'number' } }),
      buildSchema(entries),
    );
    expect(data.blocked).toBeNull();
    expect(data.total).toBe(3);
    expect(data.totalDisplay).toBe('3');
    expect(data.slices).toEqual([]);
  });

  it('a number chart still refuses when the measure has no property', () => {
    const entries = vault();
    const data = computeChart(
      records(entries),
      view({ group: [], chart: { kind: 'number', agg: 'sum' } }),
      buildSchema(entries),
    );
    expect(data.blocked).toBe('no-value-field');
  });

  it('a number chart formats its total with the field def', () => {
    const entries = vault();
    const data = computeChart(
      records(entries),
      view({ group: [], chart: { kind: 'number', agg: 'sum', value: 'cost' } }),
      buildSchema(entries),
    );
    expect(data.totalDisplay).toMatch(/^\$/);
  });

  // The fixture's declared status order (todo, doing, done) already sums to
  // [8, 2, 0] — descending by coincidence. Asserting exact labels here, next
  // to the value-asc twin below that reverses them, gives a broken comparator
  // somewhere to fail: value-desc alone would pass even with `sort` ignored.
  it('sorts bands by value when asked, biggest first', () => {
    const entries = vault();
    const data = computeChart(
      records(entries),
      view({ chart: { agg: 'sum', value: 'estimate', sort: 'value-desc' } }),
      buildSchema(entries),
    );
    expect(data.slices.map((s) => s.label)).toEqual(['Todo', 'Doing', 'Done']);
    expect(data.slices.map((s) => s.value)).toEqual([8, 2, 0]);
  });

  it('sorts bands by value ascending when asked, reversing the coincidental order', () => {
    const entries = vault();
    const data = computeChart(
      records(entries),
      view({ chart: { agg: 'sum', value: 'estimate', sort: 'value-asc' } }),
      buildSchema(entries),
    );
    expect(data.slices.map((s) => s.label)).toEqual(['Done', 'Doing', 'Todo']);
    expect(data.slices.map((s) => s.value)).toEqual([0, 2, 8]);
  });

  it('sorts bands A→Z when asked', () => {
    const entries = vault();
    const data = computeChart(
      records(entries),
      view({ chart: { sort: 'label' } }),
      buildSchema(entries),
    );
    const labels = data.slices.map((s) => s.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  it('cumulative bands carry a running total and max becomes the last band', () => {
    const entries = vault();
    const plain = computeChart(
      records(entries),
      view({ chart: { agg: 'sum', value: 'estimate' } }),
      buildSchema(entries),
    );
    const data = computeChart(
      records(entries),
      view({ chart: { agg: 'sum', value: 'estimate', cumulative: true } }),
      buildSchema(entries),
    );
    expect(data.slices.at(-1)?.value).toBe(plain.total);
    expect(data.max).toBe(plain.total);
    expect(data.total).toBe(plain.total); // total stays the real sum, not a double-count
  });

  it('cumulative is ignored for donuts — a ring of running totals lies', () => {
    const entries = vault();
    const donut = computeChart(
      records(entries),
      view({ chart: { kind: 'donut', agg: 'sum', value: 'estimate', cumulative: true } }),
      buildSchema(entries),
    );
    const plain = computeChart(
      records(entries),
      view({ chart: { kind: 'donut', agg: 'sum', value: 'estimate' } }),
      buildSchema(entries),
    );
    expect(donut.slices.map((s) => s.value)).toEqual(plain.slices.map((s) => s.value));
  });
});

/**
 * The second dimension and the interactive legend (M44.3). `groupBy` splits
 * each band into parts; `hidden`/`hiddenG` filter INSIDE the engine so totals,
 * max, and the ring reflect the visible set, while `bands`/`series` carry the
 * full roster — with hue indices stamped BEFORE filtering, because hiding a
 * band must not repaint its neighbours.
 */
describe('computeChart stacks and hides (M44.3)', () => {
  it('groupBy splits each band into parts that sum to the band value', () => {
    const entries = vault();
    const data = computeChart(
      records(entries),
      view({ chart: { xField: 'status', groupBy: 'priority' } }),
      buildSchema(entries),
    );
    expect(data.blocked).toBeNull();
    const todo = data.slices.find((s) => s.key === 'todo');
    expect(todo?.parts?.map((p) => [p.label, p.value, p.count])).toEqual([
      ['High', 1, 1],
      ['Low', 1, 1],
    ]);
    expect(todo?.parts?.reduce((sum, p) => sum + p.value, 0)).toBe(todo?.value);
    // Parts carry the sub-band's declared colour and its series hue.
    expect(todo?.parts?.map((p) => [p.key, p.color, p.hue])).toEqual([
      ['high', 'red', 0],
      ['low', 'gray', 1],
    ]);
    // A band with rows in only one sub-band carries only that part.
    const doing = data.slices.find((s) => s.key === 'doing');
    expect(doing?.parts?.map((p) => [p.key, p.value])).toEqual([['high', 1]]);
  });

  it('groupBy parts run the same aggregation arithmetic as the bands', () => {
    const entries = vault();
    const data = computeChart(
      records(entries),
      view({ chart: { xField: 'status', groupBy: 'priority', agg: 'sum', value: 'estimate' } }),
      buildSchema(entries),
    );
    const todo = data.slices.find((s) => s.key === 'todo');
    expect(todo?.parts?.map((p) => [p.key, p.value])).toEqual([
      ['high', 3],
      ['low', 5],
    ]);
    expect(todo?.value).toBe(8);
  });

  it('lists the series roster in declared order with stable hues', () => {
    const entries = vault();
    const data = computeChart(
      records(entries),
      view({ chart: { xField: 'status', groupBy: 'priority' } }),
      buildSchema(entries),
    );
    expect(data.series.map((s) => [s.key, s.label, s.color, s.hue, s.hidden])).toEqual([
      ['high', 'High', 'red', 0, false],
      ['low', 'Low', 'gray', 1, false],
    ]);
  });

  it('bands mirrors the slices and series stays empty without groupBy or hidden', () => {
    const entries = vault();
    const data = computeChart(records(entries), view(), buildSchema(entries));
    expect(data.bands.map((b) => [b.key, b.hue, b.hidden])).toEqual([
      ['todo', 0, false],
      ['doing', 1, false],
      ['done', 2, false],
    ]);
    expect(data.series).toEqual([]);
    expect(data.slices.map((s) => s.hue)).toEqual([0, 1, 2]);
    expect(data.slices.every((s) => s.parts === undefined)).toBe(true);
  });

  it('a donut ignores groupBy — a stacked ring reads as nothing', () => {
    const entries = vault();
    const data = computeChart(
      records(entries),
      view({ chart: { kind: 'donut', xField: 'status', groupBy: 'priority' } }),
      buildSchema(entries),
    );
    expect(data.blocked).toBeNull();
    expect(data.slices.every((s) => s.parts === undefined)).toBe(true);
    expect(data.series).toEqual([]);
  });

  it('a number chart ignores groupBy — it has no bands to split', () => {
    const entries = vault();
    const data = computeChart(
      records(entries),
      view({ group: [], chart: { kind: 'number', groupBy: 'priority' } }),
      buildSchema(entries),
    );
    expect(data.blocked).toBeNull();
    expect(data.series).toEqual([]);
    expect(data.bands).toEqual([]);
  });

  it('a hidden band leaves the slices but stays in the roster, and the totals shrink', () => {
    const entries = vault();
    const data = computeChart(
      records(entries),
      view({ chart: { hidden: ['todo'] } }),
      buildSchema(entries),
    );
    expect(data.blocked).toBeNull();
    expect(data.slices.map((s) => s.key)).toEqual(['doing', 'done']);
    expect(data.bands.map((b) => [b.key, b.hidden])).toEqual([
      ['todo', true],
      ['doing', false],
      ['done', false],
    ]);
    // Visible arithmetic: the two hidden rows are gone from total and max.
    expect(data.total).toBe(1);
    expect(data.max).toBe(1);
    // Hue is the PRE-filter index — hiding Todo must not repaint Doing.
    expect(data.slices.find((s) => s.key === 'doing')?.hue).toBe(1);
    expect(data.bands.find((b) => b.key === 'doing')?.hue).toBe(1);
  });

  it('a hidden series filters the parts, and the band value follows the visible stack', () => {
    const entries = vault();
    const data = computeChart(
      records(entries),
      view({ chart: { xField: 'status', groupBy: 'priority', hiddenG: ['low'] } }),
      buildSchema(entries),
    );
    const todo = data.slices.find((s) => s.key === 'todo');
    expect(todo?.parts?.map((p) => [p.key, p.hue])).toEqual([['high', 0]]);
    // The stack and the total agree: the band draws only what is visible…
    expect(todo?.value).toBe(1);
    expect(data.total).toBe(2);
    // …while count stays the band's true row count, the drilldown's number.
    expect(todo?.count).toBe(2);
    expect(data.series.map((s) => [s.key, s.hidden])).toEqual([
      ['high', false],
      ['low', true],
    ]);
  });

  it('hiding a series keeps the survivor’s hue — the legend must not repaint', () => {
    const entries = vault();
    const data = computeChart(
      records(entries),
      view({ chart: { xField: 'status', groupBy: 'priority', hiddenG: ['high'] } }),
      buildSchema(entries),
    );
    const todo = data.slices.find((s) => s.key === 'todo');
    expect(todo?.parts?.map((p) => [p.key, p.hue])).toEqual([['low', 1]]);
  });

  it('hiding every band is its own blocked state, and the roster survives it', () => {
    const entries = vault();
    const data = computeChart(
      records(entries),
      view({ chart: { hidden: ['todo', 'doing', 'done'] } }),
      buildSchema(entries),
    );
    // "You hid it all" is not "no rows" — the empty state must name the
    // legend, and the legend needs the roster to offer a way back.
    expect(data.blocked).toBe('all-hidden');
    expect(data.slices).toEqual([]);
    expect(data.bands.map((b) => [b.key, b.hidden])).toEqual([
      ['todo', true],
      ['doing', true],
      ['done', true],
    ]);
  });

  it('cumulative runs over the visible bands only', () => {
    const entries = vault();
    const data = computeChart(
      records(entries),
      view({ chart: { agg: 'sum', value: 'estimate', cumulative: true, hidden: ['todo'] } }),
      buildSchema(entries),
    );
    // Todo (8) is hidden: the running total is Doing (2), then Done (2 + 0).
    expect(data.slices.map((s) => [s.key, s.value])).toEqual([
      ['doing', 2],
      ['done', 2],
    ]);
    expect(data.total).toBe(2);
    expect(data.max).toBe(2);
  });
});

/**
 * Every reason a chart cannot draw becomes a sentence naming the control that
 * fixes it. A blank canvas cannot tell "no records" from "you have not chosen
 * what to measure", and both were possible here.
 */
describe('computeChart refuses to draw a misleading chart', () => {
  it('reports no grouping rather than inventing an axis', () => {
    const entries = vault();
    const data = computeChart(records(entries), view({ group: [] }), buildSchema(entries));
    expect(data.blocked).toBe('no-group');
    expect(data.slices).toEqual([]);
  });

  it('reports no records', () => {
    const entries = vault();
    expect(computeChart([], view(), buildSchema(entries)).blocked).toBe('no-rows');
  });

  it('reports a sum with nothing chosen to sum', () => {
    const entries = vault();
    const data = computeChart(
      records(entries),
      view({ chart: { agg: 'sum' } }),
      buildSchema(entries),
    );
    expect(data.blocked).toBe('no-value-field');
  });

  // The dangerous one: a chart of zeroes looks like a real answer that says
  // "this property is zero everywhere".
  it('reports a property that holds no numbers at all', () => {
    const entries = vault();
    const data = computeChart(
      records(entries),
      view({ chart: { agg: 'sum', value: 'note' } }),
      buildSchema(entries),
    );
    expect(data.blocked).toBe('no-numbers');
  });

  it('still charts when only some bands hold numbers', () => {
    const entries = [
      ...vault(),
      makeEntry({
        path: 'items/e.md',
        title: 'E',
        type: 'Work item',
        properties: { status: 'done' },
      }),
    ];
    const data = computeChart(
      records(entries),
      view({ chart: { agg: 'sum', value: 'estimate' } }),
      buildSchema(entries),
    );
    expect(data.blocked).toBeNull();
    expect(data.slices.find((s) => s.label === 'Done')?.value).toBe(0);
  });
});

describe('measureLabel', () => {
  it('names the Y axis in words', () => {
    expect(measureLabel(undefined)).toBe('Count');
    expect(measureLabel({ agg: 'sum', value: 'story_points' })).toBe('Sum of Story points');
    expect(measureLabel({ agg: 'avg', value: 'estimate' })).toBe('Average of Estimate');
  });

  it('does not claim a property when none is chosen yet', () => {
    expect(measureLabel({ agg: 'sum' })).toBe('Sum');
  });
});

describe('niceCeiling', () => {
  // Straight off the data the axis reads 8.3333 / 16.667 / 25 and the tallest
  // bar touches the frame.
  it('rounds the axis top up to a readable number', () => {
    expect(niceCeiling(7)).toBe(10);
    expect(niceCeiling(12)).toBe(20);
    expect(niceCeiling(23)).toBe(50);
    expect(niceCeiling(1)).toBe(1);
    expect(niceCeiling(0.3)).toBe(0.5);
  });

  it('never returns zero, which would divide the whole scale by nothing', () => {
    expect(niceCeiling(0)).toBe(1);
    expect(niceCeiling(-4)).toBe(1);
    expect(niceCeiling(Number.NaN)).toBe(1);
  });
});

/**
 * The extraction itself (M16.27): `computeRollup` used to hold this arithmetic
 * inline. These pin that sharing it changed nothing about what a rollup says —
 * including the one asymmetry, where a sum of nothing-numeric reports 0 and
 * the other three report ''.
 */
describe('aggregateNumbers', () => {
  it('reduces a list of values, coercing numeric strings', () => {
    expect(aggregateNumbers([1, '2', 3], 'sum')).toBe(6);
    expect(aggregateNumbers([1, 2], 'avg')).toBe(1.5);
    expect(aggregateNumbers([4, 1, 9], 'min')).toBe(1);
    expect(aggregateNumbers([4, 1, 9], 'max')).toBe(9);
  });

  it('rounds an average to two places, as the rollup column always has', () => {
    expect(aggregateNumbers([1, 1, 2], 'avg')).toBe(1.33);
  });

  it('returns null when nothing in the list is a number', () => {
    expect(aggregateNumbers(['a', 'b'], 'sum')).toBeNull();
    expect(aggregateNumbers([], 'avg')).toBeNull();
  });

  it('leaves computeRollup saying exactly what it said before', () => {
    const entries = [
      makeEntry({
        path: 'types/objective.md',
        title: 'Objective',
        type: 'Type',
        properties: {
          fields: { total: { kind: 'rollup', relation: 'results', property: 'score' } },
        } as unknown as Entry['properties'],
      }),
      makeEntry({
        path: 'kr/1.md',
        title: 'KR1',
        type: 'Result',
        properties: { score: 4, label: 'a' },
      }),
      makeEntry({
        path: 'kr/2.md',
        title: 'KR2',
        type: 'Result',
        properties: { score: 'nope', label: 'b' },
      }),
      makeEntry({
        path: 'obj/o.md',
        title: 'O',
        type: 'Objective',
        relationships: { results: ['1', '2'] },
      }),
    ];
    const owner = entries[3];
    const def = { name: 'total', kind: 'rollup' as const, relation: 'results', property: 'score' };
    expect(computeRollup(owner, { ...def, calculate: 'sum' }, entries)).toBe('4');
    expect(computeRollup(owner, { ...def, calculate: 'avg' }, entries)).toBe('4');
    // Sum of nothing-numeric is '0'; the others are ''. Preserved, not fixed.
    const noneNumeric = { ...def, property: 'label' };
    expect(computeRollup(owner, { ...noneNumeric, calculate: 'sum' }, entries)).toBe('0');
    expect(computeRollup(owner, { ...noneNumeric, calculate: 'max' }, entries)).toBe('');
  });
});
