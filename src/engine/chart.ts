import { groupTree } from './grouping';
import { aggregateNumbers, formatNumber } from './properties';
import { humanize } from './schema';
import { bandLevels } from './types';
import type { ChartAgg, ChartSpec, Entry, FieldDef, Presentation, Schema } from './types';

/**
 * What a chart draws (M16.27).
 *
 * The chart owns no grouping of its own. Its X axis IS the view's grouping
 * chain — `groupTree` with the first band level — so a board re-opened as a
 * chart charts what the board was banded by, the declared option order and the
 * "No <field>" bucket carry over unchanged, and there is no second grouping
 * control for the two to drift apart on.
 *
 * The Y axis reuses `aggregateNumbers`, the same arithmetic a rollup column
 * runs. A chart that summed its own way would disagree with the number in the
 * table beside it the first time a value arrived as the string "3".
 */

export interface ChartSlice {
  /** Group key — the option id, or `__none__` for the no-value bucket. */
  key: string;
  label: string;
  /** The option's declared colour, or null when the grouping has none. */
  color: string | null;
  /** Value outside the declared option set. */
  ghost: boolean;
  /** Records in the band, whatever the measure is. */
  count: number;
  /** The measured value the chart draws. */
  value: number;
  /** The value as text, through the measured property's own number format. */
  display: string;
}

/** Why a chart has nothing to draw. Never a blank box — each of these becomes
 * a sentence that names the control that fixes it. */
export type ChartBlocked = 'no-rows' | 'no-group' | 'no-value-field' | 'no-numbers' | null;

export interface ChartData {
  slices: ChartSlice[];
  /** Sum of every slice — the donut's whole, and its centre label. */
  total: number;
  /** `total` through the value field's formatting — what a big stat prints. */
  totalDisplay: string;
  /** Largest slice value; 0 when there are none. The bar/line Y extent. */
  max: number;
  /** The field the X axis bands by, humanized; '' when there is none. */
  axis: string;
  /** What the Y axis measures, e.g. 'Count' or 'Sum of Estimate'. */
  measure: string;
  blocked: ChartBlocked;
}

const MEASURE_LABEL: Record<ChartAgg, string> = {
  count: 'Count',
  sum: 'Sum',
  avg: 'Average',
};

/** 'Count', or 'Sum of Estimate' — the Y axis's name, in words. */
export function measureLabel(chart: ChartSpec | undefined): string {
  const agg: ChartAgg = chart?.agg ?? 'count';
  if (agg === 'count' || chart?.value === undefined) return MEASURE_LABEL[agg];
  return `${MEASURE_LABEL[agg]} of ${humanize(chart.value)}`;
}

/** The first entry that declares `field`, so a measured value can be formatted
 * the way its own property is (currency, percent, precision). */
function defFor(entries: Entry[], field: string, schema: Schema): FieldDef | null {
  for (const e of entries) {
    const def = schema.resolveField(e, field).def;
    if (def !== null) return def;
  }
  return null;
}

/**
 * A round number at or above `value`, for the Y axis top.
 *
 * Without it the tallest bar touches the frame and the gridline labels read
 * 8.3333 / 16.667 / 25 — which is what a linear scale straight off the data
 * gives you.
 */
export function niceCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

export function computeChart(
  entries: Entry[],
  presentation: Presentation,
  schema: Schema,
): ChartData {
  const chart = presentation.chart;
  const kind = chart?.kind ?? 'bar';
  const agg: ChartAgg = chart?.agg ?? 'count';
  const band = bandLevels(presentation.group)[0];
  const empty = (blocked: ChartBlocked): ChartData => ({
    slices: [],
    total: 0,
    totalDisplay: '',
    max: 0,
    axis: band === undefined ? '' : humanize(band.field),
    measure: measureLabel(chart),
    blocked,
  });

  if (entries.length === 0) return empty('no-rows');
  // Sum and average need something to add up. Saying so beats charting a row
  // of zeroes that looks like a real answer about the data.
  if (agg !== 'count' && (chart?.value === undefined || chart.value === '')) {
    return empty('no-value-field');
  }

  const valueField = chart?.value ?? '';
  const def = agg === 'count' ? null : defFor(entries, valueField, schema);

  // A number chart totals every visible row. It has no axis at all, so it
  // never reaches the no-group gate below (M44.2).
  if (kind === 'number') {
    if (agg === 'count') {
      const n = entries.length;
      return {
        slices: [],
        total: n,
        totalDisplay: def === null ? String(n) : formatNumber(n, def),
        max: n,
        axis: '',
        measure: measureLabel(chart),
        blocked: null,
      };
    }
    const values = entries
      .map((e) => e.properties[valueField])
      .filter((v) => v !== undefined && v !== null && v !== '');
    const n = aggregateNumbers(values, agg);
    if (n === null) return empty('no-numbers');
    return {
      slices: [],
      total: n,
      totalDisplay: def === null ? String(n) : formatNumber(n, def),
      max: n,
      axis: '',
      measure: measureLabel(chart),
      blocked: null,
    };
  }

  if (band === undefined) return empty('no-group');
  // One band level only: a chart has one X axis, and levels beyond the first
  // would have to become a stacked series, which is not this commit.
  const nodes = groupTree(entries, [band], schema);

  let measured = 0;
  const slices: ChartSlice[] = [];
  for (const node of nodes) {
    let value: number;
    if (agg === 'count') {
      value = node.entries.length;
    } else {
      const values = node.entries
        .map((e) => e.properties[valueField])
        .filter((v) => v !== undefined && v !== null && v !== '');
      const n = aggregateNumbers(values, agg);
      if (n !== null) measured += 1;
      value = n ?? 0;
    }
    if (chart?.omitZero === true && value === 0) continue;
    slices.push({
      key: node.key,
      label: node.label,
      color: node.color,
      ghost: node.ghost,
      count: node.entries.length,
      value,
      // A measured property keeps its own format: summing a currency field
      // must not print a bare number beside a column that prints dollars.
      display: def === null ? String(value) : formatNumber(value, def),
    });
  }

  // Every band held rows and not one of them held a number — a chart of zeroes
  // would state, falsely, that the property is zero everywhere.
  if (agg !== 'count' && slices.length > 0 && measured === 0) return empty('no-numbers');
  if (slices.length === 0) return empty('no-rows');

  if (chart?.sort === 'value-desc') slices.sort((a, b) => b.value - a.value);
  else if (chart?.sort === 'value-asc') slices.sort((a, b) => a.value - b.value);
  else if (chart?.sort === 'label') slices.sort((a, b) => a.label.localeCompare(b.label));

  const total = slices.reduce((sum, s) => sum + s.value, 0);
  // Running totals only where bands have an order to run along — never a
  // donut, whose whole is the sum and would double-count.
  if (chart?.cumulative === true && kind !== 'donut') {
    let run = 0;
    for (const s of slices) {
      run += s.value;
      s.value = run;
      s.display = def === null ? String(run) : formatNumber(run, def);
    }
  }

  return {
    slices,
    total,
    totalDisplay: def === null ? String(total) : formatNumber(total, def),
    max: slices.reduce((top, s) => Math.max(top, s.value), 0),
    axis: humanize(band.field),
    measure: measureLabel(chart),
    blocked: null,
  };
}
