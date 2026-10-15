import { describe, expect, it } from 'vitest';
import { buildSchema } from './schema';
import {
  bandDef,
  bandWritable,
  groupEntries,
  groupTree,
  bandKeysOf,
  bandsEveryValue,
  bandSeedFor,
  movedBandValue,
  NO_VALUE_KEY,
} from './grouping';
import { makeEntry } from './testHelpers';
import type { FieldDef } from './types';
import { bigTasks, computedVault, epics, smallTasks } from '@/test/computedVault';

const typeNote = makeEntry({
  path: 'types/work-item.md',
  filename: 'work-item.md',
  title: 'Work item',
  type: 'Type',
  properties: {
    // v2: the vault-default status set lives on the Work item Type doc.
    statuses: [
      { id: 'triage', group: 'active', color: '#A8AFC2' },
      { id: 'doing', group: 'active', color: '#EFB428' },
      { id: 'shipped', group: 'done', color: '#34B764' },
    ],
    fields: {
      status: { kind: 'status' },
      priority: {
        kind: 'select',
        options: [
          { id: 'urgent', color: '#DE3B4E' },
          { id: 'high', color: '#DE8F0A' },
          { id: 'low', color: '#A8AFC2' },
        ],
      },
      assignee: { kind: 'person' },
    },
  },
});

const project = makeEntry({
  path: 'projects/flight-deck/project.md',
  filename: 'project.md',
  title: 'Flight deck',
  type: 'Project',
});

const ana = makeEntry({
  path: 'people/ana-marte.md',
  filename: 'ana-marte.md',
  title: 'Ana Marte',
  type: 'Person',
});

const zed = makeEntry({
  path: 'people/zed-quill.md',
  filename: 'zed-quill.md',
  title: 'Zed Quill',
  type: 'Person',
});

const i1 = makeEntry({
  path: 'items/i1.md',
  filename: 'i1.md',
  title: 'One',
  type: 'Work item',
  properties: { status: 'doing', priority: 'high' },
  relationships: { project: ['flight-deck'], assignee: ['ana-marte'] },
});
const i2 = makeEntry({
  path: 'items/i2.md',
  filename: 'i2.md',
  title: 'Two',
  type: 'Work item',
  properties: { status: 'doing', priority: 'low' },
  relationships: { project: ['flight-deck'], assignee: ['zed-quill'] },
});
const i3 = makeEntry({
  path: 'items/i3.md',
  filename: 'i3.md',
  title: 'Three',
  type: 'Work item',
  properties: { status: 'shipped' },
  relationships: { project: ['flight-deck'], assignee: ['ghost-user'] },
});
const i4 = makeEntry({
  path: 'items/i4.md',
  filename: 'i4.md',
  title: 'Four',
  type: 'Work item',
  properties: { status: 'qa' }, // ghost status
  relationships: { project: ['flight-deck'] },
});
const i5 = makeEntry({
  path: 'items/i5.md',
  filename: 'i5.md',
  title: 'Five',
  type: 'Work item',
  relationships: { project: ['flight-deck'] },
});

// person entries are in the schema entry set but NOT in the grouped subset,
// exactly like a project page grouping its work items
const schema = buildSchema([typeNote, project, ana, zed, i1, i2, i3, i4, i5]);
const items = [i1, i2, i3, i4, i5];

describe('groupEntries — status', () => {
  it('orders groups by the type-doc status set, keeps empty groups, ghosts unknown values, trails No status', () => {
    const groups = groupEntries(items, 'status', schema);
    expect(groups.map((g) => g.key)).toEqual(['triage', 'doing', 'shipped', 'qa', '__none__']);
    expect(groups.map((g) => g.label)).toEqual(['Triage', 'Doing', 'Shipped', 'qa', 'No status']);
    expect(groups.map((g) => g.ghost)).toEqual([false, false, false, true, false]);
    expect(groups[0].entries).toEqual([]); // empty known group kept for board columns
    expect(groups[1].entries).toEqual([i1, i2]);
    expect(groups[1].color).toBe('#EFB428');
    expect(groups[2].entries).toEqual([i3]);
    expect(groups[3].entries).toEqual([i4]);
    expect(groups[3].color).toBeNull();
    expect(groups[4].entries).toEqual([i5]);
  });

  it('keeps the caller-provided order within groups (caller sorts first)', () => {
    const groups = groupEntries([i2, i1, i3, i4, i5], 'status', schema);
    expect(groups.find((g) => g.key === 'doing')!.entries).toEqual([i2, i1]);
  });

  it('returns an empty array for an empty entry list', () => {
    expect(groupEntries([], 'status', schema)).toEqual([]);
  });
});

describe('groupEntries — select', () => {
  it('orders groups by the declared option list with colors', () => {
    const groups = groupEntries(items, 'priority', schema);
    expect(groups.map((g) => g.key)).toEqual(['urgent', 'high', 'low', '__none__']);
    expect(groups.map((g) => g.label)).toEqual(['Urgent', 'High', 'Low', 'No priority']);
    expect(groups.find((g) => g.key === 'high')!.entries).toEqual([i1]);
    expect(groups.find((g) => g.key === 'high')!.color).toBe('#DE8F0A');
    expect(groups.find((g) => g.key === 'urgent')!.entries).toEqual([]);
    expect(groups[3].entries).toEqual([i3, i4, i5]);
  });
});

describe('groupEntries — person', () => {
  it('orders groups alphabetically by resolved display name, unresolved targets keep raw form', () => {
    const groups = groupEntries(items, 'assignee', schema);
    expect(groups.map((g) => g.label)).toEqual([
      'Ana Marte',
      'ghost-user',
      'Zed Quill',
      'No assignee',
    ]);
    expect(groups.map((g) => g.key)).toEqual(['ana-marte', 'ghost-user', 'zed-quill', '__none__']);
    expect(groups[0].entries).toEqual([i1]);
    expect(groups[3].entries).toEqual([i4, i5]);
    expect(groups.every((g) => g.ghost === false)).toBe(true);
  });
});

describe('groupEntries — plain values', () => {
  it('groups undeclared text fields alphabetically by value', () => {
    const a = makeEntry({ path: 'items/a.md', filename: 'a.md', properties: { phase: 'beta' } });
    const b = makeEntry({ path: 'items/b.md', filename: 'b.md', properties: { phase: 'alpha' } });
    const c = makeEntry({ path: 'items/c.md', filename: 'c.md' });
    const groups = groupEntries([a, b, c], 'phase', buildSchema([a, b, c]));
    expect(groups.map((g) => g.key)).toEqual(['alpha', 'beta', '__none__']);
    expect(groups[2].label).toBe('No phase');
    expect(groups[0].entries).toEqual([b]);
  });

  it('a field nobody has yields a single No <field> group', () => {
    const groups = groupEntries(items, 'zzz', schema);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: '__none__', label: 'No zzz', ghost: false });
    expect(groups[0].entries).toEqual(items);
  });
});

// M9.1: the chain model. groupEntries above stays the single-level case; these
// cover what a chain adds on top of it.
describe('groupTree', () => {
  const schema = buildSchema([typeNote]);
  const item = (path: string, status: string, priority: string) =>
    makeEntry({ path, type: 'Work item', properties: { status, priority } });

  const entries = [
    item('a.md', 'doing', 'urgent'),
    item('b.md', 'doing', 'low'),
    item('c.md', 'triage', 'urgent'),
  ];

  it('returns [] for an empty chain, so callers render flat', () => {
    expect(groupTree(entries, [], schema)).toEqual([]);
  });

  it('nests the second level inside the first', () => {
    const nodes = groupTree(entries, [{ field: 'status' }, { field: 'priority' }], schema);
    const doing = nodes.find((n) => n.key === 'doing')!;
    // Declared option order, empty options included — the depth-0 rule holds
    // at every level, so 'high' appears here with no entries.
    expect(doing.children.map((c) => c.key)).toEqual(['urgent', 'high', 'low']);
    expect(doing.children.find((c) => c.key === 'urgent')!.entries.map((e) => e.path)).toEqual([
      'a.md',
    ]);
  });

  it('keeps entries on leaves only, so nothing renders twice', () => {
    const nodes = groupTree(entries, [{ field: 'status' }, { field: 'priority' }], schema);
    for (const parent of nodes) {
      expect(parent.entries).toEqual([]);
      for (const leaf of parent.children) expect(leaf.children).toEqual([]);
    }
  });

  it('reports a recursive count, so a collapsed parent still tells the truth', () => {
    const nodes = groupTree(entries, [{ field: 'status' }, { field: 'priority' }], schema);
    expect(nodes.find((n) => n.key === 'doing')!.count).toBe(2);
  });

  it('paths disambiguate the same key under different parents', () => {
    const nodes = groupTree(entries, [{ field: 'status' }, { field: 'priority' }], schema);
    const urgentPaths = nodes
      .flatMap((n) => n.children)
      .filter((c) => c.key === 'urgent')
      .map((c) => c.path);
    // 'urgent' appears under both statuses; collapsing one must not collapse
    // the other, which is why collapse state keys on path and not key.
    expect(new Set(urgentPaths).size).toBe(urgentPaths.length);
  });

  it('hideEmpty drops declared-but-empty groups', () => {
    const withEmpty = groupTree(entries, [{ field: 'status' }], schema);
    const withoutEmpty = groupTree(entries, [{ field: 'status', hideEmpty: true }], schema);
    // 'shipped' is declared on the type but unused here.
    expect(withEmpty.some((n) => n.key === 'shipped')).toBe(true);
    expect(withoutEmpty.some((n) => n.key === 'shipped')).toBe(false);
  });
});

// M60.1: grouping reads `schema.fieldValue`, so a derived relation bands by
// its linking records instead of piling every record into "No <field>".
describe('groupEntries — computed values (M60.1)', () => {
  const vault = computedVault();
  const schema = buildSchema(vault);

  it('bands each record of a derived relation under its linking record', () => {
    const groups = groupEntries(epics(), 'tasks', schema);
    expect(groups.map((g) => [g.key, g.label, g.entries.map((e) => e.title)])).toEqual([
      ...[...bigTasks, ...smallTasks]
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((task) => [
          task.filename.replace(/\.md$/, ''),
          task.title,
          [task.relationships.epic[0] === 'big' ? 'Big' : 'Small'],
        ]),
      ['__none__', 'No tasks', ['Empty']],
    ]);
  });

  it('bands by a count rollup’s number', () => {
    const groups = groupEntries(epics(), 'task_count', schema);
    expect(groups.map((g) => [g.key, g.entries.length])).toEqual([
      ['0', 1],
      ['10', 1],
      ['9', 1],
    ]);
  });

  it('a stored relation still bands by its bracket-stripped target', () => {
    const groups = groupEntries([...bigTasks, ...smallTasks], 'epic', schema);
    expect(groups.map((g) => [g.key, g.label, g.entries.length])).toEqual([
      ['big', 'Big', 10],
      ['small', 'Small', 9],
    ]);
  });
});

describe('multi-value band membership and writes (M61.1)', () => {
  const person: FieldDef = { name: 'assignee', kind: 'person' };
  it('puts a record in each distinct person band with each target’s own complete label', () => {
    const multi = { ...i1, relationships: { assignee: ['ana-marte', 'zed-quill', 'ana-marte'] } };
    const comma = { ...zed, title: 'Quill, Zed' };
    const groups = groupEntries([multi], 'assignee', buildSchema([typeNote, ana, comma, multi]));
    expect(groups.map((g) => [g.key, g.label, g.entries.length])).toEqual([
      ['ana-marte', 'Ana Marte', 1],
      ['zed-quill', 'Quill, Zed', 1],
    ]);
  });

  it('honours limit one, expands undeclared lists and ignores empty values', () => {
    expect(bandsEveryValue(person, ['a', 'b'])).toBe(true);
    expect(bandKeysOf(['a', 'b', 'a'], person)).toEqual(['a', 'b']);
    expect(bandKeysOf(['a', 'b'], { ...person, limit: 1 })).toEqual(['a']);
    expect(bandKeysOf(['a', null, '', 'b', 'a'], null)).toEqual(['a', 'b']);
    expect(bandKeysOf(false, null)).toEqual(['false']);
    expect(bandKeysOf([], null)).toEqual([]);
    expect(bandKeysOf(['a', 'b'], { name: 'text', kind: 'text' })).toEqual(['a']);
  });

  it('seeds multiselect lists, links and boolean values, while computed bands seed nothing', () => {
    expect(bandSeedFor('a', { name: 'tags', kind: 'multiselect' })).toEqual(['a']);
    expect(bandSeedFor('ana-marte', person)).toBe('[[ana-marte]]');
    expect(bandSeedFor('true', { name: 'done', kind: 'checkbox' })).toBe(true);
    expect(bandSeedFor(NO_VALUE_KEY, person)).toBeNull();
    expect(bandSeedFor('1', { name: 'count', kind: 'rollup' })).toBeUndefined();
    expect(
      bandSeedFor('a', { ...person, from: { type: 'Person', field: 'assigned' } }),
    ).toBeUndefined();
  });

  it.each([
    [['a', 'b'], 'a', 'c', ['[[c]]', '[[b]]']],
    [['a', 'b'], 'a', 'b', ['[[b]]']],
    [['a', 'b'], 'b', 'c', ['[[a]]', '[[c]]']],
    [['a', 'b'], 'a', NO_VALUE_KEY, ['[[b]]']],
    [['a'], 'a', NO_VALUE_KEY, null],
    [[], NO_VALUE_KEY, 'c', ['[[c]]']],
  ])('moves %j from %s to %s without losing other memberships', (values, from, to, value) => {
    const entry = { ...i1, relationships: { assignee: values as string[] } };
    expect(movedBandValue(entry, 'assignee', from as string, to as string, schema)).toEqual({
      value,
    });
  });

  it('keeps undeclared list types, keeps limit-one scalar, and refuses computed values', () => {
    const undeclared = makeEntry({ properties: { values: [1, 2] } });
    expect(movedBandValue(undeclared, 'values', '1', '3', buildSchema([undeclared]))).toEqual({
      value: ['3', 2],
    });
    const undeclaredLinks = makeEntry({ relationships: { peers: ['a', 'b'] } });
    expect(
      movedBandValue(undeclaredLinks, 'peers', 'a', 'c', buildSchema([undeclaredLinks])),
    ).toEqual({ value: ['[[c]]', '[[b]]'] });
    const limitedType = makeEntry({
      ...typeNote,
      properties: { fields: { assignee: { kind: 'person', limit: 1 } } },
    });
    expect(
      movedBandValue(i1, 'assignee', 'ana-marte', 'zed-quill', buildSchema([limitedType, i1])),
    ).toEqual({ value: '[[zed-quill]]' });
    expect(
      movedBandValue(epics()[0], 'tasks', 'big-1', 'small-1', buildSchema(computedVault())),
    ).toEqual({ refused: "Can't move cards grouped by a computed property" });
  });
});

describe('bandWritable (M60.1)', () => {
  const schema = buildSchema(computedVault());
  const defOf = (field: string, entries = epics()) => bandDef(entries, field, schema);

  it('finds the first declaring def, or null', () => {
    expect(defOf('task_count')?.kind).toBe('rollup');
    expect(defOf('colour')).toBeNull();
  });

  it.each([
    ['a rollup', 'task_count'],
    ['created time', 'created'],
    ['edited time', 'edited'],
    ['a derived relation', 'tasks'],
  ])('is false for %s', (_label, field) => {
    expect(bandWritable(defOf(field))).toBe(false);
  });

  it('is false for a derived person too', () => {
    const def: FieldDef = { name: 'owners', kind: 'person', from: { type: 'T', field: 'f' } };
    expect(bandWritable(def)).toBe(false);
  });

  it('is true for a stored relation and an undeclared field', () => {
    expect(bandWritable(defOf('epic', bigTasks))).toBe(true);
    expect(bandWritable(defOf('colour'))).toBe(true);
    expect(bandWritable(null)).toBe(true);
  });
});

describe('date bands (M61.3)', () => {
  const ctx = { today: '2026-07-28', weekStart: 0 as const };
  const doc = makeEntry({
    path: 'types/dated.md',
    title: 'Dated',
    type: 'Type',
    properties: {
      fields: {
        due: { kind: 'date' },
        span: { kind: 'daterange' },
        stamp: { kind: 'created_time' },
      },
    },
  });
  const records = [
    makeEntry({ path: 'tomorrow.md', type: 'Dated', properties: { due: '2026-07-29 14:30' } }),
    makeEntry({ path: 'week.md', type: 'Dated', properties: { due: '2026-07-31' } }),
    makeEntry({ path: 'junk.md', type: 'Dated', properties: { due: 'sometime' } }),
    makeEntry({ path: 'none.md', type: 'Dated' }),
  ];
  const schema = buildSchema([doc, ...records]);
  it('emits relative empties in scale order, with ghosts distinct from absent values', () => {
    const groups = groupEntries(records, 'due', schema, { ctx });
    expect(groups.map((g) => g.label)).toEqual([
      'Earlier',
      'Today',
      'Tomorrow',
      'This week',
      'Next week',
      'Later',
      'sometime',
      'No due',
    ]);
    expect(groups.map((g) => g.entries.length)).toEqual([0, 0, 1, 1, 0, 0, 1, 1]);
    expect(groups.map((g) => g.seedable !== false)).toEqual([
      false,
      true,
      true,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(groups[6].ghost).toBe(true);
  });
  it('emits filled calendar months in ascending order and only filled future stamp bands', () => {
    expect(
      groupEntries(records, 'due', schema, { ctx, dateBucket: 'month' }).map((g) => [
        g.label,
        g.entries.length,
      ]),
    ).toEqual([
      ['July 2026', 2],
      ['sometime', 1],
      ['No due', 1],
    ]);
    const old = makeEntry({ path: 'old.md', type: 'Dated', createdAt: '2026-07-27T12:00:00Z' });
    const future = makeEntry({
      path: 'future.md',
      type: 'Dated',
      createdAt: '2026-08-03T12:00:00Z',
    });
    expect(groupEntries([old], 'stamp', schema, { ctx })[0].label).toBe('Today');
    expect(
      groupEntries([old], 'stamp', schema, { ctx }).every((group) => group.seedable === false),
    ).toBe(true);
    expect(groupEntries([future, old], 'stamp', schema, { ctx })[0]).toMatchObject({
      label: 'Later',
      entries: [future],
    });
  });
  it('passes date mode and one context through nested empty groups', () => {
    const tree = groupTree(
      records,
      [{ field: 'due', dateBucket: 'month' }, { field: 'due' }],
      schema,
      0,
      '',
      ctx,
    );
    expect(tree[0].key).toBe('month:2026-07');
    expect(tree[0].children.map((g) => g.label)).toEqual([
      'Earlier',
      'Today',
      'Tomorrow',
      'This week',
      'Next week',
      'Later',
    ]);
    expect(tree[0].children.every((g) => g.seedable === false)).toBe(true);
    const empty = groupTree(records, [{ field: 'due' }, { field: 'span' }], schema, 0, '', ctx);
    expect(empty.find((g) => g.label === 'Today')?.children.map((g) => g.label)).toContain(
      'Tomorrow',
    );
  });
  it('seeds only days and moves to them without losing time or a range end', () => {
    expect(bandSeedFor(ctx.today, { name: 'due', kind: 'date' })).toBe(ctx.today);
    expect(bandSeedFor(ctx.today, { name: 'span', kind: 'daterange' })).toEqual({
      start: ctx.today,
      end: null,
    });
    for (const key of ['rel:this-week', 'month:2026-07', 'invalid:sometime'])
      expect(bandSeedFor(key, { name: 'due', kind: 'date' })).toBeUndefined();
    expect(movedBandValue(records[0], 'due', '2026-07-29', ctx.today, schema)).toEqual({
      value: '2026-07-28 14:30',
    });
    expect(movedBandValue(records[0], 'due', '2026-07-29', 'rel:this-week', schema)).toHaveProperty(
      'refused',
    );
    expect(
      movedBandValue(records[0], 'due', '2026-07-29', 'invalid:sometime', schema),
    ).toHaveProperty('refused');
  });
});

it('bands mixed deadline types by end and completion, with Overdue always present (M61.3b)', () => {
  const doc = makeEntry({
    path: 'types/dated.md',
    type: 'Type',
    title: 'Dated',
    properties: {
      deadline: 'due',
      fields: { due: { kind: 'daterange' }, status: { kind: 'status' } },
      statuses: [
        { id: 'open', group: 'active' },
        { id: 'done', group: 'done' },
      ],
    },
  });
  const ordinary = makeEntry({
    path: 'types/note.md',
    type: 'Type',
    title: 'Note',
    properties: { fields: { due: { kind: 'date' } } },
  });
  const row = (path: string, status: string, end: string) =>
    makeEntry({ path, type: 'Dated', properties: { status, due: { start: '2026-07-20', end } } });
  const open = row('open.md', 'open', '2026-07-27');
  const unknown = row('unknown.md', 'unknown', '2026-07-27');
  const done = row('done.md', 'done', '2026-07-27');
  const tomorrow = row('tomorrow.md', 'open', '2026-07-29');
  const note = makeEntry({ path: 'note.md', type: 'Note', properties: { due: '2026-07-26' } });
  const entries = [open, unknown, done, tomorrow, note];
  const schema = buildSchema([doc, ordinary, ...entries]);
  const groups = groupEntries(entries, 'due', schema, {
    ctx: { today: '2026-07-28', weekStart: 0 },
  });
  expect(groups.find((g) => g.key === 'rel:overdue')?.entries).toEqual([open, unknown]);
  expect(groups.find((g) => g.key === 'rel:earlier')?.entries).toEqual([done, note]);
  expect(groups.find((g) => g.label === 'Tomorrow')?.entries).toEqual([tomorrow]);
  expect(movedBandValue(tomorrow, 'due', '2026-07-29', '2026-07-28', schema)).toEqual({
    value: { start: '2026-07-19', end: '2026-07-28' },
  });
  expect(
    groupEntries([tomorrow], 'due', schema, { ctx: { today: '2026-07-28', weekStart: 0 } }).map(
      (g) => g.key,
    ),
  ).toEqual([
    'rel:overdue',
    '2026-07-28',
    '2026-07-29',
    'rel:this-week',
    'rel:next-week',
    'rel:later',
  ]);
});
