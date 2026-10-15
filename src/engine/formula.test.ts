import { readFileSync } from 'node:fs';
import { expect, it, vi, afterEach } from 'vitest';
import {
  checkFormula,
  evaluateFormula,
  formulaReads,
  parseFormula,
  renameFormulaRefs,
  renderFormula,
  type FormulaField,
} from './formula';

const fields: FormulaField[] = [
  { name: 'target_value', kind: 'number' },
  { name: 'current_value', kind: 'number' },
  { name: 'start', kind: 'date' },
  { name: 'finish', kind: 'date' },
  { name: 'status', kind: 'status' },
  { name: 'gap', kind: 'formula', formula: 'target_value - current_value' },
];
const read = (text: string) =>
  checkFormula(text, fields, { typeName: 'Key result', ownName: 'result' });
function value(text: string, values: Record<string, unknown> = {}) {
  const checked = read(text);
  expect(checked.ok).toBe(true);
  return checked.ok ? evaluateFormula(checked, (name) => values[name]) : undefined;
}
afterEach(() => vi.unstubAllEnvs());

it('honours precedence, unary minus and exact right-parenthesis semantics', () => {
  expect(value('2 + 3 * 4')).toBe(14);
  expect(value('(2 + 3) * 4')).toBe(20);
  expect(value('-2 * -3 + .5')).toBe(6.5);
  expect(value('10 - (4 - 2)')).toBe(8);
  expect(value('10 / (4 / 2)')).toBe(5);
  const parsed = parseFormula('10 - (4 - 2)');
  expect(parsed.ok && renderFormula(parsed.ast)).toBe('10 - (4 - 2)');
});

it('resolves keys before labels, ignoring case, and renders canonical keys', () => {
  expect(read('{Target value} - CURRENT_VALUE')).toMatchObject({
    ok: true,
    canonical: 'target_value - current_value',
    refs: ['target_value', 'current_value'],
    result: 'number',
  });
  expect(
    checkFormula('{A B}', [
      { name: 'a_b', kind: 'number' },
      { name: 'A B', kind: 'date' },
    ]),
  ).toMatchObject({ ok: true, result: 'date', canonical: '{A B}' });
  expect(formulaReads('gap + CURRENT_VALUE', fields)).toEqual(['gap', 'current_value']);
  expect(
    renameFormulaRefs('{Target value} - current_value', fields, 'current_value', 'Current'),
  ).toBe('target_value - Current');
  expect(renameFormulaRefs('target_value - missing', fields, 'target_value', 'Target')).toBeNull();
  expect(formulaReads('target_value +', fields)).toBeNull();
});

it.each([
  ['x % 2', "“%” can't be part of a formula."],
  ['{Target value', 'Close “{” with “}”.'],
  ['(2 + 3', 'Close “(” with “)”.'],
  ['2)', "There's a “)” with no “(” before it."],
  ['2 +', 'The formula stops after “+”.'],
  ['2 3', 'Put an operator between “2” and “3”.'],
  ['unknown', 'Key result has no property called “unknown”.'],
  ['status', 'Status is a status property; formulas read number, date and formula properties.'],
  ['-start', "A date can't be negative."],
  ['start + finish', "Two dates can't be added; subtract them to count the days between."],
  ['2 - start', "A date can't be subtracted from a number."],
  ['start * 2', 'Only numbers can be multiplied or divided.'],
  ['start / finish', 'Only numbers can be multiplied or divided.'],
])('refuses %s with words', (text, error) => expect(read(text)).toEqual({ ok: false, error }));

it.each([
  ['target_value + current_value', 'number'],
  ['target_value - current_value', 'number'],
  ['target_value * current_value', 'number'],
  ['target_value / current_value', 'number'],
  ['start + target_value', 'date'],
  ['target_value + start', 'date'],
  ['start - target_value', 'date'],
  ['finish - start', 'number'],
  ['gap * 2', 'number'],
])('checks %s as %s', (text, result) => expect(read(text)).toMatchObject({ ok: true, result }));

it('keeps every absent or unreadable input absent, including zero divisors and non-finite results', () => {
  for (const missing of [undefined, null, '', '7', false, NaN, Infinity])
    expect(value('target_value + 1', { target_value: missing })).toBeUndefined();
  expect(value('target_value - current_value', { target_value: 10 })).toBeUndefined();
  expect(
    value('target_value / current_value', { target_value: 10, current_value: 0 }),
  ).toBeUndefined();
  expect(value('target_value * 100', { target_value: Number.MAX_VALUE })).toBeUndefined();
  expect(value('start + 1', { start: 'not a date' })).toBeUndefined();
  expect(value('gap * 2', { gap: 4 })).toBe(8);
  expect(value('0')).toBe(0);
});

it('computes date arithmetic in epoch days down to minutes, including leap years and zones', () => {
  vi.stubEnv('TZ', 'America/Los_Angeles');
  expect(value('start + .5', { start: '2026-07-28 14:30' })).toBe('2026-07-29 02:30');
  expect(value('finish - start', { start: '2026-07-28 14:30', finish: '2026-07-30 02:30' })).toBe(
    1.5,
  );
  expect(value('start + 1', { start: '2028-02-28' })).toBe('2028-02-29');
  expect(value('start + 1', { start: '2026-07-28T00:00:00Z' })).toBe('2026-07-28 17:00');
  expect(value('start + 1', { start: '0001-01-01' })).toBe('0001-01-02');
  expect(value('start - 1', { start: '0001-01-01' })).toBeUndefined();
  expect(value('start + 1', { start: '9999-12-31' })).toBeUndefined();
  expect(readFileSync('src/engine/formula.ts', 'utf8')).not.toMatch(
    /new Date|Date\.now|eval\s*\(|new Function/,
  );
});

it('refuses cycles and dependency depth 33, with bounded repeated dependencies', () => {
  const cyclic = [
    { name: 'a', kind: 'formula', formula: 'b' },
    { name: 'b', kind: 'formula', formula: 'a' },
  ];
  expect(checkFormula('b', cyclic, { ownName: 'a' })).toEqual({
    ok: false,
    error: "A reads this property back, so it can't be used here.",
  });
  const chain = Array.from({ length: 33 }, (_, i) => ({
    name: `f${i}`,
    kind: 'formula',
    formula: i === 32 ? '1' : `f${i + 1} + f${i + 1}`,
  }));
  expect(checkFormula(chain[0].formula, chain, { ownName: 'f0' })).toEqual({
    ok: false,
    error: "Formulas can't nest more than 32 deep.",
  });
  expect(checkFormula(chain[1].formula, chain, { ownName: 'f1' })).toMatchObject({
    ok: true,
    result: 'number',
  });
  expect(parseFormula('('.repeat(33) + '1' + ')'.repeat(33))).toEqual({
    ok: false,
    error: "Formulas can't nest more than 32 deep.",
  });
});

it('keeps canonical tiny and huge numeric literals in the parseable decimal dialect', () => {
  for (const text of ['.0000001', '1000000000000000000000', '0.0000000000000000000001']) {
    const first = read(text);
    expect(first.ok).toBe(true);
    if (!first.ok) continue;
    const next = read(first.canonical);
    expect(next.ok).toBe(true);
    if (next.ok) expect(evaluateFormula(next, () => undefined)).toBe(Number(text));
  }
});
