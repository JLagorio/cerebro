import { describe, expect, it } from 'vitest';
import { normalizeFrontmatter, normalizeValue } from './normalize';
import type { Scalar } from './types';

describe('normalizeValue', () => {
  const cases: [string, unknown, Scalar | Scalar[]][] = [
    ['trims strings', '  hello  ', 'hello'],
    ['empty string becomes null', '', null],
    ['whitespace-only string becomes null', '   ', null],
    ['numbers pass through', 42, 42],
    ['booleans pass through', true, true],
    ['null stays null', null, null],
    ['undefined becomes null', undefined, null],
    ['date-like strings stay strings', '2026-07-24', '2026-07-24'],
    ['Date instances become ISO date strings', new Date(Date.UTC(2026, 6, 24)), '2026-07-24'],
    ['arrays normalize per element', ['a ', '', 3], ['a', null, 3]],
    ['plain objects have no scalar form', { nested: true }, null],
  ];

  it.each(cases)('%s', (_name, value, expected) => {
    expect(normalizeValue(value)).toEqual(expected);
  });
});

describe('normalizeFrontmatter', () => {
  it('splits wikilink values into relationships and scalars into properties', () => {
    const result = normalizeFrontmatter({
      type: 'Work item',
      project: '[[flight-deck]]',
      blockers: ['[[a]]', '[[b|B]]'],
      status: ' doing ',
      estimate: '',
      count: 3,
      tags: ['infra ', 'sensor'],
    });
    expect(result.relationships).toEqual({
      project: ['flight-deck'],
      blockers: ['a', 'b'],
    });
    expect(result.properties).toEqual({
      status: 'doing',
      estimate: null,
      count: 3,
      tags: ['infra', 'sensor'],
    });
  });

  it('passes nested mappings through untouched for schema.ts to parse', () => {
    const statuses = [{ id: 'todo', group: 'active', color: '#3D8BE8' }];
    const fields = { status: { kind: 'status' } };
    const result = normalizeFrontmatter({ statuses, fields });
    expect(result.properties.statuses).toBe(statuses);
    expect(result.properties.fields).toBe(fields);
  });

  it('excludes the type key — Entry.type is extracted separately', () => {
    expect(normalizeFrontmatter({ type: 'Space' }).properties).toEqual({});
  });
});
