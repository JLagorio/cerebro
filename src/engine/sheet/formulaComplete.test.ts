import { expect, it } from 'vitest';
import raw from './functions.json';
import {
  catalogEntries,
  completionFor,
  expectsReference,
  insertFunction,
  toChars,
  toUtf16,
} from './formulaComplete';
const catalog = catalogEntries(raw);
it('adapts the pinned catalog including names, optional arguments and variadic tails', () => {
  expect(catalog).toHaveLength(490);
  expect(catalog.find((f) => f.name === 'SUM')).toMatchObject({
    variadic: true,
    args: [{ name: 'number1' }, { name: 'number2' }],
  });
  expect(catalog.find((f) => f.name === 'IF')?.args[2].name).toBe('value_if_false');
  expect(catalog.find((f) => f.name === 'VLOOKUP')?.args).toHaveLength(4);
  expect(catalogEntries({ broken: { args: [1], description: 'x' } })).toEqual([]);
  expect(catalogEntries(null)).toEqual([]);
});
it('ranks common functions first and caps the list without caring about prefix case', () => {
  const result = completionFor({ expecting: [{ FunctionName: 'su' }], replace_from: 0 }, catalog);
  expect(result?.kind === 'functions' && result.entries[0].name).toBe('SUM');
  const all = completionFor({ expecting: [{ FunctionName: '' }], replace_from: 0 }, catalog);
  expect(all?.kind === 'functions' && all.entries.length).toBe(40);
  expect(all?.kind === 'functions' && all.entries.slice(0, 7).map((r) => r.name)).toEqual([
    'SUM',
    'AVERAGE',
    'IF',
    'COUNT',
    'MIN',
    'MAX',
    'ROUND',
  ]);
});
it('hints the current argument and repeats the last argument only for variadic functions', () => {
  const hint = (name: string, index: number) =>
    completionFor({ expecting: [{ Argument: [name, index] }, 'Range'], replace_from: 7 }, catalog);
  expect(hint('SUM', 2)).toMatchObject({
    kind: 'argument',
    index: 2,
    argument: { name: 'number2' },
  });
  expect(hint('SUM', 30)).toMatchObject({ argument: { name: 'number2' } });
  expect(hint('IF', 4)).toBeNull();
  expect(expectsReference({ expecting: ['Range'], replace_from: 0 })).toBe(true);
  expect(expectsReference(null)).toBe(false);
});
it('converts Unicode caret offsets and replaces only the partial function', () => {
  const text = '="😀"&SU';
  expect(toChars(text, text.length)).toBe(7);
  expect(toUtf16(text, 7)).toBe(text.length);
  expect(insertFunction(text, text.length, { expecting: [], replace_from: 4 }, 'SUM')).toEqual({
    text: '="😀"&SUM(',
    cursor: 10,
  });
  expect(insertFunction('=SU(A1)', 3, { expecting: [], replace_from: 0 }, 'SUM')).toEqual({
    text: '=SUM(A1)',
    cursor: 5,
  });
});
