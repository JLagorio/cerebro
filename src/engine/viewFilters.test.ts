import { describe, expect, it } from 'vitest';
import {
  coerceOpForKind,
  coerceRuleToOp,
  describeFilterRule,
  evaluateFilters,
  filterFieldDefs,
  filterOpsFor,
  filterStatusSet,
  limitEntries,
  searchEntries,
  seedFilterRule,
} from './viewFilters';
import { buildSchema } from './schema';
import { makeEntry } from './testHelpers';
import { parseListYaml, serializeList } from './views';
import { FIELD_KINDS, FILTER_OPS } from './types';
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
    weight: 10,
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

/**
 * M16.25 added ten operators. Each case here is one of them doing the thing
 * the builder now offers, because the previous nine were the ONLY nine the
 * builder had and every one of them was offered on every kind.
 */
describe('evaluateFilters — the M16.25 operators', () => {
  const cases: [string, FilterRule, boolean][] = [
    [
      'does_not_contain passes when the substring is absent',
      { field: 'title', op: 'does_not_contain', value: 'zzz' },
      true,
    ],
    [
      'does_not_contain rejects when it is present',
      { field: 'tags', op: 'does_not_contain', value: 'infra' },
      false,
    ],
    [
      // Notion agrees, and the alternative drops every blank record from an
      // exclusion the user wrote about one specific value.
      'does_not_contain passes for a record with no value at all',
      { field: 'owner', op: 'does_not_contain', value: 'infra' },
      true,
    ],
    ['starts_with matches a prefix', { field: 'title', op: 'starts_with', value: 'cali' }, true],
    [
      'starts_with rejects a mid-string match',
      { field: 'title', op: 'starts_with', value: 'sensors' },
      false,
    ],
    ['ends_with matches a suffix', { field: 'title', op: 'ends_with', value: 'sensors' }, true],
    ['gt orders numerically, not lexically', { field: 'weight', op: 'gt', value: 9 }, true],
    ['lt orders numerically, not lexically', { field: 'weight', op: 'lt', value: 9 }, false],
    ['gte accepts the bound itself', { field: 'weight', op: 'gte', value: 10 }, true],
    ['lte accepts the bound itself', { field: 'weight', op: 'lte', value: 10 }, true],
    [
      'is_between is inclusive at both ends',
      { field: 'weight', op: 'is_between', value: [10, 20] },
      true,
    ],
    [
      'is_between rejects outside the range',
      { field: 'weight', op: 'is_between', value: [11, 20] },
      false,
    ],
    [
      'is_between spans dates too',
      { field: 'due', op: 'is_between', value: ['2026-07-01', '2026-08-31'] },
      true,
    ],
    [
      'on_or_before accepts the day itself',
      { field: 'due', op: 'on_or_before', value: '2026-08-01' },
      true,
    ],
    [
      'on_or_after accepts the day itself',
      { field: 'due', op: 'on_or_after', value: '2026-08-01' },
      true,
    ],
  ];

  it.each(cases)('%s', (_name, rule, expected) => {
    expect(evaluateFilters(entry, wrap(rule), schema)).toBe(expected);
  });

  /**
   * The M16.14 regression: a date property may store `YYYY-MM-DD HH:MM`, and
   * the ordered operators compared RAW STRINGS. `'2026-08-03 09:15'` sorts
   * after `'2026-08-03'`, so a record due that morning was reported as "after
   * 2026-08-03" — the day it is on. A rule that names no time means the day.
   */
  it('a rule with no time compares by day, whatever time the value carries', () => {
    const timed = makeEntry({
      path: 'items/fld-9.md',
      filename: 'fld-9.md',
      title: 'Standup',
      type: 'Work item',
      properties: { due: '2026-08-03 09:15' },
    });
    const at = (op: FilterRule['op'], value: string) =>
      evaluateFilters(timed, wrap({ field: 'due', op, value }), schema);
    expect(at('after', '2026-08-03')).toBe(false);
    expect(at('before', '2026-08-03')).toBe(false);
    expect(at('on_or_after', '2026-08-03')).toBe(true);
    expect(at('on_or_before', '2026-08-03')).toBe(true);
    expect(at('equals', '2026-08-03')).toBe(true);
    // A rule that DOES name a time gets the finer comparison it asked for.
    expect(at('after', '2026-08-03 09:00')).toBe(true);
    expect(at('before', '2026-08-03 09:00')).toBe(false);
  });

  /**
   * Every value editor that is a text box hands the engine a STRING. `is`
   * was strict `===`, so "Estimate is 5" never matched the number 5 that the
   * frontmatter actually holds — the rule looked right and matched nothing.
   */
  it('is compares a typed "5" against the stored number 5', () => {
    expect(
      evaluateFilters(entry, wrap({ field: 'weight', op: 'equals', value: '10' }), schema),
    ).toBe(true);
    expect(
      evaluateFilters(entry, wrap({ field: 'weight', op: 'not_equals', value: '10' }), schema),
    ).toBe(false);
  });

  it('a daterange is compared by the day it starts', () => {
    const ranged = makeEntry({
      path: 'items/fld-10.md',
      filename: 'fld-10.md',
      title: 'Sprint',
      type: 'Work item',
      properties: { window: { start: '2026-08-05', end: '2026-08-12' } as never },
    });
    expect(
      evaluateFilters(ranged, wrap({ field: 'window', op: 'after', value: '2026-08-01' }), schema),
    ).toBe(true);
    expect(
      evaluateFilters(ranged, wrap({ field: 'window', op: 'after', value: '2026-08-06' }), schema),
    ).toBe(false);
  });
});

/**
 * M16.29 regression: a half-built rule emptied the view.
 *
 * Reproduced live — Table → Filter → pick `Due` → change the operator to "is
 * before", and before any date has been picked the grid drops to "Nothing
 * matches these filters" and the row count goes 45 → 0. `compareValues`
 * returns null for an empty target, so every ordered operator answered false
 * for every record, and the surface that was supposed to be MID-EDIT looked
 * broken instead.
 *
 * The invariant: a rule that cannot be evaluated yet does not filter at all.
 * `is_empty`/`is_not_empty` are the asymmetry to preserve — they need no
 * value, so they must keep applying the instant they are chosen.
 */
describe('evaluateFilters — a rule missing its value is inert (M16.29)', () => {
  const inert: [string, FilterRule][] = [
    ['before with no value at all', { field: 'due', op: 'before' }],
    ['before with the empty string the editor seeds', { field: 'due', op: 'before', value: '' }],
    ['after with no value', { field: 'due', op: 'after', value: '' }],
    ['equals with no value', { field: 'status', op: 'equals', value: '' }],
    ['contains with no needle', { field: 'title', op: 'contains', value: '' }],
    ['gt with no bound', { field: 'weight', op: 'gt', value: '' }],
    ['any_of with nothing selected', { field: 'status', op: 'any_of', value: [] }],
    ['is_between with neither bound', { field: 'weight', op: 'is_between', value: ['', ''] }],
    ['is_between with only the low bound', { field: 'weight', op: 'is_between', value: [10, ''] }],
    ['is_between with only the high bound', { field: 'weight', op: 'is_between', value: ['', 20] }],
  ];

  it.each(inert)('%s keeps the record', (_name, rule) => {
    expect(evaluateFilters(entry, wrap(rule), schema)).toBe(true);
  });

  it('still filters the moment the value arrives', () => {
    expect(
      evaluateFilters(entry, wrap({ field: 'due', op: 'before', value: '2026-07-01' }), schema),
    ).toBe(false);
  });

  /** The asymmetry: these two operators are COMPLETE with no value. */
  it('is_empty and is_not_empty apply immediately, valueless as they are', () => {
    expect(evaluateFilters(entry, wrap({ field: 'status', op: 'is_empty' }), schema)).toBe(false);
    expect(evaluateFilters(entry, wrap({ field: 'estimate', op: 'is_not_empty' }), schema)).toBe(
      false,
    );
  });

  /**
   * `0` and `false` are values. Treating "absent" as falsy would make
   * "Weight is 0" and "Done is unchecked" silently stop filtering — the same
   * class of bug in the opposite direction.
   */
  it('zero and false are values, not absence', () => {
    expect(evaluateFilters(entry, wrap({ field: 'weight', op: 'equals', value: 0 }), schema)).toBe(
      false,
    );
    const flagged = makeEntry({
      path: 'items/fld-11.md',
      filename: 'fld-11.md',
      title: 'Flagged',
      type: 'Work item',
      properties: { done: false as never },
    });
    expect(
      evaluateFilters(flagged, wrap({ field: 'done', op: 'equals', value: false }), schema),
    ).toBe(true);
  });

  /**
   * Inside Match-any the half-built rule is skipped rather than counted as a
   * failed branch — a `some()` over one unbuilt condition is false, which is
   * how the nested group on the demo vault's "At risk" list emptied the whole
   * view while its sibling condition was still fine.
   */
  it('a Match-any group whose only condition is half-built constrains nothing', () => {
    const group: FilterGroup = {
      all: [
        { field: 'type', op: 'equals', value: 'Work item' },
        { any: [{ field: 'due', op: 'before', value: '' }] },
      ],
    };
    expect(evaluateFilters(entry, group, schema)).toBe(true);
  });

  it('a Match-any group still answers on the conditions that ARE built', () => {
    const group: FilterGroup = {
      any: [
        { field: 'status', op: 'equals', value: 'blocked' },
        { field: 'due', op: 'before', value: '' },
      ],
    };
    expect(evaluateFilters(entry, group, schema)).toBe(false);
  });

  /**
   * An AUTHORED empty group is a different thing from a half-built rule, and
   * the builder already warns in those words ("Match any with nothing to match
   * hides every record"). Pruning must not quietly make that warning false.
   */
  it('an authored empty any group still matches nothing', () => {
    expect(evaluateFilters(entry, { any: [] }, schema)).toBe(false);
  });
});

describe('filterOpsFor — operators are a property of the KIND (M16.25)', () => {
  it('a date gets the date operators and none of the numeric ones', () => {
    const ops = filterOpsFor('date');
    expect(ops).toContain('on_or_before');
    expect(ops).toContain('is_between');
    expect(ops).not.toContain('gt');
    expect(ops).not.toContain('starts_with');
  });

  it('a number gets the comparisons and not the string ones', () => {
    const ops = filterOpsFor('number');
    expect(ops).toContain('gt');
    expect(ops).toContain('is_between');
    expect(ops).not.toContain('contains');
  });

  it('a select gets the set operators; text does not', () => {
    expect(filterOpsFor('select')).toContain('any_of');
    expect(filterOpsFor('text')).not.toContain('any_of');
    expect(filterOpsFor('text')).toContain('starts_with');
  });

  it('a rollup offers everything, because its kind cannot say what it holds', () => {
    expect(filterOpsFor('rollup')).toHaveLength(FILTER_OPS.length);
  });

  /**
   * The catalog is derived from `KIND_META.filters`, which `satisfies
   * Record<FieldKind, …>` forces every kind to declare. This is the runtime
   * half: a family whose operator list went empty would leave a kind with an
   * operator menu that cannot be opened.
   */
  it('every kind offers at least the two universal operators', () => {
    for (const kind of FIELD_KINDS) {
      const ops = filterOpsFor(kind);
      expect(ops).toContain('is_empty');
      expect(ops).toContain('is_not_empty');
      expect(new Set(ops).size).toBe(ops.length);
    }
  });

  /**
   * Every surface seeds a starter rule, and the seed must exclude nothing —
   * the M15 bug where "Add filter" blanked the canvas before the user had
   * chosen anything. That only holds if `is_not_empty` is reachable on every
   * kind, which is why `boolean` keeps it despite Notion's checkbox filter
   * being is/is-not only.
   */
  it('the seeded rule is non-exclusionary on every kind', () => {
    for (const kind of FIELD_KINDS) {
      expect(seedFilterRule('x', kind).op).toBe('is_not_empty');
    }
  });

  it('an operator the new kind cannot express falls back instead of sticking', () => {
    expect(coerceOpForKind('gt', 'select')).toBe('is_not_empty');
    expect(coerceOpForKind('any_of', 'select')).toBe('any_of');
  });
});

/**
 * Switching operator used to leave the old value behind: `is any of ["a","b"]`
 * became `is ["a","b"]`, which matched nothing, and switching to `is empty`
 * left a dead `value` in the YAML.
 */
describe('coerceRuleToOp reshapes the value to the new operator', () => {
  it('drops the value for a valueless operator', () => {
    const next = coerceRuleToOp({ field: 'a', op: 'equals', value: 'x' }, 'is_empty');
    expect('value' in next).toBe(false);
  });
  it('collapses a list to its first element for a single-value operator', () => {
    expect(coerceRuleToOp({ field: 'a', op: 'any_of', value: ['x', 'y'] }, 'equals').value).toBe(
      'x',
    );
  });
  it('promotes a scalar to a list for a set operator', () => {
    expect(coerceRuleToOp({ field: 'a', op: 'equals', value: 'x' }, 'any_of').value).toEqual(['x']);
  });
  it('pads to two bounds for is_between', () => {
    expect(coerceRuleToOp({ field: 'a', op: 'equals', value: 5 }, 'is_between').value).toEqual([
      5,
      '',
    ]);
  });
});

describe('describeFilterRule — what a chip says', () => {
  it('reads as a sentence', () => {
    expect(describeFilterRule({ field: 'due', op: 'before', value: '2026-08-01' }, 'Due')).toBe(
      'Due is before 2026-08-01',
    );
  });
  it('names both bounds of a range', () => {
    expect(describeFilterRule({ field: 'n', op: 'is_between', value: [1, 5] }, 'N')).toBe(
      'N is between 1 and 5',
    );
  });
  it('says the value is missing rather than pretending it is empty string', () => {
    expect(describeFilterRule({ field: 'due', op: 'after' }, 'Due')).toBe('Due is after…');
  });
  it('omits the value entirely for a valueless operator', () => {
    expect(describeFilterRule({ field: 'due', op: 'is_empty' }, 'Due')).toBe('Due is empty');
  });
});

/**
 * M16.29 regression: the filter's Status conditions were plain text boxes
 * holding the raw ids `progress` and `review`.
 *
 * A `status` field declares no `options:` — its option set is the TYPE's
 * `statuses:`, which every OTHER surface resolves per record through
 * `schema.statusSetFor`. A filter has no record, so `def.options` was empty
 * and the typed value editor fell through to its text-box last resort. It
 * looked like a nesting bug because the one rule that DID get a picker was
 * `priority`, a `select` that declares its own options.
 */
describe('a filter offers a status field its type’s statuses (M16.29)', () => {
  const statuses = [
    { id: 'progress', label: 'In progress', color: '#DE8F0A', group: 'active' as const },
    { id: 'review', label: 'Review', color: '#38BDF8', group: 'active' as const },
  ];

  it('fills in the options a status field cannot declare', () => {
    const [status, priority] = filterFieldDefs(
      [
        { name: 'status', kind: 'status' },
        { name: 'priority', kind: 'select', options: [{ id: 'high', label: 'High', color: null }] },
      ],
      statuses,
    );
    expect(status.options?.map((o) => o.label)).toEqual(['In progress', 'Review']);
    // A field that HAS options keeps them — the status set is a fallback for
    // the kind that cannot carry its own, not an override.
    expect(priority.options?.map((o) => o.id)).toEqual(['high']);
  });

  it('leaves every other kind alone', () => {
    const fields = [
      { name: 'due', kind: 'date' as const },
      { name: 'title', kind: 'text' as const },
    ];
    expect(filterFieldDefs(fields, statuses)).toEqual(fields);
  });

  it('carries the extra keys a ColumnDef adds', () => {
    const [col] = filterFieldDefs([{ name: 'status', kind: 'status', heterogeneous: true }], []);
    expect(col.heterogeneous).toBe(true);
  });

  /**
   * The chain `statusSetFor` walks, minus the per-RECORD project override — a
   * view-level filter has no record to resolve one against.
   */
  describe('filterStatusSet', () => {
    const typed = makeEntry({
      path: 'types/work-item.md',
      filename: 'work-item.md',
      title: 'Work item',
      type: 'Type',
      properties: {
        fields: { status: { kind: 'status' } } as never,
        statuses: [{ id: 'progress', group: 'active' }] as never,
      },
    });
    const typeSchema = buildSchema([typed]);

    it('prefers the type’s own statuses', () => {
      expect(filterStatusSet(typeSchema, 'Work item').map((s) => s.id)).toEqual(['progress']);
    });

    it('falls back to the app defaults for a type that declares none', () => {
      const bare = buildSchema([
        makeEntry({
          path: 'types/note.md',
          filename: 'note.md',
          title: 'Note',
          type: 'Type',
          properties: {},
        }),
      ]);
      expect(filterStatusSet(bare, 'Note').length).toBeGreaterThan(0);
    });

    /** A typeless ("Everything") view has no one status set to offer. */
    it('offers nothing when the view has no source type', () => {
      expect(filterStatusSet(typeSchema, null)).toEqual([]);
      expect(filterStatusSet(undefined, 'Work item')).toEqual([]);
    });
  });
});

/**
 * The worst failure this surface can have is a view that silently loses a
 * condition, so the round trip is asserted rather than assumed (M16.29).
 *
 * Note especially that the M16.29 inertness rule is an EVALUATION rule: a
 * half-built condition still persists, so reopening the view finds the rule
 * where you left it rather than an empty filter bar.
 */
describe('a saved filter survives YAML', () => {
  // The demo vault's "At risk" list, verbatim: a top-level set operator beside
  // a nested Match-any group — the shape the chip bar renders as one chip plus
  // "2 conditions".
  const yaml = [
    'name: At risk',
    'source:',
    '  type: Work item',
    'filters:',
    '  all:',
    '    - field: priority',
    '      op: any_of',
    '      value:',
    '        - urgent',
    '        - high',
    '    - any:',
    '        - field: status',
    '          op: equals',
    '          value: progress',
    '        - field: status',
    '          op: equals',
    '          value: review',
    '    - field: due',
    '      op: before',
    '    - field: estimate',
    '      op: is_empty',
    'presentation:',
    '  type: table',
    '',
  ].join('\n');

  const filtersOf = (text: string) => parseListYaml('at-risk', text).definition.views[0].filters;

  it('re-reads as the same tree it was written from', () => {
    const first = filtersOf(yaml);
    const rewritten = filtersOf(serializeList(parseListYaml('at-risk', yaml).definition));
    expect(rewritten).toEqual(first);
  });

  it('keeps the nested group, its two conditions, and the valueless ones', () => {
    const group = filtersOf(serializeList(parseListYaml('at-risk', yaml).definition));
    expect(group).toEqual({
      all: [
        { field: 'priority', op: 'any_of', value: ['urgent', 'high'] },
        {
          any: [
            { field: 'status', op: 'equals', value: 'progress' },
            { field: 'status', op: 'equals', value: 'review' },
          ],
        },
        { field: 'due', op: 'before' },
        { field: 'estimate', op: 'is_empty' },
      ],
    });
  });
});

describe('searchEntries (M16.26)', () => {
  const corpus = [
    entry,
    makeEntry({
      path: 'items/fld-3.md',
      filename: 'fld-3.md',
      title: 'Wire the harness',
      type: 'Work item',
      properties: { status: 'todo' },
      relationships: { assignee: ['bo-riis'] },
    }),
  ];

  it('matches the title', () => {
    expect(searchEntries(corpus, 'harness').map((e) => e.title)).toEqual(['Wire the harness']);
  });
  it('matches a property value and a relationship target', () => {
    expect(searchEntries(corpus, 'bo-riis')).toHaveLength(1);
    expect(searchEntries(corpus, 'infra')).toHaveLength(1);
  });
  /**
   * ANDed, not ORed. A two-word query that ORs its terms returns MORE rows
   * than either word alone, which reads on screen as the search being broken.
   */
  it('requires every term, in any field', () => {
    expect(searchEntries(corpus, 'calibrate sensors')).toHaveLength(1);
    expect(searchEntries(corpus, 'calibrate harness')).toHaveLength(0);
  });
  it('an empty query is not a filter', () => {
    expect(searchEntries(corpus, '   ')).toHaveLength(2);
  });
});

describe('limitEntries (M16.26)', () => {
  const ten = Array.from({ length: 10 }, (_, i) => i);
  it('takes the first n', () => {
    expect(limitEntries(ten, 3)).toEqual([0, 1, 2]);
  });
  it('an absent limit shows everything', () => {
    expect(limitEntries(ten, undefined)).toHaveLength(10);
  });
  /**
   * A hand-edited `limit: 0` would otherwise render an empty canvas that no
   * control on screen explains, and the only fix would be to edit the YAML
   * back by hand.
   */
  it('a nonsense limit is ignored rather than emptying the view', () => {
    expect(limitEntries(ten, 0)).toHaveLength(10);
    expect(limitEntries(ten, -5)).toHaveLength(10);
  });
});
