import { describe, expect, it } from 'vitest';
import { DEFAULT_STATUSES, buildSchema } from './schema';
import { makeEntry } from './testHelpers';

const typeNote = makeEntry({
  path: 'types/work-item.md',
  filename: 'work-item.md',
  folder: 'types',
  title: 'Work item',
  type: 'Type',
  properties: {
    icon: 'check-square',
    color: '#3D8BE8',
    // v2 (locked decision 4): the vault-default status set lives here.
    statuses: [
      { id: 'triage', group: 'active', color: '#A8AFC2' },
      { id: 'doing', group: 'active', color: '#EFB428' },
      { id: 'shipped', group: 'done', color: '#34B764' },
    ],
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

const project = makeEntry({
  path: 'projects/flight-deck/project.md',
  filename: 'project.md',
  folder: 'projects/flight-deck',
  project: 'projects/flight-deck/project.md',
  title: 'Flight deck',
  type: 'Project',
  properties: { key: 'FLD' },
});

// A project with its own `statuses:` override (locked decision 4).
const labsProject = makeEntry({
  path: 'projects/labs/project.md',
  filename: 'project.md',
  folder: 'projects/labs',
  project: 'projects/labs/project.md',
  title: 'Labs',
  type: 'Project',
  properties: {
    key: 'LAB',
    statuses: [
      { id: 'poc', group: 'active', color: '#8250DC' },
      { id: 'proven', group: 'done', color: '#34B764' },
    ],
  },
});

const ana = makeEntry({
  path: 'people/ana-marte.md',
  filename: 'ana-marte.md',
  title: 'Ana Marte',
  type: 'Person',
});

const item = makeEntry({
  path: 'projects/flight-deck/items/fld-1.md',
  filename: 'fld-1.md',
  folder: 'projects/flight-deck/items',
  project: 'projects/flight-deck/project.md',
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
  relationships: { assignee: ['ana-marte'] },
});

const ghostItem = makeEntry({
  path: 'projects/flight-deck/items/fld-2.md',
  filename: 'fld-2.md',
  folder: 'projects/flight-deck/items',
  project: 'projects/flight-deck/project.md',
  title: 'Odd one',
  type: 'Work item',
  properties: { status: 'qa', priority: 'blocker' },
  relationships: { assignee: ['ghost-person'] },
});

const floating = makeEntry({
  path: 'inbox/floating.md',
  filename: 'floating.md',
  folder: 'inbox',
  title: 'Floating',
  type: 'Work item',
  properties: { status: 'todo' },
});

// Entry.project pointing at a path with no entry (deleted project.md).
const orphan = makeEntry({
  path: 'projects/nowhere/items/orphan.md',
  filename: 'orphan.md',
  folder: 'projects/nowhere/items',
  project: 'projects/nowhere/project.md',
  title: 'Orphan',
  type: 'Work item',
});

const entries = [typeNote, project, labsProject, ana, item, ghostItem, floating, orphan];
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

describe('projectForEntry', () => {
  it('resolves the containing project.md entry', () => {
    expect(schema.projectForEntry(item)).toBe(project);
  });

  it('a project doc resolves to itself', () => {
    expect(schema.projectForEntry(project)).toBe(project);
  });

  it('returns null outside any project', () => {
    expect(schema.projectForEntry(floating)).toBeNull();
  });

  it('returns null when the project.md entry is missing', () => {
    expect(schema.projectForEntry(orphan)).toBeNull();
  });
});

describe('statusSetForProject', () => {
  // M12.2: no type's statuses stand in for the vault's. The Work item Type
  // doc used to be the default source — now a type's statuses are its own,
  // and everything else gets the app defaults.
  it('null path uses the app defaults, not any Type doc', () => {
    expect(schema.statusSetForProject(null)).toBe(DEFAULT_STATUSES);
  });

  it('a project statuses override wins over the defaults', () => {
    expect(schema.statusSetForProject('projects/labs/project.md')).toEqual([
      { id: 'poc', label: 'Poc', color: '#8250DC', group: 'active' },
      { id: 'proven', label: 'Proven', color: '#34B764', group: 'done' },
    ]);
  });

  it('a project without an override uses the app defaults', () => {
    expect(schema.statusSetForProject('projects/flight-deck/project.md')).toBe(DEFAULT_STATUSES);
  });

  it('an unknown project path uses the app defaults', () => {
    expect(schema.statusSetForProject('projects/nowhere/project.md')).toBe(DEFAULT_STATUSES);
  });

  it('falls back to DEFAULT_STATUSES when no type doc declares statuses', () => {
    const bare = buildSchema([project, item]);
    expect(bare.statusSetForProject('projects/flight-deck/project.md')).toBe(DEFAULT_STATUSES);
    expect(bare.statusSetForProject(null)).toBe(DEFAULT_STATUSES);
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

  it('status outside any project resolves against the type-doc default set', () => {
    // floating carries status 'todo', which the type-doc set doesn't declare.
    const resolved = schema.resolveField(floating, 'status');
    expect(resolved.display).toBe('todo');
    expect(resolved.ghost).toBe(true);
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
    // v2: project files are all named project.md, so wikilinks to projects
    // resolve by exact title (resolveTarget's second pass), not stem.
    const linked = makeEntry({
      ...item,
      path: 'projects/flight-deck/items/fld-9.md',
      relationships: { ...item.relationships, project: ['Flight deck'] },
    });
    expect(buildSchema([...entries, linked]).resolveField(linked, 'project').display).toBe(
      'Flight deck',
    );
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
