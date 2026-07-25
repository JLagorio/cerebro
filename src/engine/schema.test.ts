import { describe, expect, it } from 'vitest';
import { DEFAULT_STATUSES, buildSchema } from './schema';
import { makeEntry } from './testHelpers';

const typeNote = makeEntry({
  path: 'type/work-item.md',
  filename: 'work-item.md',
  title: 'Work item',
  type: 'Type',
  properties: {
    icon: 'check-square',
    color: '#3D8BE8',
    // raw frontmatter shape, exactly as the Rust parser delivers it
    fields: {
      status: { kind: 'status' },
      priority: {
        kind: 'select',
        options: [
          { id: 'urgent', color: '#DE3B4E' },
          { id: 'high', color: '#DE8F0A' },
          { id: 'medium', color: '#3D8BE8' },
          { id: 'low', color: '#A8AFC2' },
        ],
      },
      estimate: { kind: 'select', options: ['XS', 'S', 'M'] },
      assignee: { kind: 'person' },
      due: { kind: 'date' },
      blocked: { kind: 'checkbox' },
      weird: { kind: 'hologram' }, // unknown kind → text
      project: { kind: 'relation', target: 'Project' },
    },
  },
});

const space = makeEntry({
  path: 'spaces/fieldwork.md',
  filename: 'fieldwork.md',
  title: 'Fieldwork',
  type: 'Space',
  properties: {
    color: '#3D8BE8',
    statuses: [
      { id: 'triage', group: 'active', color: '#A8AFC2' },
      { id: 'doing', group: 'active', color: '#EFB428' },
      { id: 'shipped', group: 'done', color: '#34B764' },
    ],
  },
});

const bareSpace = makeEntry({
  path: 'spaces/bare.md',
  filename: 'bare.md',
  title: 'Bare',
  type: 'Space',
});

const project = makeEntry({
  path: 'projects/flight-deck.md',
  filename: 'flight-deck.md',
  title: 'Flight deck',
  type: 'Project',
  properties: { key: 'FLD' },
  relationships: { space: ['fieldwork'] },
});

const ana = makeEntry({
  path: 'people/ana-marte.md',
  filename: 'ana-marte.md',
  title: 'Ana Marte',
  type: 'Person',
});

const item = makeEntry({
  path: 'items/fld-1.md',
  filename: 'fld-1.md',
  title: 'Fix the door',
  type: 'Work item',
  properties: {
    key: 'FLD-1',
    status: 'doing',
    priority: 'high',
    due: '2026-08-01',
    blocked: true,
    notes: 'hello', // undeclared field
  },
  relationships: { project: ['flight-deck'], assignee: ['ana-marte'] },
});

const ghostItem = makeEntry({
  path: 'items/fld-2.md',
  filename: 'fld-2.md',
  title: 'Odd one',
  type: 'Work item',
  properties: { status: 'qa', priority: 'blocker' },
  relationships: { project: ['flight-deck'], assignee: ['ghost-person'] },
});

const floating = makeEntry({
  path: 'items/floating.md',
  filename: 'floating.md',
  title: 'Floating',
  type: 'Work item',
  properties: { status: 'todo' },
});

const orphan = makeEntry({
  path: 'items/orphan.md',
  filename: 'orphan.md',
  title: 'Orphan',
  type: 'Work item',
  relationships: { project: ['nowhere'] },
});

const entries = [typeNote, space, bareSpace, project, ana, item, ghostItem, floating, orphan];
const schema = buildSchema(entries);

describe('DEFAULT_STATUSES', () => {
  it('matches the spec simple template exactly', () => {
    expect(DEFAULT_STATUSES).toEqual([
      { id: 'backlog', label: 'Backlog', color: '#A8AFC2', group: 'active' },
      { id: 'todo', label: 'Todo', color: '#3D8BE8', group: 'active' },
      { id: 'in-progress', label: 'In progress', color: '#EFB428', group: 'active' },
      { id: 'done', label: 'Done', color: '#34B764', group: 'done' },
      { id: 'cancelled', label: 'Cancelled', color: '#A8AFC2', hollow: true, group: 'closed' },
    ]);
  });
});

describe('buildSchema — types', () => {
  it('registers a TypeDef per type-note, keyed by title', () => {
    expect([...schema.types.keys()]).toEqual(['Work item']);
    const def = schema.types.get('Work item')!;
    expect(def.name).toBe('Work item');
    expect(def.icon).toBe('check-square');
    expect(def.color).toBe('#3D8BE8');
    expect(def.fields.map((f) => f.name)).toEqual([
      'status', 'priority', 'estimate', 'assignee', 'due', 'blocked', 'weird', 'project',
    ]);
  });

  it('parses mapping options with humanized labels and colors', () => {
    const priority = schema.types.get('Work item')!.fields.find((f) => f.name === 'priority')!;
    expect(priority.kind).toBe('select');
    expect(priority.options![1]).toEqual({ id: 'high', label: 'High', color: '#DE8F0A' });
  });

  it('parses bare-string options', () => {
    const estimate = schema.types.get('Work item')!.fields.find((f) => f.name === 'estimate')!;
    expect(estimate.options).toEqual([
      { id: 'XS', label: 'XS', color: null },
      { id: 'S', label: 'S', color: null },
      { id: 'M', label: 'M', color: null },
    ]);
  });

  it('falls back unknown kinds to text', () => {
    const weird = schema.types.get('Work item')!.fields.find((f) => f.name === 'weird')!;
    expect(weird).toEqual({ name: 'weird', kind: 'text' });
  });

  it('keeps relation targets', () => {
    const rel = schema.types.get('Work item')!.fields.find((f) => f.name === 'project')!;
    expect(rel).toEqual({ name: 'project', kind: 'relation', target: 'Project' });
  });

  it('tolerates a fields value that is not a mapping', () => {
    const broken = makeEntry({
      path: 'type/broken.md',
      filename: 'broken.md',
      title: 'Broken',
      type: 'Type',
      properties: { fields: 'oops' },
    });
    expect(buildSchema([broken]).types.get('Broken')!.fields).toEqual([]);
  });
});

describe('spaceForEntry', () => {
  it('resolves item → project → space', () => {
    expect(schema.spaceForEntry(item)).toBe(space);
  });

  it('resolves a project via its own space relationship', () => {
    expect(schema.spaceForEntry(project)).toBe(space);
  });

  it('a space resolves to itself', () => {
    expect(schema.spaceForEntry(space)).toBe(space);
  });

  it('returns null when the entry has no project relationship', () => {
    expect(schema.spaceForEntry(floating)).toBeNull();
  });

  it('returns null when the project target does not resolve', () => {
    expect(schema.spaceForEntry(orphan)).toBeNull();
  });
});

describe('statusSetForSpace', () => {
  it('null path falls back to DEFAULT_STATUSES', () => {
    expect(schema.statusSetForSpace(null)).toBe(DEFAULT_STATUSES);
  });

  it('parses the statuses property with humanized labels', () => {
    expect(schema.statusSetForSpace('spaces/fieldwork.md')).toEqual([
      { id: 'triage', label: 'Triage', color: '#A8AFC2', group: 'active' },
      { id: 'doing', label: 'Doing', color: '#EFB428', group: 'active' },
      { id: 'shipped', label: 'Shipped', color: '#34B764', group: 'done' },
    ]);
  });

  it('a space without a statuses property falls back to DEFAULT_STATUSES', () => {
    expect(schema.statusSetForSpace('spaces/bare.md')).toBe(DEFAULT_STATUSES);
  });

  it('an unknown path falls back to DEFAULT_STATUSES', () => {
    expect(schema.statusSetForSpace('spaces/nope.md')).toBe(DEFAULT_STATUSES);
  });
});

describe('resolveField', () => {
  it('status resolves against the status set of the item space', () => {
    expect(schema.resolveField(item, 'status')).toEqual({
      def: { name: 'status', kind: 'status' },
      raw: 'doing',
      display: 'Doing',
      color: '#EFB428',
      ghost: false,
    });
  });

  it('an unknown status value is a ghost with its raw id as display', () => {
    const resolved = schema.resolveField(ghostItem, 'status');
    expect(resolved.display).toBe('qa');
    expect(resolved.ghost).toBe(true);
    expect(resolved.color).toBeNull();
  });

  it('status falls back to DEFAULT_STATUSES when the item has no space', () => {
    const resolved = schema.resolveField(floating, 'status');
    expect(resolved.display).toBe('Todo');
    expect(resolved.color).toBe('#3D8BE8');
    expect(resolved.ghost).toBe(false);
  });

  it('select resolves label and color from the options list', () => {
    const resolved = schema.resolveField(item, 'priority');
    expect(resolved.display).toBe('High');
    expect(resolved.color).toBe('#DE8F0A');
    expect(resolved.ghost).toBe(false);
  });

  it('a select value outside the options list is a ghost', () => {
    const resolved = schema.resolveField(ghostItem, 'priority');
    expect(resolved.display).toBe('blocker');
    expect(resolved.ghost).toBe(true);
    expect(resolved.color).toBeNull();
  });

  it('person displays the resolved entry title', () => {
    const resolved = schema.resolveField(item, 'assignee');
    expect(resolved.display).toBe('Ana Marte');
    expect(resolved.ghost).toBe(false);
  });

  it('an unresolved person target falls back to the raw target', () => {
    expect(schema.resolveField(ghostItem, 'assignee').display).toBe('ghost-person');
  });

  it('relation displays the resolved entry title', () => {
    expect(schema.resolveField(item, 'project').display).toBe('Flight deck');
  });

  it('date values pass through as strings', () => {
    expect(schema.resolveField(item, 'due').display).toBe('2026-08-01');
  });

  it('checkbox true displays as Yes', () => {
    expect(schema.resolveField(item, 'blocked').display).toBe('Yes');
  });

  it('undeclared fields resolve with a null def but still display (advisory)', () => {
    const resolved = schema.resolveField(item, 'notes');
    expect(resolved.def).toBeNull();
    expect(resolved.display).toBe('hello');
    expect(resolved.ghost).toBe(false);
  });

  it('declared-but-missing fields resolve empty with the def attached', () => {
    const resolved = schema.resolveField(item, 'estimate');
    expect(resolved.def).toEqual({
      name: 'estimate',
      kind: 'select',
      options: [
        { id: 'XS', label: 'XS', color: null },
        { id: 'S', label: 'S', color: null },
        { id: 'M', label: 'M', color: null },
      ],
    });
    expect(resolved.display).toBe('');
    expect(resolved.ghost).toBe(false);
  });

  it('a missing undeclared field resolves fully empty', () => {
    expect(schema.resolveField(item, 'nonexistent')).toEqual({
      def: null,
      raw: undefined,
      display: '',
      color: null,
      ghost: false,
    });
  });
});
