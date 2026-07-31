import { describe, expect, it } from 'vitest';
import { coerceValueToKind, computeRollup, formatTimestamp, validatePatch, validateValue } from './properties';
import { buildSchema } from './schema';
import { makeEntry } from './testHelpers';
import type { FieldDef } from './types';

const def = (kind: FieldDef['kind'], extra: Partial<FieldDef> = {}): FieldDef => ({
  name: 'field',
  kind,
  ...extra,
});

describe('validateValue (shape enforcement)', () => {
  it('null always passes (delete)', () => {
    expect(validateValue(def('number'), null)).toBeNull();
  });

  it('number rejects non-numbers', () => {
    expect(validateValue(def('number'), 3)).toBeNull();
    expect(validateValue(def('number'), 'abc')).toMatch(/number/);
    expect(validateValue(def('number'), Number.NaN)).toMatch(/number/);
  });

  it('checkbox wants booleans', () => {
    expect(validateValue(def('checkbox'), true)).toBeNull();
    expect(validateValue(def('checkbox'), 'yes')).toMatch(/on or off/);
  });

  it('date wants YYYY-MM-DD', () => {
    expect(validateValue(def('date'), '2026-07-26')).toBeNull();
    expect(validateValue(def('date'), '26/07/2026')).toMatch(/YYYY-MM-DD/);
  });

  it('daterange validates both endpoints', () => {
    expect(validateValue(def('daterange'), { start: '2026-07-01', end: null })).toBeNull();
    expect(validateValue(def('daterange'), { start: 'soon' })).toMatch(/YYYY-MM-DD/);
    expect(validateValue(def('daterange'), 'not-a-range')).toMatch(/range/);
  });

  it('select stays advisory on membership but strict on shape', () => {
    expect(validateValue(def('select'), 'anything')).toBeNull();
    expect(validateValue(def('select'), ['a', 'b'])).toMatch(/single option/);
  });

  it('multiselect accepts a string or string list', () => {
    expect(validateValue(def('multiselect'), ['a', 'b'])).toBeNull();
    expect(validateValue(def('multiselect'), 'a')).toBeNull();
    expect(validateValue(def('multiselect'), [1])).toMatch(/list/);
  });

  it('url wants a URL-looking string', () => {
    expect(validateValue(def('url'), 'https://cerebro.dev')).toBeNull();
    expect(validateValue(def('url'), 'www.cerebro.dev')).toBeNull();
    expect(validateValue(def('url'), 'not a url')).toMatch(/URL/);
  });

  it('files accepts string lists', () => {
    expect(validateValue(def('files'), ['a.png', 'docs/b.pdf'])).toBeNull();
    expect(validateValue(def('files'), 42)).toMatch(/files/);
  });

  it('computed kinds reject writes', () => {
    expect(validateValue(def('rollup'), 3)).toMatch(/computed/);
    expect(validateValue(def('created_time'), 'x')).toMatch(/computed/);
    expect(validateValue(def('last_edited_time'), 'x')).toMatch(/computed/);
  });

  // M12.4: enforced relations.
  it('relation honors limit: 1', () => {
    expect(validateValue(def('relation'), ['[[a]]'])).toBeNull();
    expect(validateValue(def('relation'), ['[[a]]', '[[b]]'])).toBeNull();
    expect(validateValue(def('relation', { limit: 1 }), '[[a]]')).toBeNull();
    expect(validateValue(def('relation', { limit: 1 }), ['[[a]]'])).toBeNull();
    expect(validateValue(def('relation', { limit: 1 }), ['[[a]]', '[[b]]'])).toMatch(/single/);
  });

  it('the derived side of a two-way relation rejects direct writes', () => {
    const derived = def('relation', { from: { type: 'Key result', field: 'objective' } });
    expect(validateValue(derived, ['[[kr-1]]'])).toMatch(/other side/);
  });
});

describe('validatePatch (schema-aware)', () => {
  const typeNote = makeEntry({
    path: 'types/task.md',
    title: 'Task',
    type: 'Type',
    properties: { fields: { effort: 'number', due: { kind: 'date' } } },
  });
  const doc = makeEntry({ path: 'a.md', type: 'Task' });
  const schema = buildSchema([typeNote, doc]);

  it('rejects declared fields with wrong shapes', () => {
    expect(validatePatch(schema, doc, { effort: 'lots' })).toHaveLength(1);
    expect(validatePatch(schema, doc, { effort: 5, due: '2026-08-01' })).toHaveLength(0);
  });

  it('undeclared keys pass (advisory schema)', () => {
    expect(validatePatch(schema, doc, { anything: { nested: true } })).toHaveLength(0);
  });

  it('untyped entries pass everything', () => {
    expect(validatePatch(schema, makeEntry({ type: null }), { effort: 'lots' })).toHaveLength(0);
  });
});

describe('computeRollup', () => {
  const subtasks = [
    makeEntry({ path: 'items/a.md', filename: 'a.md', title: 'A', properties: { estimate: 3 } }),
    makeEntry({ path: 'items/b.md', filename: 'b.md', title: 'B', properties: { estimate: 5 } }),
    makeEntry({ path: 'items/c.md', filename: 'c.md', title: 'C', properties: {} }),
  ];
  const parent = makeEntry({
    path: 'items/parent.md',
    relationships: { subtasks: ['a', 'b', 'c'] },
  });
  const entries = [parent, ...subtasks];

  it('counts related entries', () => {
    expect(computeRollup(parent, def('rollup', { relation: 'subtasks' }), entries)).toBe('3');
  });

  it('sums, averages, and bounds a numeric property', () => {
    const base = { relation: 'subtasks', property: 'estimate' } as const;
    expect(computeRollup(parent, def('rollup', { ...base, calculate: 'sum' }), entries)).toBe('8');
    expect(computeRollup(parent, def('rollup', { ...base, calculate: 'avg' }), entries)).toBe('4');
    expect(computeRollup(parent, def('rollup', { ...base, calculate: 'min' }), entries)).toBe('3');
    expect(computeRollup(parent, def('rollup', { ...base, calculate: 'max' }), entries)).toBe('5');
  });

  it('show lists the raw values', () => {
    expect(
      computeRollup(
        parent,
        def('rollup', { relation: 'subtasks', property: 'estimate', calculate: 'show' }),
        entries,
      ),
    ).toBe('3, 5');
  });

  it('empty relation → count 0, aggregates blank', () => {
    const lonely = makeEntry({ path: 'items/lonely.md' });
    expect(computeRollup(lonely, def('rollup', { relation: 'subtasks' }), entries)).toBe('0');
    expect(
      computeRollup(
        lonely,
        def('rollup', { relation: 'subtasks', property: 'estimate', calculate: 'sum' }),
        entries,
      ),
    ).toBe('');
  });
});

describe('formatTimestamp', () => {
  it('shows date and minutes', () => {
    expect(formatTimestamp('2026-07-24T09:30:12.000Z')).toBe('2026-07-24 09:30');
  });
});

// M12.4b: value conversion when a field changes kind.
describe('coerceValueToKind', () => {
  it('empty always clears', () => {
    expect(coerceValueToKind(null, 'number')).toBeNull();
    expect(coerceValueToKind('', 'text')).toBeNull();
  });

  it('to text joins lists', () => {
    expect(coerceValueToKind(['a', 'b'], 'text')).toBe('a, b');
    expect(coerceValueToKind(42, 'text')).toBe('42');
  });

  it('to number keeps a numeric reading and drops the rest', () => {
    expect(coerceValueToKind('42', 'number')).toBe(42);
    expect(coerceValueToKind('$1,200', 'number')).toBe(1200);
    expect(coerceValueToKind('high', 'number')).toBeNull();
  });

  it('to checkbox maps the usual spellings and drops prose', () => {
    expect(coerceValueToKind('yes', 'checkbox')).toBe(true);
    expect(coerceValueToKind('no', 'checkbox')).toBe(false);
    expect(coerceValueToKind(true, 'checkbox')).toBe(true);
    expect(coerceValueToKind('maybe', 'checkbox')).toBeNull();
  });

  it('to date keeps only real dates', () => {
    expect(coerceValueToKind('2026-07-30T10:00:00Z', 'date')).toBe('2026-07-30');
    expect(coerceValueToKind('next week', 'date')).toBeNull();
  });

  it('select vs multiselect: scalar vs list', () => {
    expect(coerceValueToKind(['a', 'b'], 'select')).toBe('a');
    expect(coerceValueToKind('a', 'multiselect')).toEqual(['a']);
  });

  it('to relation wraps names as wikilinks, splitting comma lists', () => {
    expect(coerceValueToKind('alpha, beta', 'relation')).toEqual(['[[alpha]]', '[[beta]]']);
    expect(coerceValueToKind(['[[gamma]]'], 'relation')).toEqual(['[[gamma]]']);
  });
});
