import { describe, expect, it } from 'vitest';
import { evaluateFilters } from './viewFilters';
import { buildSchema } from './schema';
import { makeEntry } from './testHelpers';
import type { FilterGroup, FilterRule } from './types';

const entry = makeEntry({
  path: 'items/fld-2.md',
  filename: 'fld-2.md',
  title: 'Calibrate sensors',
  type: 'Work item',
  properties: {
    status: 'doing',
    priority: 'high',
    due: '2026-08-01',
    estimate: '',
    parent: null,
    tags: ['infra', 'sensor'],
    watchers: [],
  },
  relationships: { assignee: ['ana-marte'], project: ['flight-deck'] },
});

const schema = buildSchema([entry]);

const wrap = (rule: FilterRule): FilterGroup => ({ all: [rule] });

describe('evaluateFilters — single ops', () => {
  const cases: [string, FilterRule, boolean][] = [
    ['equals matches a scalar property', { field: 'status', op: 'equals', value: 'doing' }, true],
    ['equals rejects a different scalar', { field: 'status', op: 'equals', value: 'done' }, false],
    [
      'equals matches membership in a relationship array',
      { field: 'assignee', op: 'equals', value: 'ana-marte' },
      true,
    ],
    [
      'equals matches membership in an array property',
      { field: 'tags', op: 'equals', value: 'infra' },
      true,
    ],
    ['equals matches the entry type', { field: 'type', op: 'equals', value: 'Work item' }, true],
    [
      'not_equals passes for a different value',
      { field: 'status', op: 'not_equals', value: 'done' },
      true,
    ],
    [
      'not_equals rejects the matching value',
      { field: 'status', op: 'not_equals', value: 'doing' },
      false,
    ],
    [
      'contains is a case-insensitive substring',
      { field: 'title', op: 'contains', value: 'SENS' },
      true,
    ],
    ['contains checks each array element', { field: 'tags', op: 'contains', value: 'ensor' }, true],
    ['contains rejects a non-substring', { field: 'title', op: 'contains', value: 'zzz' }, false],
    [
      'any_of matches when the value is in the set',
      { field: 'status', op: 'any_of', value: ['todo', 'doing'] },
      true,
    ],
    [
      'any_of rejects when the value is not in the set',
      { field: 'status', op: 'any_of', value: ['todo', 'done'] },
      false,
    ],
    ['any_of intersects array values', { field: 'tags', op: 'any_of', value: ['sensor'] }, true],
    [
      'none_of rejects an intersection',
      { field: 'assignee', op: 'none_of', value: ['ana-marte'] },
      false,
    ],
    [
      'none_of passes with no intersection',
      { field: 'status', op: 'none_of', value: ['done', 'cancelled'] },
      true,
    ],
    [
      'none_of passes on a missing field',
      { field: 'owner', op: 'none_of', value: ['ana-marte'] },
      true,
    ],
    [
      'before uses strict ISO string compare',
      { field: 'due', op: 'before', value: '2026-09-01' },
      true,
    ],
    ['before rejects the same date', { field: 'due', op: 'before', value: '2026-08-01' }, false],
    [
      'before rejects a missing field',
      { field: 'owner', op: 'before', value: '2026-09-01' },
      false,
    ],
    ['after passes for an earlier bound', { field: 'due', op: 'after', value: '2026-07-01' }, true],
    ['after rejects the same date', { field: 'due', op: 'after', value: '2026-08-01' }, false],
    ['is_empty on an empty string', { field: 'estimate', op: 'is_empty' }, true],
    ['is_empty on a null value', { field: 'parent', op: 'is_empty' }, true],
    ['is_empty on a missing key', { field: 'owner', op: 'is_empty' }, true],
    ['is_empty on an empty array', { field: 'watchers', op: 'is_empty' }, true],
    ['is_empty rejects a present value', { field: 'status', op: 'is_empty' }, false],
    ['is_not_empty on a present value', { field: 'status', op: 'is_not_empty' }, true],
    ['is_not_empty on a relationship', { field: 'assignee', op: 'is_not_empty' }, true],
    ['is_not_empty rejects an empty string', { field: 'estimate', op: 'is_not_empty' }, false],
  ];

  it.each(cases)('%s', (_name, rule, expected) => {
    expect(evaluateFilters(entry, wrap(rule), schema)).toBe(expected);
  });
});

describe('evaluateFilters — groups', () => {
  it('evaluates nested all/any groups', () => {
    const group: FilterGroup = {
      all: [
        { field: 'type', op: 'equals', value: 'Work item' },
        {
          any: [
            { field: 'status', op: 'equals', value: 'blocked' },
            { field: 'priority', op: 'equals', value: 'high' },
          ],
        },
      ],
    };
    expect(evaluateFilters(entry, group, schema)).toBe(true);
  });

  it('fails an all group when one branch fails', () => {
    const group: FilterGroup = {
      all: [
        { field: 'type', op: 'equals', value: 'Work item' },
        { field: 'status', op: 'equals', value: 'blocked' },
      ],
    };
    expect(evaluateFilters(entry, group, schema)).toBe(false);
  });

  it('an empty all group matches everything', () => {
    expect(evaluateFilters(entry, { all: [] }, schema)).toBe(true);
  });

  it('an empty any group matches nothing', () => {
    expect(evaluateFilters(entry, { any: [] }, schema)).toBe(false);
  });
});
