import type { FieldKind, FilterFamily, FilterOp, FilterRule } from '@/engine/types';

/** Independently stated readings, never produced by the evaluator or a parser. */
export interface Reading {
  raw: unknown;
  text?: string;
  number?: number;
  day?: string;
  minute?: string;
  range?: readonly [string, string];
  losAngeles?: { day: string; minute: string };
}
export interface OracleValue {
  id: string;
  raw: unknown;
  items: Reading[];
  absent: boolean;
  /** A computed field's input, distinct from its independently stated result. */
  input?: unknown;
}
export interface OracleTarget {
  raw: FilterRule['value'];
  items: Reading[];
}
export interface KindCase {
  name: string;
  family: FilterFamily;
  values: OracleValue[];
  compute?: 'max' | 'earliest' | 'show' | 'n * 1' | 'd + 0';
}

const read = (raw: unknown, facts: Omit<Reading, 'raw'> = {}): Reading => ({ raw, ...facts });
const text = (raw: string, number?: number): Reading => read(raw, { text: raw, number });
const num = (raw: number): Reading => read(raw, { text: String(raw), number: raw });
const bool = (raw: boolean): Reading => read(raw, { text: raw ? 'true' : 'false' });
const day = (raw: string, date = raw, minute?: string): Reading =>
  read(raw, { text: raw, day: date, minute });
const instant = (raw: string, utcDay: string, utcTime: string, laDay: string, laTime: string) =>
  read(raw, {
    text: raw,
    day: utcDay,
    minute: `${utcDay} ${utcTime}`,
    losAngeles: { day: laDay, minute: `${laDay} ${laTime}` },
  });
const value = (id: string, item: Reading, input?: unknown): OracleValue => ({
  id,
  raw: item.raw,
  items: [item],
  absent: item.raw === undefined || item.raw === null || item.raw === '',
  input,
});
const list = (id: string, items: Reading[]): OracleValue => ({
  id,
  raw: items.map((item) => item.raw),
  items,
  absent: items.length === 0,
});
const target = (item: Reading): OracleTarget => ({
  raw: item.raw as FilterRule['value'],
  items: [item],
});
const targets = (items: Reading[]): OracleTarget => ({
  raw: items.map((item) => item.raw) as FilterRule['value'],
  items,
});

export const ABSENT_VALUES = [
  value('missing', read(undefined)),
  value('null', read(null)),
  value('empty', text('')),
  list('empty-list', []),
];
const TEXT_VALUES = [
  ...ABSENT_VALUES,
  ...['Alpha', 'alpha', 'ALPHA beta', 'beta', ' ', '0x5'].map((s, i) =>
    value(`text-${i}`, text(s)),
  ),
  value('decimal', text('5', 5)),
  value('padded-zero', text('05', 5)),
  value('padded', text(' 5 ', 5)),
  value('zero', num(0)),
  value('five', num(5)),
  value('true', bool(true)),
  list('two-words', [text('Beta'), text('gamma')]),
  list('empty-item', [text('')]),
  value('mapping', read({ a: 1 })),
  list('nested-list', [read(['alpha'])]),
  value('day', day('2026-07-28')),
  value('time', day('2026-07-28 14:30', '2026-07-28', '2026-07-28 14:30')),
];
const NUMBER_VALUES = [
  ...ABSENT_VALUES,
  ...[0, -1, 1.5, 5, 10].map((n) => value(`number-${n}`, num(n))),
  value('decimal', text('5', 5)),
  value('leading-zero', text('05', 5)),
  value('padded', text(' 5 ', 5)),
  value('exponent', text('1e1', 10)),
  ...[' ', '0x10', 'Infinity', 'abc'].map((s, i) => value(`not-number-${i}`, text(s))),
  value('true', bool(true)),
  list('two-numbers', [num(5), num(1)]),
  value('date', day('2026-07-28')),
];
const DATE_VALUES = [
  ...ABSENT_VALUES,
  ...['2026-07-25', '2026-07-27', '2026-07-28', '2026-07-29', '2026-08-01', '2026-08-02'].map((s) =>
    value(s, day(s)),
  ),
  value('time', day('2026-07-28 14:30', '2026-07-28', '2026-07-28 14:30')),
  value('instant', instant('2026-07-28T23:30:00Z', '2026-07-28', '23:30', '2026-07-28', '16:30')),
  value('prose', text('prose')),
  value('invalid', text('2026-02-30')),
  value('number', num(5)),
  value('boolean', bool(true)),
  value('range', read({ start: '2026-07-27', end: '2026-07-29' }, { day: '2026-07-27' })),
  value(
    'timed-range',
    read(
      { start: '2026-07-28 09:00', end: '2026-07-28 10:00' },
      { day: '2026-07-28', minute: '2026-07-28 09:00' },
    ),
  ),
  value('missing-start', read({ start: '', end: '2026-07-30' })),
];
const STAMP_VALUES = [
  ...ABSENT_VALUES,
  value('before', instant('2026-07-27T12:00:00Z', '2026-07-27', '12:00', '2026-07-27', '05:00')),
  value(
    'zone-boundary',
    instant('2026-07-28T00:30:00Z', '2026-07-28', '00:30', '2026-07-27', '17:30'),
  ),
  value('today', instant('2026-07-28T12:00:00Z', '2026-07-28', '12:00', '2026-07-28', '05:00')),
  value('tomorrow', instant('2026-07-29T12:00:00Z', '2026-07-29', '12:00', '2026-07-29', '05:00')),
  value('week-end', instant('2026-08-01T07:30:00Z', '2026-08-01', '07:30', '2026-08-01', '00:30')),
];
const LINK_VALUES = [
  ...ABSENT_VALUES,
  list('one-person', [text('ana-marte')]),
  list('two-people', [text('ana-marte'), text('ben-ito')]),
  list('label', [text('Ana Marte')]),
  value('plain-property', text('ana-marte')),
];
const computedAbsent = ABSENT_VALUES.map((v) => value(v.id, read(undefined), v.raw));
const computedNumbers = [
  ...computedAbsent,
  ...[3, 12.5, -2, 0].map((n) => value(`computed-${n}`, num(n), n)),
];
const computedDates = [...computedAbsent, value('computed-date', day('2026-07-28'), '2026-07-28')];

export const KIND_CASES = {
  text: [{ name: 'stored', family: 'text', values: TEXT_VALUES }],
  number: [{ name: 'stored', family: 'number', values: NUMBER_VALUES }],
  checkbox: [
    {
      name: 'stored',
      family: 'boolean',
      values: [
        ...ABSENT_VALUES,
        value('true', bool(true)),
        value('false', bool(false)),
        value('word-true', text('true')),
        value('word-yes', text('yes')),
        value('one', num(1)),
        value('zero', num(0)),
        list('list', [bool(true)]),
      ],
    },
  ],
  date: [{ name: 'stored', family: 'date', values: DATE_VALUES }],
  daterange: [{ name: 'stored', family: 'date', values: DATE_VALUES }],
  select: [
    {
      name: 'stored',
      family: 'choice',
      values: [
        ...ABSENT_VALUES,
        ...['high', 'HIGH', 'low', 'ghost'].map((s) => value(s, text(s))),
        list('list', [text('high')]),
        value('five', num(5)),
        value('word-five', text('5', 5)),
      ],
    },
  ],
  multiselect: [
    {
      name: 'stored',
      family: 'multi',
      values: [
        ...ABSENT_VALUES,
        list('one', [text('infra')]),
        list('two', [text('infra'), text('sensor')]),
        list('capital', [text('Infra')]),
        value('scalar', text('infra')),
        list('ghost', [text('ghost')]),
        list('empty-item', [text('')]),
      ],
    },
  ],
  status: [
    {
      name: 'stored',
      family: 'choice',
      values: [
        ...ABSENT_VALUES,
        ...['todo', 'doing', 'done', 'cancelled', 'wip'].map((s) => value(s, text(s))),
      ],
    },
  ],
  person: [{ name: 'stored', family: 'multi', values: LINK_VALUES }],
  relation: [{ name: 'stored', family: 'multi', values: LINK_VALUES }],
  url: [
    {
      name: 'stored',
      family: 'text',
      values: [...TEXT_VALUES, value('url', text('https://example.com/alpha'))],
    },
  ],
  email: [
    {
      name: 'stored',
      family: 'text',
      values: [...TEXT_VALUES, value('email', text('alpha@example.com'))],
    },
  ],
  phone: [
    {
      name: 'stored',
      family: 'text',
      values: [...TEXT_VALUES, value('phone', text('+1 (415) 555-0100'))],
    },
  ],
  files: [
    {
      name: 'stored',
      family: 'multi',
      values: [
        ...ABSENT_VALUES,
        list('one', [text('attachments/alpha.png')]),
        list('two', [text('attachments/alpha.png'), text('attachments/beta.pdf')]),
        list('empty-item', [text('')]),
      ],
    },
  ],
  rollup: [
    { name: 'maximum', family: 'any', values: computedNumbers, compute: 'max' },
    { name: 'earliest', family: 'any', values: computedDates, compute: 'earliest' },
    {
      name: 'show',
      family: 'any',
      values: [...computedAbsent, value('show', text('alpha'), 'alpha')],
      compute: 'show',
    },
  ],
  created_time: [{ name: 'stamp', family: 'date', values: STAMP_VALUES }],
  last_edited_time: [{ name: 'stamp', family: 'date', values: STAMP_VALUES }],
  formula: [
    { name: 'number', family: 'any', values: computedNumbers, compute: 'n * 1' },
    { name: 'date', family: 'any', values: computedDates, compute: 'd + 0' },
  ],
  repeat: [
    {
      name: 'stored',
      family: 'text',
      values: [...TEXT_VALUES, value('rule', text('FREQ=WEEKLY;BYDAY=MO,WE'))],
    },
  ],
} satisfies Record<FieldKind, KindCase[]>;

const TEXT_TARGETS = ['alpha', 'ALPHA', 'beta', 'a'].map((s) => target(text(s)));
TEXT_TARGETS.push(
  target(text('5', 5)),
  target(text('0', 0)),
  target(day('2026-07-28')),
  target(text('')),
);
const NUMBER_TARGETS = [
  target(num(5)),
  target(text('5', 5)),
  target(num(0)),
  target(num(-1)),
  target(num(1.5)),
  target(text('1e1', 10)),
];
const token = (raw: string, from: string, to = from) =>
  target(read(raw, { text: raw, range: [from, to] }));
const DATE_TARGETS = [
  target(day('2026-07-28')),
  target(day('2026-07-28 14:30', '2026-07-28', '2026-07-28 14:30')),
  target(instant('2026-07-28T00:30:00Z', '2026-07-28', '00:30', '2026-07-27', '17:30')),
  token('today', '2026-07-28'),
  token('yesterday', '2026-07-27'),
  token('tomorrow', '2026-07-29'),
  token('today-1', '2026-07-27'),
  token('today+4', '2026-08-01'),
  token('this_week', '2026-07-26', '2026-08-01'),
  token('last_week', '2026-07-19', '2026-07-25'),
  token('next_month', '2026-08-01', '2026-08-31'),
];
interface FamilyTargets {
  one: OracleTarget[];
  list: OracleTarget[];
  two: OracleTarget[];
}
const numberPairs = [
  targets([num(0), num(5)]),
  targets([num(5), num(0)]),
  targets([num(1.5), text('10', 10)]),
];
const datePairs = [
  targets([day('2026-07-27'), day('2026-07-28')]),
  targets([
    read('today-7', { range: ['2026-07-21', '2026-07-21'] }),
    read('today', { range: ['2026-07-28', '2026-07-28'] }),
  ]),
  targets([day('2026-07-29'), day('2026-07-27')]),
];
export const FAMILY_TARGETS = {
  text: { one: TEXT_TARGETS, list: [], two: [] },
  number: { one: NUMBER_TARGETS, list: [], two: numberPairs },
  date: { one: DATE_TARGETS, list: [], two: datePairs },
  choice: {
    one: ['high', 'HIGH', 'ghost', 'todo', 'doing', 'done', 'wip']
      .map((s) => target(text(s)))
      .concat(target(text('5', 5))),
    list: [
      targets([text('high'), text('low')]),
      targets([text('ghost')]),
      targets([text('5', 5)]),
      targets([]),
    ],
    two: [],
  },
  multi: {
    one: ['infra', 'INFRA', 'ana', 'ana-marte'].map((s) => target(text(s))),
    list: [
      targets([text('infra')]),
      targets([text('ana-marte')]),
      targets([text('ben-ito'), text('ghost')]),
      targets([]),
    ],
    two: [],
  },
  boolean: {
    one: [target(bool(true)), target(bool(false)), target(text('true'))],
    list: [],
    two: [],
  },
  any: {
    one: [...NUMBER_TARGETS, ...DATE_TARGETS, ...TEXT_TARGETS],
    list: [targets([num(5), text('alpha')]), targets([])],
    two: [...numberPairs, ...datePairs],
  },
} satisfies Record<FilterFamily, FamilyTargets>;

export const ARITY = {
  equals: 'one',
  not_equals: 'one',
  contains: 'one',
  does_not_contain: 'one',
  starts_with: 'one',
  ends_with: 'one',
  any_of: 'list',
  none_of: 'list',
  gt: 'one',
  gte: 'one',
  lt: 'one',
  lte: 'one',
  before: 'one',
  after: 'one',
  on_or_before: 'one',
  on_or_after: 'one',
  is_between: 'two',
  is_empty: 'none',
  is_not_empty: 'none',
} satisfies Record<FilterOp, 'one' | 'two' | 'list' | 'none'>;

/** Zone readings are stated above; no clock or date parser is used here. */
export function inZone(item: Reading, zone: string): Reading {
  return zone === 'America/Los_Angeles' && item.losAngeles !== undefined
    ? { ...item, ...item.losAngeles }
    : item;
}
export function valuesInZone(values: OracleValue[], zone: string): OracleValue[] {
  return values.map((v) => ({ ...v, items: v.items.map((item) => inZone(item, zone)) }));
}
export function targetsFor(family: FilterFamily, op: FilterOp, zone: string): OracleTarget[] {
  const arity = ARITY[op];
  const source = arity === 'none' ? [{ raw: undefined, items: [] }] : FAMILY_TARGETS[family][arity];
  return source.map((t) => ({ ...t, items: t.items.map((item) => inZone(item, zone)) }));
}
function cmp(item: Reading | undefined, bound: Reading | undefined): number | null {
  if (
    item === undefined ||
    bound === undefined ||
    item.raw == null ||
    item.raw === '' ||
    bound.raw == null ||
    bound.raw === ''
  )
    return null;
  if (item.number !== undefined || bound.number !== undefined) {
    if (item.number === undefined || bound.number === undefined) return null;
    return item.number === bound.number ? 0 : item.number < bound.number ? -1 : 1;
  }
  if (bound.range !== undefined) {
    return item.day === undefined
      ? null
      : item.day < bound.range[0]
        ? -1
        : item.day > bound.range[1]
          ? 1
          : 0;
  }
  if (bound.day !== undefined) {
    if (item.day === undefined) return null;
    const left = bound.minute === undefined ? item.day : (item.minute ?? `${item.day} 00:00`);
    const right = bound.minute ?? bound.day;
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (item.text === undefined || bound.text === undefined) return null;
  return item.text === bound.text ? 0 : item.text < bound.text ? -1 : 1;
}
const equals = (v: OracleValue, t: OracleTarget) =>
  v.items.some((item) => {
    const bound = t.items[0];
    // A relative date names days, so invalid date prose cannot match its token.
    return (
      (bound?.range === undefined && item.raw != null && item.raw === t.raw) ||
      cmp(item, bound) === 0
    );
  });
const textMatches = (v: OracleValue, t: OracleTarget, test: (s: string, q: string) => boolean) => {
  const needle = t.items[0]?.text;
  return (
    needle !== undefined &&
    needle !== '' &&
    v.items.some(
      (item) => item.text !== undefined && test(item.text.toLowerCase(), needle.toLowerCase()),
    )
  );
};
const anyOf = (v: OracleValue, t: OracleTarget) =>
  v.items.some((item) => item.raw != null && t.items.some((bound) => item.raw === bound.raw));
const ordered = (v: OracleValue, t: OracleTarget, keep: (comparison: number) => boolean, i = 0) => {
  const comparison = cmp(v.items[0], t.items[i]);
  return comparison !== null && keep(comparison);
};
export const OP_RULES = {
  equals,
  not_equals: (v, t) => !equals(v, t),
  contains: (v, t) => textMatches(v, t, (s, q) => s.includes(q)),
  does_not_contain: (v, t) => !textMatches(v, t, (s, q) => s.includes(q)),
  starts_with: (v, t) => textMatches(v, t, (s, q) => s.startsWith(q)),
  ends_with: (v, t) => textMatches(v, t, (s, q) => s.endsWith(q)),
  any_of: anyOf,
  none_of: (v, t) => !anyOf(v, t),
  gt: (v, t) => ordered(v, t, (c) => c > 0),
  after: (v, t) => ordered(v, t, (c) => c > 0),
  gte: (v, t) => ordered(v, t, (c) => c >= 0),
  on_or_after: (v, t) => ordered(v, t, (c) => c >= 0),
  lt: (v, t) => ordered(v, t, (c) => c < 0),
  before: (v, t) => ordered(v, t, (c) => c < 0),
  lte: (v, t) => ordered(v, t, (c) => c <= 0),
  on_or_before: (v, t) => ordered(v, t, (c) => c <= 0),
  is_between: (v, t) => ordered(v, t, (c) => c >= 0) && ordered(v, t, (c) => c <= 0, 1),
  is_empty: (v) => v.absent,
  is_not_empty: (v) => !v.absent,
} satisfies Record<FilterOp, (value: OracleValue, target: OracleTarget) => boolean>;

export interface OracleCondition {
  op: FilterOp;
  target: OracleTarget;
}
export type OracleGroup =
  { all: (OracleCondition | OracleGroup)[] } | { any: (OracleCondition | OracleGroup)[] };
function ready(condition: OracleCondition): boolean {
  const arity = ARITY[condition.op];
  const present = (item: Reading | undefined) =>
    item !== undefined && item.raw != null && item.raw !== '';
  return (
    arity === 'none' ||
    (arity === 'two'
      ? present(condition.target.items[0]) && present(condition.target.items[1])
      : condition.target.items.some(present))
  );
}
export function oracleGroup(value: OracleValue, group: OracleGroup): boolean {
  const nodes = 'all' in group ? group.all : group.any;
  const live = nodes.filter((node) => !('op' in node) || ready(node));
  const run = (node: OracleCondition | OracleGroup): boolean =>
    'op' in node ? OP_RULES[node.op](value, node.target) : oracleGroup(value, node);
  return 'all' in group
    ? live.every(run)
    : (live.length === 0 && nodes.length > 0) || live.some(run);
}
export function oracleIds(values: OracleValue[], op: FilterOp, target: OracleTarget): string[] {
  return values
    .filter((value) => oracleGroup(value, { all: [{ op, target }] }))
    .map((value) => value.id);
}
