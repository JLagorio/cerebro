import { describe, expect, it } from 'vitest';
import {
  addWidget,
  dashboardNumber,
  duplicateWidget,
  moveToEnd,
  moveToOwnRow,
  moveWidget,
  moveWithinRow,
  removeWidget,
  setRowHeight,
  setWidgetWeight,
  updateWidget,
  widgetCount,
  widgetEntries,
} from '@/engine/dashboard';
import { buildSchema } from '@/engine/schema';
import { ROW_HEIGHT_MAX, ROW_HEIGHT_MIN } from '@/engine/types';
import { makeEntry } from '@/test/factories';
import type { DashboardSpec, DashboardWidget, Entry, FilterRule } from '@/engine/types';

/**
 * The dashboard's number block (M16.28).
 *
 * It measures the DASHBOARD'S OWN rows, which is what makes the view's filters
 * mean something on a dashboard. And it runs `aggregateNumbers` — the chart's
 * and the rollup column's arithmetic — so three surfaces cannot quote three
 * figures for one property.
 */

const vault = (): Entry[] => [
  makeEntry({
    path: 'types/work-item.md',
    title: 'Work item',
    type: 'Type',
    properties: {
      fields: {
        estimate: { kind: 'number' },
        cost: { kind: 'number', format: 'currency', precision: 0 },
        note: { kind: 'text' },
      },
    } as unknown as Entry['properties'],
  }),
  makeEntry({
    path: 'items/a.md',
    title: 'A',
    type: 'Work item',
    properties: { estimate: 3, cost: 1200, note: 'x' },
  }),
  makeEntry({
    path: 'items/b.md',
    title: 'B',
    type: 'Work item',
    properties: { estimate: 5, cost: 800 },
  }),
  makeEntry({ path: 'items/c.md', title: 'C', type: 'Work item', properties: {} }),
];

const records = (entries: Entry[]) => entries.filter((e) => e.path.startsWith('items/'));

const numberBlock = (
  over: Partial<Extract<DashboardWidget, { kind: 'number' }>> = {},
): Extract<DashboardWidget, { kind: 'number' }> => ({
  id: 'block-1',
  kind: 'number',
  agg: 'count',
  ...over,
});

describe('dashboardNumber', () => {
  it('counts the rows it was handed — the view’s filters are what scope it', () => {
    const entries = vault();
    const all = dashboardNumber(records(entries), numberBlock(), buildSchema(entries));
    expect(all.value).toBe(3);
    expect(all.label).toBe('Records');

    const filtered = dashboardNumber(
      records(entries).slice(0, 1),
      numberBlock(),
      buildSchema(entries),
    );
    expect(filtered.value).toBe(1);
  });

  it('sums and averages, counting only the records that hold a value', () => {
    const entries = vault();
    const schema = buildSchema(entries);
    const sum = dashboardNumber(
      records(entries),
      numberBlock({ agg: 'sum', value: 'estimate' }),
      schema,
    );
    expect(sum.value).toBe(8);
    expect(sum.label).toBe('Sum of Estimate');
    // Three records are in view, two of them hold an estimate — the subtitle
    // must say two, or the tile claims an average over records it skipped.
    expect(sum.count).toBe(2);

    const avg = dashboardNumber(
      records(entries),
      numberBlock({ agg: 'avg', value: 'estimate' }),
      schema,
    );
    expect(avg.value).toBe(4);
  });

  it('keeps the property’s own number format', () => {
    const entries = vault();
    const tile = dashboardNumber(
      records(entries),
      numberBlock({ agg: 'sum', value: 'cost' }),
      buildSchema(entries),
    );
    expect(tile.display).toBe('$2,000');
  });

  it('takes a title from the block when it has one', () => {
    const entries = vault();
    const tile = dashboardNumber(
      records(entries),
      numberBlock({ title: 'Open work' }),
      buildSchema(entries),
    );
    expect(tile.label).toBe('Open work');
  });

  // A tile reading 0 is a claim about the data. Both of these would make one
  // that is not true.
  it('shows a dash, not a zero, when there is nothing to measure', () => {
    const entries = vault();
    const schema = buildSchema(entries);
    const unconfigured = dashboardNumber(records(entries), numberBlock({ agg: 'sum' }), schema);
    expect(unconfigured.blocked).toBe('no-value-field');
    expect(unconfigured.display).toBe('—');

    const nonNumeric = dashboardNumber(
      records(entries),
      numberBlock({ agg: 'sum', value: 'note' }),
      schema,
    );
    expect(nonNumeric.blocked).toBe('no-numbers');
    expect(nonNumeric.display).toBe('—');
  });

  it('counts zero honestly — no records IS the answer to a count', () => {
    const entries = vault();
    const tile = dashboardNumber([], numberBlock(), buildSchema(entries));
    expect(tile.value).toBe(0);
    expect(tile.display).toBe('0');
    expect(tile.blocked).toBeNull();
  });
});

// --- widgetEntries (M44.4) --------------------------------------------------

const filterFixture = (): Entry[] => [
  makeEntry({
    path: 'items/a.md',
    title: 'A',
    type: 'Work item',
    properties: { status: 'doing', priority: 'high' },
  }),
  makeEntry({
    path: 'items/b.md',
    title: 'B',
    type: 'Work item',
    properties: { status: 'doing', priority: 'low' },
  }),
  makeEntry({
    path: 'items/c.md',
    title: 'C',
    type: 'Work item',
    properties: { status: 'done', priority: 'high' },
  }),
];

describe('widgetEntries (M44.4)', () => {
  it('layers global then widget filter, AND semantics', () => {
    const entries = filterFixture();
    const schema = buildSchema(entries);
    const spec: DashboardSpec = {
      rows: [],
      global: { all: [{ field: 'priority', op: 'not_equals', value: 'low' }] },
    };
    const widget: DashboardWidget = {
      id: 'a',
      kind: 'table',
      filter: { all: [{ field: 'status', op: 'equals', value: 'doing' }] },
    };
    const out = widgetEntries(entries, spec, widget, schema);
    // Only 'a' clears both layers — 'b' fails the global (priority low), 'c'
    // fails the widget filter (status done).
    expect(out.map((e) => e.path)).toEqual(['items/a.md']);
    expect(
      out.every((e) => e.properties.status === 'doing' && e.properties.priority !== 'low'),
    ).toBe(true);
  });

  it('no filters at all means the entries pass through untouched — same reference', () => {
    const entries = filterFixture();
    const schema = buildSchema(entries);
    const spec: DashboardSpec = { rows: [] };
    const widget: DashboardWidget = { id: 'a', kind: 'table' };
    expect(widgetEntries(entries, spec, widget, schema)).toBe(entries);
  });
});

// --- dashboard structure editors (M44.4) ------------------------------------

const wid = (id: string): DashboardWidget => ({ id, kind: 'table' });

const twoRowSpec = (): DashboardSpec => ({
  rows: [
    { id: 'r1', widgets: [wid('a'), wid('b')] },
    { id: 'r2', widgets: [wid('c')] },
  ],
});

const fullRowSpec = (): DashboardSpec => ({
  rows: [
    { id: 'r1', widgets: [wid('a'), wid('b'), wid('d'), wid('e')] },
    { id: 'r2', widgets: [wid('c')] },
  ],
});

const twelveWidgetSpec = (): DashboardSpec => ({
  rows: [
    { id: 'r1', widgets: ['a1', 'a2', 'a3', 'a4'].map(wid) },
    { id: 'r2', widgets: ['b1', 'b2', 'b3', 'b4'].map(wid) },
    { id: 'r3', widgets: ['c1', 'c2', 'c3', 'c4'].map(wid) },
  ],
});

// A third, untouched row — what proves an edit rebuilds only the row(s) it
// actually changes rather than every row in the spec.
const threeRowSpec = (): DashboardSpec => ({
  rows: [
    { id: 'r1', widgets: [wid('a'), wid('b')] },
    { id: 'r2', widgets: [wid('c')] },
    { id: 'r3', widgets: [wid('d')] },
  ],
});

describe('dashboard structure editors (M44.4)', () => {
  it('widgetCount sums every row', () => {
    expect(widgetCount(twoRowSpec())).toBe(3);
  });

  it('moveWidget crosses rows and drops the row it empties', () => {
    const next = moveWidget(twoRowSpec(), 'c', 'r1', 1);
    expect(next.ok && next.spec.rows.map((r) => r.widgets.map((w) => w.id))).toEqual([
      ['a', 'c', 'b'],
    ]);
  });

  it('moveWidget into a full row refuses with the rule named', () => {
    const next = moveWidget(fullRowSpec(), 'c', 'r1', 0);
    expect(next).toEqual({ ok: false, reason: 'A row holds at most four widgets' });
  });

  it('a move within a full row succeeds — the cap counts without the moving widget', () => {
    const next = moveWidget(fullRowSpec(), 'a', 'r1', 3);
    expect(next.ok && next.spec.rows[0].widgets.map((w) => w.id)).toEqual(['b', 'd', 'e', 'a']);
  });

  it('moveWidget onto an unknown row is a no-op — same spec reference', () => {
    const spec = twoRowSpec();
    const next = moveWidget(spec, 'a', 'ghost-row', 0);
    expect(next.ok && next.spec).toBe(spec);
  });

  it('moveWidget rebuilds only the source and target rows — a third row keeps its reference', () => {
    const spec = threeRowSpec();
    // 'a' moves from r1 into r2; neither move empties a row, so the rows
    // stay aligned by index and r3 is untouched by either rebuilt row.
    const next = moveWidget(spec, 'a', 'r2', 0);
    expect(next.ok && next.spec.rows[0].widgets.map((w) => w.id)).toEqual(['b']);
    expect(next.ok && next.spec.rows[1].widgets.map((w) => w.id)).toEqual(['a', 'c']);
    expect(next.ok && next.spec.rows[2]).toBe(spec.rows[2]);
  });

  it('addWidget refuses a thirteenth widget with the rule named', () => {
    const next = addWidget(twelveWidgetSpec(), 'r1', wid('n'));
    expect(next).toEqual({ ok: false, reason: 'A dashboard holds at most twelve widgets' });
  });

  it('addWidget appends to a fresh row when the target names none', () => {
    const next = addWidget(twoRowSpec(), 'new-row', wid('n'));
    expect(next.ok && next.spec.rows.map((r) => r.widgets.map((w) => w.id))).toEqual([
      ['a', 'b'],
      ['c'],
      ['n'],
    ]);
  });

  it('removeWidget drops a row it empties', () => {
    const next = removeWidget(twoRowSpec(), 'c');
    expect(next.ok && next.spec.rows.map((r) => r.widgets.map((w) => w.id))).toEqual([['a', 'b']]);
  });

  it('removeWidget is a no-op — same spec reference — when the id is not found', () => {
    const spec = twoRowSpec();
    const next = removeWidget(spec, 'ghost');
    expect(next.ok && next.spec).toBe(spec);
  });

  it('removeWidget rebuilds only the row it touched — untouched rows keep their reference', () => {
    const spec = threeRowSpec();
    const next = removeWidget(spec, 'a');
    // r1 loses 'a' but keeps 'b', so it survives (rebuilt); r2 and r3 never
    // held 'a' and must come back as the exact same objects.
    expect(next.ok && next.spec.rows[0].widgets.map((w) => w.id)).toEqual(['b']);
    expect(next.ok && next.spec.rows[1]).toBe(spec.rows[1]);
    expect(next.ok && next.spec.rows[2]).toBe(spec.rows[2]);
  });

  it('moveToOwnRow splices a new row after the source row', () => {
    const next = moveToOwnRow(twoRowSpec(), 'b');
    expect(next.ok && next.spec.rows.map((r) => r.widgets.map((w) => w.id))).toEqual([
      ['a'],
      ['b'],
      ['c'],
    ]);
  });

  it('moveToEnd puts the widget onto a fresh trailing row', () => {
    const next = moveToEnd(twoRowSpec(), 'a');
    expect(next.ok && next.spec.rows.map((r) => r.widgets.map((w) => w.id))).toEqual([
      ['b'],
      ['c'],
      ['a'],
    ]);
  });

  it('moveToEnd rebuilds only the source row — untouched rows keep their reference', () => {
    const spec = threeRowSpec();
    const next = moveToEnd(spec, 'a');
    expect(next.ok && next.spec.rows.map((r) => r.widgets.map((w) => w.id))).toEqual([
      ['b'],
      ['c'],
      ['d'],
      ['a'],
    ]);
    expect(next.ok && next.spec.rows[1]).toBe(spec.rows[1]);
    expect(next.ok && next.spec.rows[2]).toBe(spec.rows[2]);
  });

  it('moveWithinRow shifts left/right, clamped at the row ends', () => {
    const right = moveWithinRow(twoRowSpec(), 'a', 1);
    expect(right.ok && right.spec.rows[0].widgets.map((w) => w.id)).toEqual(['b', 'a']);
    const clamped = moveWithinRow(twoRowSpec(), 'a', -5);
    expect(clamped.ok && clamped.spec.rows[0].widgets.map((w) => w.id)).toEqual(['a', 'b']);
  });

  it('duplicateWidget mints a fresh id beside the source', () => {
    const next = duplicateWidget(twoRowSpec(), 'a');
    expect(next.ok && next.spec.rows[0].widgets.length).toBe(3);
    const ids = next.ok ? next.spec.rows.flatMap((r) => r.widgets.map((w) => w.id)) : [];
    expect(new Set(ids).size).toBe(4);
  });

  it("duplicateWidget deep-copies — mutating the copy's filter leaves the source alone", () => {
    const rule: FilterRule = { field: 'status', op: 'equals', value: 'doing' };
    const original: DashboardSpec = {
      rows: [{ id: 'r1', widgets: [{ id: 'a', kind: 'table', filter: { all: [rule] } }] }],
    };
    const next = duplicateWidget(original, 'a');
    if (!next.ok) throw new Error('expected duplicateWidget to succeed');
    const [source, copy] = next.spec.rows[0].widgets;
    expect(copy.id).not.toBe(source.id);

    if (copy.filter === undefined || !('all' in copy.filter)) {
      throw new Error('expected the copy to carry an all-group');
    }
    const copyRule = copy.filter.all[0];
    if (!('field' in copyRule)) throw new Error('expected a rule, not a nested group');
    copyRule.value = 'mutated';

    if (source.filter === undefined || !('all' in source.filter)) {
      throw new Error('expected the source to carry an all-group');
    }
    const sourceRule = source.filter.all[0];
    expect('field' in sourceRule && sourceRule.value).toBe('doing');
  });

  it('updateWidget patches in place, rebuilding only the touched row', () => {
    const base = threeRowSpec();
    const next = updateWidget(base, 'c', { title: 'Named' });
    if (!next.ok) throw new Error('expected updateWidget to succeed');
    expect(next.spec.rows[1].widgets[0]).toMatchObject({ id: 'c', title: 'Named' });
    expect(next.spec.rows[0]).toBe(base.rows[0]);
    expect(next.spec.rows[2]).toBe(base.rows[2]);
  });

  // An emptied filter must LEAVE the YAML — `filter: null` lingering in the
  // file is a rule nobody wrote, and the parser would have to defend against
  // it forever.
  it('updateWidget deletes a key handed undefined', () => {
    const base: DashboardSpec = {
      rows: [
        {
          id: 'r1',
          widgets: [
            { id: 'a', kind: 'table', filter: { all: [{ field: 'x', op: 'is_not_empty' }] } },
          ],
        },
      ],
    };
    const next = updateWidget(base, 'a', { filter: undefined });
    if (!next.ok) throw new Error('expected updateWidget to succeed');
    expect('filter' in next.spec.rows[0].widgets[0]).toBe(false);
  });

  it('updateWidget on an unknown id is a no-op — same spec reference', () => {
    const base = twoRowSpec();
    const next = updateWidget(base, 'ghost', { title: 'x' });
    expect(next.ok && next.spec).toBe(base);
  });

  it('setRowHeight clamps into the sane band and rounds', () => {
    const spec: DashboardSpec = { rows: [{ id: 'r1', widgets: [wid('a')] }] };
    const over = setRowHeight(spec, 'r1', 9999);
    expect(over.ok && over.spec.rows[0].h).toBe(ROW_HEIGHT_MAX);
    const under = setRowHeight(spec, 'r1', 10);
    expect(under.ok && under.spec.rows[0].h).toBe(ROW_HEIGHT_MIN);
    const rounded = setRowHeight(spec, 'r1', 321.6);
    expect(rounded.ok && rounded.spec.rows[0].h).toBe(322);
  });

  it('setWidgetWeight floors at 1 and rounds to two decimals', () => {
    const spec: DashboardSpec = { rows: [{ id: 'r1', widgets: [wid('a')] }] };
    const low = setWidgetWeight(spec, 'a', 0.2);
    expect(low.ok && low.spec.rows[0].widgets[0].w).toBe(1);
    const precise = setWidgetWeight(spec, 'a', 1.336);
    expect(precise.ok && precise.spec.rows[0].widgets[0].w).toBe(1.34);
  });
});
