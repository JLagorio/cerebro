import { formatNumber, kindMeta } from './properties';
import type { FieldDef, FieldKind } from './types';

/**
 * Column aggregations — what the table's calculation footer computes (M16.15).
 *
 * There was no aggregate module at all: `computeRollup` aggregates across a
 * RELATION (one record's children), which is a different question from "what
 * do the values in this column add up to across the rows on screen". Rollups
 * also aggregate raw frontmatter, while a footer has to agree with what the
 * grid is showing — a ghost select value and a formatted number are what the
 * user is looking at.
 *
 * So the unit here is a RESOLVED cell, and emptiness is DISPLAY emptiness. A
 * column reading "—" in every row must not report three values because the
 * frontmatter holds three empty strings.
 */

export const AGGREGATE_CALCS = [
  'count_all',
  'count_empty',
  'count_unique',
  'percent_empty',
  'sum',
  'avg',
  'min',
  'max',
  'range',
] as const;

export type AggregateCalc = (typeof AGGREGATE_CALCS)[number];

export interface AggregateMeta {
  calc: AggregateCalc;
  label: string;
  /** Reads the values as numbers, so it is offered only on numeric kinds. */
  numeric: boolean;
  /** The caption beside the result in a footer cell, where "Count unique" is
   * wider than most columns. */
  short: string;
}

/**
 * Declaration order is menu order, and `satisfies Record<AggregateCalc, …>`
 * is the enforcement — the same guard `KIND_META` carries. A calc added to
 * the union and forgotten here would otherwise fall through `aggregateMeta`'s
 * fallback and silently render as Count all.
 */
const CALC_META = {
  count_all: { label: 'Count all', short: 'Count', numeric: false },
  count_empty: { label: 'Count empty', short: 'Empty', numeric: false },
  count_unique: { label: 'Count unique', short: 'Unique', numeric: false },
  percent_empty: { label: 'Percent empty', short: 'Empty', numeric: false },
  sum: { label: 'Sum', short: 'Sum', numeric: true },
  avg: { label: 'Average', short: 'Avg', numeric: true },
  min: { label: 'Min', short: 'Min', numeric: true },
  max: { label: 'Max', short: 'Max', numeric: true },
  range: { label: 'Range', short: 'Range', numeric: true },
} satisfies Record<AggregateCalc, Omit<AggregateMeta, 'calc'>>;

export const AGGREGATES: AggregateMeta[] = AGGREGATE_CALCS.map((calc) => ({
  calc,
  ...CALC_META[calc],
}));

export const aggregateMeta = (calc: AggregateCalc): AggregateMeta =>
  AGGREGATES.find((a) => a.calc === calc) ?? AGGREGATES[0];

/** A stored `calc:` key, or null when the file names something we cannot
 * compute — a view file is hand-editable and must never fail to load. */
export function parseAggregateCalc(raw: unknown): AggregateCalc | null {
  return typeof raw === 'string' && (AGGREGATE_CALCS as readonly string[]).includes(raw)
    ? (raw as AggregateCalc)
    : null;
}

/**
 * The calculations a column of this kind can honestly offer.
 *
 * Gated on `KIND_META.numeric` rather than on a `Set<FieldKind>` of its own:
 * two hand-maintained lists of the same fact is what M16.13 spent a commit
 * deleting. A `show` rollup will therefore be offered Sum and answer with
 * nothing, which is the honest report of a column holding no numbers — and
 * strictly better than a second registry that has to be kept in step with the
 * first.
 */
export function aggregatesFor(kind: FieldKind): AggregateMeta[] {
  return kindMeta(kind).numeric ? AGGREGATES : AGGREGATES.filter((a) => !a.numeric);
}

/** One resolved cell: what the row stores, and what the grid draws for it. */
export interface AggregateCell {
  raw: unknown;
  display: string;
}

/** Everything a number is not. Currency symbols, thousands separators and the
 * trailing `%` a format appended all have to come off before `Number`. */
const NUMERIC_NOISE = /[^0-9.eE+-]/g;

function toNumber(cell: AggregateCell): number | null {
  if (typeof cell.raw === 'number') return Number.isFinite(cell.raw) ? cell.raw : null;
  // Rollups and computed kinds carry their value as a string; a formatted
  // number is the only reading left when the raw side holds one too.
  const source = typeof cell.raw === 'string' && cell.raw !== '' ? cell.raw : cell.display;
  const cleaned = source.replace(NUMERIC_NOISE, '');
  // `Number('')` is 0, so a column of prose would otherwise sum to zero.
  if (!/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** A computed total, in the field's own number format where it has one — a
 * column of dollars sums to dollars. */
function formatResult(value: number, def?: FieldDef): string {
  if (def === undefined) return String(Number(value.toFixed(2)));
  return formatNumber(value, def);
}

/**
 * Run one calculation over a column's cells. Returns a display string; '' is
 * "nothing to report", which a footer draws as blank rather than as zero.
 */
export function aggregate(calc: AggregateCalc, cells: AggregateCell[], def?: FieldDef): string {
  const filled = cells.filter((c) => c.display !== '');
  const empty = cells.length - filled.length;
  /** Numbers only, computed on demand — the counting calcs never need them. */
  const over = (fn: (numbers: number[]) => number): string => {
    const numbers = filled.map(toNumber).filter((n): n is number => n !== null);
    return numbers.length === 0 ? '' : formatResult(fn(numbers), def);
  };

  switch (calc) {
    case 'count_all':
      return String(cells.length);
    case 'count_empty':
      return String(empty);
    case 'count_unique':
      return String(new Set(filled.map((c) => c.display)).size);
    case 'percent_empty':
      // No rows is not "0% empty" — it is a question with no answer, and
      // printing 0% there claims the column is full.
      return cells.length === 0 ? '' : `${Math.round((empty / cells.length) * 100)}%`;
    case 'sum':
      return over((ns) => ns.reduce((a, b) => a + b, 0));
    case 'avg':
      return over((ns) => ns.reduce((a, b) => a + b, 0) / ns.length);
    case 'min':
      return over((ns) => Math.min(...ns));
    case 'max':
      return over((ns) => Math.max(...ns));
    case 'range':
      return over((ns) => Math.max(...ns) - Math.min(...ns));
    default: {
      // The M16.4 guard: a calc added to the union and forgotten here is a
      // build error rather than a footer cell that silently reads "0".
      const exhaustive: never = calc;
      return exhaustive;
    }
  }
}
