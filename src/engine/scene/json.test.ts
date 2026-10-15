import { expect, it } from 'vitest';
import { hasLoneSurrogate, parseJson, utf8Length } from './json';

it('keeps raw numbers, escapes, unknown values and first member position with its last value', () => {
  const result = parseJson(
    '{ "x": 1e999, "b": {"n":9007199254740993}, "x": -0, "s":"\\ud800" }',
    32,
  );
  expect(result.kind).toBe('object');
  if (result.kind !== 'object') throw new Error('not an object');
  expect([...result.members.keys()]).toEqual(['x', 'b', 's']);
  expect(result.members.get('x')?.raw).toBe('-0');
  expect(result.members.get('b')?.raw).toBe('{"n":9007199254740993}');
  expect(result.members.get('s')?.raw).toBe('"\\ud800"');
  expect(result.raw).toBe('{"x":1e999,"b":{"n":9007199254740993},"x":-0,"s":"\\ud800"}');
});

it.each([
  '[1,]',
  '{"x":1,}',
  '01',
  '+1',
  '.1',
  '1.',
  '1e',
  '[NaN]',
  'truex',
  '{x:1}',
  '"a\nb"',
  '"\\x20"',
  '[1\u00a0]',
  '[1\uFEFF]',
  '"unterminated',
])('refuses non-JSON %s', (source) => {
  expect(() => parseJson(source, 32)).toThrow();
});

it('permits only JSON whitespace and at most 32 nested containers', () => {
  expect(parseJson(' \t\r\n[ true, false, null ]\n', 32).raw).toBe('[true,false,null]');
  expect(() => parseJson('['.repeat(32) + '0' + ']'.repeat(32), 32)).not.toThrow();
  expect(() => parseJson('['.repeat(33) + '0' + ']'.repeat(33), 32)).toThrow('32 levels');
});

it('decodes valid escapes but lets callers distinguish escaped lone surrogates', () => {
  const result = parseJson(String.raw`"\ud83d\ude00\n\t\r\b\f\/\\\""`, 32);
  expect(result).toMatchObject({ kind: 'string', value: '😀\n\t\r\b\f/\\"' });
  expect(hasLoneSurrogate('😀')).toBe(false);
  expect(hasLoneSurrogate('\ud800')).toBe(true);
  expect(utf8Length('aé文😀')).toBe(10);
});
