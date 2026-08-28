import { groupEntries, groupTree } from './grouping';
import { aggregateNumbers, formatNumber } from './properties';
import { humanize } from './schema';
import { bandLevels } from './types';
import type {
  ChartAgg,
  ChartSpec,
  Entry,
  FieldDef,
  Group,
  GroupSpec,
  Presentation,
  Schema,
} from './types';

/**
 * What a chart draws (M16.27; the axis decoupled in M44.3).
 *
 * The X axis is `chart.xField` when set. Absent, it is the view's grouping
 * chain's first band level — the M16.27 default, kept so a board re-opened as
 * a chart still charts what the board was banded by, declared option order and
 * "No <field>" bucket included, and every chart saved before `xField` existed
 * renders identically.
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
  /** Records in the band, whatever the measure is — the drilldown's honest
   * number even when `hiddenG` shrinks `value` to the visible stack. */
  count: number;
  /** The measured value the chart draws. */
  value: number;
  /** The value as text, through the measured property's own number format. */
  display: string;
  /** Pre-filter position — the hue index renderers color by (M44.3). Hiding a
   * band must not repaint its neighbours. */
  hue: number;
  /** The band's rows, the drilldown's subject (M44.3). */
  entries: Entry[];
  /** groupBy sub-bands, in series order, `hiddenG` already filtered out.
   * Absent when no groupBy. */
  parts?: ChartSlicePart[];
}

/** One groupBy sub-band of one band — a stacked segment, a series point. */
export interface ChartSlicePart {
  key: string;
  label: string;
  color: string | null;
  ghost: boolean;
  count: number;
  value: number;
  display: string;
  /** The series roster index — the part's colour, stable under hiding. */
  hue: number;
}

/** One legend row: a band or a series, hidden ones included. */
export interface ChartRosterItem {
  key: string;
  label: string;
  color: string | null;
  hue: number;
  hidden: boolean;
}

/** Why a chart has nothing to draw. Never a blank box — each of these becomes
 * a sentence that names the control that fixes it. `all-hidden` is typed
 * apart from `no-rows` on purpose: "you switched everything off" and "there
 * is nothing here" need different sentences (M44.3). */
export type ChartBlocked =
  'no-rows' | 'no-group' | 'no-value-field' | 'no-numbers' | 'all-hidden' | null;

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
  /** Every band, hidden included — the legend's roster (M44.3). */
  bands: ChartRosterItem[];
  /** The groupBy roster, first-seen declared order; [] when no groupBy. */
  series: ChartRosterItem[];
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
  const band: GroupSpec | undefined =
    chart?.xField !== undefined ? { field: chart.xField } : bandLevels(presentation.group)[0];
  // `all-hidden` is the one blocked state with rosters: the legend must
  // still list what was hidden, or there is no way back.
  const empty = (
    blocked: ChartBlocked,
    bands: ChartRosterItem[] = [],
    series: ChartRosterItem[] = [],
  ): ChartData => ({
    slices: [],
    total: 0,
    totalDisplay: '',
    max: 0,
    axis: band === undefined ? '' : humanize(band.field),
    measure: measureLabel(chart),
    bands,
    series,
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
        bands: [],
        series: [],
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
      bands: [],
      series: [],
      blocked: null,
    };
  }

  if (band === undefined) return empty('no-group');
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
      // The pre-filter index: the roster position this band keeps for good,
      // so hiding a neighbour never repaints it.
      hue: slices.length,
      entries: node.entries,
    });
  }

  // Every band held rows and not one of them held a number — a chart of zeroes
  // would state, falsely, that the property is zero everywhere.
  if (agg !== 'count' && slices.length > 0 && measured === 0) return empty('no-numbers');
  if (slices.length === 0) return empty('no-rows');

  // The legend's roster: every band at its stamped hue, hidden ones included.
  const hiddenBands = new Set(chart?.hidden ?? []);
  const bands: ChartRosterItem[] = slices.map((s) => ({
    key: s.key,
    label: s.label,
    color: s.color,
    hue: s.hue,
    hidden: hiddenBands.has(s.key),
  }));

  // Hiding is arithmetic, not paint: a hidden band leaves the slices, the
  // total, the max, and the ring. Hiding everything is its own typed state —
  // "you switched it all off" is not "no rows" — and it carries the roster,
  // because the legend is the only way back.
  const visible = slices.filter((s) => !hiddenBands.has(s.key));
  if (visible.length === 0 && bands.some((b) => b.hidden)) return empty('all-hidden', bands);

  // The second dimension. A donut ignores it — a stacked ring reads as
  // nothing — and a number chart returned above; it has no bands to split.
  const series: ChartRosterItem[] = [];
  // Ghost-ness by series key, for the plateau parts the cumulative pass
  // synthesizes below — the roster itself does not carry it.
  const seriesGhost = new Map<string, boolean>();
  const groupBy = chart?.groupBy;
  if (groupBy !== undefined && kind !== 'donut') {
    const hiddenSeries = new Set(chart?.hiddenG ?? []);
    const seriesHue = new Map<string, number>();
    // The roster pass runs over EVERY band, hidden ones included. Undeclared
    // values (text fields, ghosts, `__none__`) exist only where some band's
    // rows put them, so a roster read off the visible bands would erase a
    // series the moment its sole holder hid — renumbering every later hue and
    // orphaning its hiddenG key. The roster lists what exists; hiding is
    // state. Order is first-seen across bands — declared option order per
    // band, empty declared options included, the way the band axis keeps
    // empty bands — and the hue a series gets here is the hue it keeps.
    const subsFor = new Map<string, Group[]>();
    for (const s of slices) {
      const subs = groupEntries(s.entries, groupBy, schema);
      subsFor.set(s.key, subs);
      for (const sub of subs) {
        if (seriesHue.has(sub.key)) continue;
        const hue = series.length;
        seriesHue.set(sub.key, hue);
        seriesGhost.set(sub.key, sub.ghost);
        series.push({
          key: sub.key,
          label: sub.label,
          color: sub.color,
          hue,
          hidden: hiddenSeries.has(sub.key),
        });
      }
    }
    // Hiding every series blanks the chart the same way hiding every band
    // does. All-zero bars would claim a measured zero — absent is never zero —
    // so this is the same typed state, carrying both rosters as the way back.
    if (series.length > 0 && series.every((x) => x.hidden)) {
      return empty('all-hidden', bands, series);
    }
    for (const s of visible) {
      const parts: ChartSlicePart[] = [];
      for (const sub of subsFor.get(s.key) ?? []) {
        // An empty sub-band is no segment, and a hidden series draws nothing.
        if (sub.entries.length === 0 || hiddenSeries.has(sub.key)) continue;
        const hue = seriesHue.get(sub.key)!;
        const partValue =
          agg === 'count'
            ? sub.entries.length
            : (aggregateNumbers(
                sub.entries
                  .map((e) => e.properties[valueField])
                  .filter((v) => v !== undefined && v !== null && v !== ''),
                agg,
              ) ?? 0);
        parts.push({
          key: sub.key,
          label: sub.label,
          color: sub.color,
          ghost: sub.ghost,
          count: sub.entries.length,
          value: partValue,
          display: def === null ? String(partValue) : formatNumber(partValue, def),
          hue,
        });
      }
      // Parts order by hue, always: a text-field groupBy alphabetizes
      // sub-bands PER BAND while hues are first-seen ACROSS bands, and where
      // the two orders disagree a series would change stack level between
      // bands. Hue order pins each series to one level everywhere.
      parts.sort((a, b) => a.hue - b.hue);
      s.parts = parts;
      // Under groupBy the band draws its visible stack, so the segments and
      // the total agree — while `count` stays the band's true row count.
      s.value = parts.reduce((sum, p) => sum + p.value, 0);
      s.display = def === null ? String(s.value) : formatNumber(s.value, def);
    }
  }

  if (chart?.sort === 'value-desc') visible.sort((a, b) => b.value - a.value);
  else if (chart?.sort === 'value-asc') visible.sort((a, b) => a.value - b.value);
  else if (chart?.sort === 'label') visible.sort((a, b) => a.label.localeCompare(b.label));

  const total = visible.reduce((sum, s) => sum + s.value, 0);
  // Running totals only where bands have an order to run along — never a
  // donut, whose whole is the sum and would double-count. The run covers the
  // visible bands only: what the eye adds up is what the line draws. A
  // stacked run cumulates PER SERIES — each segment becomes its own series'
  // running total at that band, so the stack's height is the cumulated band
  // total and every segment stays honest.
  if (chart?.cumulative === true && kind !== 'donut') {
    let run = 0;
    const seriesRun = new Map<string, number>();
    for (const s of visible) {
      if (s.parts !== undefined) {
        for (const p of s.parts) {
          const r = (seriesRun.get(p.key) ?? 0) + p.value;
          seriesRun.set(p.key, r);
          p.value = r;
          p.display = def === null ? String(r) : formatNumber(r, def);
        }
        // A band that lacks a series must not dip the stack: the run is
        // carried forward as a synthesized plateau part — `count: 0`, because
        // no rows arrived here; the height is the run persisting — so every
        // band's stack is the sum of all begun series' runs, monotonic
        // non-decreasing. Only a series already begun gets one, and "begun"
        // is PRESENCE in the run map, not the run's value: a run that began
        // at measured zero is a zero to carry, while before the first value
        // there is nothing to carry — absent is never zero, in either
        // direction.
        for (const item of series) {
          if (item.hidden) continue;
          if (!seriesRun.has(item.key)) continue;
          const r = seriesRun.get(item.key)!;
          if (s.parts.some((p) => p.key === item.key)) continue;
          s.parts.push({
            key: item.key,
            label: item.label,
            color: item.color,
            ghost: seriesGhost.get(item.key) ?? false,
            count: 0,
            value: r,
            display: def === null ? String(r) : formatNumber(r, def),
            hue: item.hue,
          });
        }
        // Plateaus append at the end; restore the hue order the build pass
        // established, so each sits at its series' own stack level.
        s.parts.sort((a, b) => a.hue - b.hue);
        s.value = s.parts.reduce((sum, p) => sum + p.value, 0);
        s.display = def === null ? String(s.value) : formatNumber(s.value, def);
      } else {
        run += s.value;
        s.value = run;
        s.display = def === null ? String(run) : formatNumber(run, def);
      }
    }
  }

  return {
    slices: visible,
    total,
    totalDisplay: def === null ? String(total) : formatNumber(total, def),
    max: visible.reduce((top, s) => Math.max(top, s.value), 0),
    axis: humanize(band.field),
    measure: measureLabel(chart),
    bands,
    series,
    blocked: null,
  };
}
