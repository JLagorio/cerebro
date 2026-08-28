import { aggregateNumbers, formatNumber } from './properties';
import { humanize } from './schema';
import type { ChartAgg, DashboardWidget, Entry, Schema } from './types';

/**
 * The dashboard's number widget (M16.28; a `blocks[]` member until M44.4).
 *
 * It measures the DASHBOARD'S OWN rows — the same filtered, sorted set every
 * other layout of this view would show — so the view's filters scope it. A
 * number that ignored them would be a constant, and a constant does not belong
 * on a dashboard.
 *
 * The arithmetic is `aggregateNumbers`, the same function the chart and the
 * rollup column run. Three implementations of "average these" is how two
 * surfaces end up quoting different figures for one property.
 */

export type NumberBlocked = 'no-value-field' | 'no-numbers' | null;

export interface DashboardNumber {
  /** The measured value; 0 when there is nothing to measure. */
  value: number;
  /** Through the property's own number format, so $ and % survive. */
  display: string;
  /** What the tile is called when the block names nothing. */
  label: string;
  /** How many records went into it — the tile's subtitle. */
  count: number;
  blocked: NumberBlocked;
}

const AGG_LABEL: Record<ChartAgg, string> = {
  count: 'Records',
  sum: 'Sum',
  avg: 'Average',
};

export function dashboardNumber(
  entries: Entry[],
  block: Extract<DashboardWidget, { kind: 'number' }>,
  schema: Schema,
): DashboardNumber {
  const label =
    block.title ??
    (block.agg === 'count' || block.value === undefined
      ? AGG_LABEL[block.agg]
      : `${AGG_LABEL[block.agg]} of ${humanize(block.value)}`);

  if (block.agg === 'count') {
    return {
      value: entries.length,
      display: String(entries.length),
      label,
      count: entries.length,
      blocked: null,
    };
  }
  if (block.value === undefined || block.value === '') {
    return { value: 0, display: '—', label, count: entries.length, blocked: 'no-value-field' };
  }

  const field = block.value;
  const values = entries
    .map((e) => e.properties[field])
    .filter((v) => v !== undefined && v !== null && v !== '');
  const measured = aggregateNumbers(values, block.agg);
  if (measured === null) {
    return { value: 0, display: '—', label, count: entries.length, blocked: 'no-numbers' };
  }

  // The property's own format, from the first record that declares it: a tile
  // reading 2000 beside a table reading $2,000 looks like a different number.
  const def = entries.map((e) => schema.resolveField(e, field).def).find((d) => d !== null) ?? null;
  return {
    value: measured,
    display: def === null ? String(measured) : formatNumber(measured, def),
    label,
    count: values.length,
    blocked: null,
  };
}
