import { describe, expect, it } from 'vitest';
import {
  AGGREGATES,
  aggregate,
  aggregateMeta,
  aggregatesFor,
  parseAggregateCalc,
} from './aggregate';
import type { AggregateCell } from './aggregate';
import type { FieldDef } from './types';

/** Cells as the grid resolves them: what is stored, and what is drawn. */
const cell = (raw: unknown, display = raw === null || raw === undefined ? '' : String(raw)) => ({
  raw,
  display,
});
const cells = (...values: unknown[]): AggregateCell[] => values.map((v) => cell(v));

describe('aggregatesFor (capability gating)', () => {
  it('offers the numeric calculations only where the values are numbers', () => {
    // The gate is KIND_META.numeric, not a Set<FieldKind> living here — two
    // hand-maintained lists of one fact is the bug class M16.13 closed.
    expect(aggregatesFor('number').map((a) => a.calc)).toContain('sum');
    expect(aggregatesFor('select').map((a) => a.calc)).not.toContain('sum');
    // Counting works on everything: a column of prose still has a length.
    expect(aggregatesFor('select').map((a) => a.calc)).toContain('count_all');
  });

  it('a rollup counts as numeric — its result is a number for every calc but show', () => {
    expect(aggregatesFor('rollup').map((a) => a.calc)).toContain('avg');
  });

  it('every declared calc carries a label and a short caption', () => {
    // The footer cell renders `short` beside the value; an undefined there
    // would print "undefined" in the grid rather than fail anywhere.
    for (const a of AGGREGATES) {
      expect(a.label).not.toBe('');
      expect(a.short).not.toBe('');
    }
  });
});

describe('parseAggregateCalc', () => {
  it('refuses a calc it cannot compute rather than storing it', () => {
    // View files are hand-editable; an unknown name must degrade to "no
    // calculation", never reach `aggregate` and hit its exhaustive guard.
    expect(parseAggregateCalc('sum')).toBe('sum');
    expect(parseAggregateCalc('median')).toBeNull();
    expect(parseAggregateCalc(7)).toBeNull();
    expect(parseAggregateCalc(undefined)).toBeNull();
  });

  it('aggregateMeta falls back rather than returning undefined', () => {
    expect(aggregateMeta('range').label).toBe('Range');
  });
});

describe('counting calculations', () => {
  it('counts every row, including the empty ones', () => {
    expect(aggregate('count_all', cells(1, null, 3))).toBe('3');
  });

  it('emptiness is DISPLAY emptiness, not frontmatter emptiness', () => {
    // The regression this guards: a column showing "—" in every row must not
    // report values because the raw side holds empty strings or empty lists.
    const rows: AggregateCell[] = [cell([], ''), cell('', ''), cell('done')];
    expect(aggregate('count_empty', rows)).toBe('2');
    expect(aggregate('count_all', rows)).toBe('3');
  });

  it('counts distinct rendered values, so two ids with one label count once', () => {
    const rows: AggregateCell[] = [cell('ip', 'In progress'), cell('in-progress', 'In progress')];
    expect(aggregate('count_unique', rows)).toBe('1');
  });

  it('percent empty has no answer over no rows', () => {
    // 0% would claim the column is full; the honest report of 0/0 is nothing.
    expect(aggregate('percent_empty', [])).toBe('');
    expect(aggregate('percent_empty', cells(1, null, null, null))).toBe('75%');
  });
});

describe('numeric calculations', () => {
  it('sums, averages, and spans', () => {
    const rows = cells(2, 4, 9);
    expect(aggregate('sum', rows)).toBe('15');
    expect(aggregate('avg', rows)).toBe('5');
    expect(aggregate('min', rows)).toBe('2');
    expect(aggregate('max', rows)).toBe('9');
    expect(aggregate('range', rows)).toBe('7');
  });

  it('reports nothing rather than zero when the column holds no numbers', () => {
    // `Number('')` is 0, so the naive version sums a column of prose to zero
    // and reads as an answer.
    expect(aggregate('sum', cells('alpha', 'beta'))).toBe('');
    expect(aggregate('avg', [])).toBe('');
  });

  it('reads a formatted value when the raw side is a string', () => {
    // Rollups and computed kinds carry their value as text, and a number
    // field's display has already had its currency symbol and separators
    // applied.
    const rows: AggregateCell[] = [cell('1,200', '$1,200'), cell('76%', '76%')];
    expect(aggregate('sum', rows)).toBe('1276');
  });

  it('ignores values that only look numeric', () => {
    // A date is digits and separators; cleaning it leaves NaN, which must not
    // land in the total as a zero.
    expect(aggregate('sum', [cell(3), cell('2026-08-02')])).toBe('3');
  });

  it('totals in the field’s own number format — dollars sum to dollars', () => {
    const money: FieldDef = { name: 'cost', kind: 'number', format: 'currency', precision: 0 };
    expect(aggregate('sum', cells(1200, 800), money)).toBe('$2,000');
    const pct: FieldDef = { name: 'done', kind: 'number', format: 'percent' };
    expect(aggregate('avg', cells(50, 100), pct)).toBe('75%');
  });

  it('rounds an average instead of printing a repeating decimal', () => {
    expect(aggregate('avg', cells(1, 1, 1, 2))).toBe('1.25');
    expect(aggregate('avg', cells(1, 2, 2))).toBe('1.67');
  });
});
