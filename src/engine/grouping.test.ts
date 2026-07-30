import { describe, expect, it } from 'vitest';
import { buildSchema } from './schema';
import { groupEntries, groupTree } from './grouping';
import { makeEntry } from './testHelpers';

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
  path: 'items/i1.md', filename: 'i1.md', title: 'One', type: 'Work item',
  properties: { status: 'doing', priority: 'high' },
  relationships: { project: ['flight-deck'], assignee: ['ana-marte'] },
});
const i2 = makeEntry({
  path: 'items/i2.md', filename: 'i2.md', title: 'Two', type: 'Work item',
  properties: { status: 'doing', priority: 'low' },
  relationships: { project: ['flight-deck'], assignee: ['zed-quill'] },
});
const i3 = makeEntry({
  path: 'items/i3.md', filename: 'i3.md', title: 'Three', type: 'Work item',
  properties: { status: 'shipped' },
  relationships: { project: ['flight-deck'], assignee: ['ghost-user'] },
});
const i4 = makeEntry({
  path: 'items/i4.md', filename: 'i4.md', title: 'Four', type: 'Work item',
  properties: { status: 'qa' }, // ghost status
  relationships: { project: ['flight-deck'] },
});
const i5 = makeEntry({
  path: 'items/i5.md', filename: 'i5.md', title: 'Five', type: 'Work item',
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
    expect(groups.map((g) => g.label)).toEqual(['Ana Marte', 'ghost-user', 'Zed Quill', 'No assignee']);
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
    const urgentPaths = nodes.flatMap((n) => n.children).filter((c) => c.key === 'urgent').map((c) => c.path);
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
