import { describe, expect, it } from 'vitest';
import { dashboardNumber } from '@/engine/dashboard';
import { buildSchema } from '@/engine/schema';
import { makeEntry } from '@/test/factories';
import type { DashboardBlock, Entry } from '@/engine/types';

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
  over: Partial<Extract<DashboardBlock, { kind: 'number' }>> = {},
): Extract<DashboardBlock, { kind: 'number' }> => ({
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
