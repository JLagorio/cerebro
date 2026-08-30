import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATUSES,
  buildSchema,
  parseLayoutConfig,
  serializeDisplayConfig,
  serializeLayoutConfig,
} from './schema';
import type { DisplayConfig } from './types';
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
      'status',
      'priority',
      'estimate',
      'assignee',
      'due',
      'blocked',
      'weird',
      'project',
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

  // M16.14: a declared date renders in the format its PROPERTY carries.
  // Before that, every date everywhere printed its raw ISO string and the
  // picker's format menu was discarded the moment the popover closed.
  it('date values render in the property’s format, defaulting to short', () => {
    expect(schema.resolveField(item, 'due').display).toBe('Aug 1, 2026');
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

// M12.4: two-way relations — the reciprocal is DERIVED from the reverse
// index, so one link is stored once and two files can never disagree.
describe('derived two-way relations', () => {
  const objectiveType = makeEntry({
    path: 'types/objective.md',
    title: 'Objective',
    type: 'Type',
    properties: {
      fields: {
        key_results: { kind: 'relation', from: { type: 'Key result', field: 'objective' } },
      },
    } as unknown as ReturnType<typeof makeEntry>['properties'],
  });
  const keyResultType = makeEntry({
    path: 'types/key-result.md',
    title: 'Key result',
    type: 'Type',
    properties: {
      fields: { objective: { kind: 'relation', target: 'Objective', limit: 1 } },
    } as unknown as ReturnType<typeof makeEntry>['properties'],
  });
  const objective = makeEntry({
    path: 'records/objectives/obj-1.md',
    filename: 'obj-1.md',
    folder: 'records/objectives',
    title: 'Ship the split',
    type: 'Objective',
  });
  // Relationships arrive bracket-stripped from the parser (see the assignee
  // fixture above) — the [[ ]] live only in the frontmatter on disk.
  const kr = makeEntry({
    path: 'records/key-results/kr-1.md',
    filename: 'kr-1.md',
    folder: 'records/key-results',
    title: 'Routing inverted',
    type: 'Key result',
    relationships: { objective: ['obj-1'] },
  });

  it('resolves the reciprocal side from records linking back', () => {
    const schema = buildSchema([objectiveType, keyResultType, objective, kr]);
    const resolved = schema.resolveField(objective, 'key_results');
    expect(resolved.raw).toEqual(['kr-1']);
    expect(resolved.display).toBe('Routing inverted');
    expect(resolved.ghost).toBe(false);
  });

  it('parses limit: 1 on the owning side', () => {
    const schema = buildSchema([objectiveType, keyResultType]);
    const owning = schema.types.get('Key result')!.fields.find((f) => f.name === 'objective')!;
    expect(owning.limit).toBe(1);
    expect(owning.target).toBe('Objective');
  });
});

describe('display config (M44.1)', () => {
  const typeDoc = (display: unknown) =>
    makeEntry({
      path: 'types/work-item.md',
      type: 'Type',
      title: 'Work item',
      properties: { type: 'Type', display } as unknown as ReturnType<
        typeof makeEntry
      >['properties'],
    });

  it('absent display means the defaults — the panel behaves as before M44.1', () => {
    const schema = buildSchema([typeDoc(undefined)]);
    expect(schema.types.get('Work item')?.display).toEqual({
      showEmpty: false,
      showFile: false,
      showBody: true,
    });
  });

  it('reads snake_case deviations and defaults the rest', () => {
    const schema = buildSchema([typeDoc({ show_empty: true, show_body: false })]);
    expect(schema.types.get('Work item')?.display).toEqual({
      showEmpty: true,
      showFile: false,
      showBody: false,
    });
  });

  it('tolerates garbage — a hand-edited display never breaks the schema', () => {
    const schema = buildSchema([typeDoc('sideways')]);
    expect(schema.types.get('Work item')?.display).toEqual({
      showEmpty: false,
      showFile: false,
      showBody: true,
    });
  });

  it('wrong-typed members inside the object default too', () => {
    const schema = buildSchema([typeDoc({ show_empty: 'yes', show_body: 0 })]);
    expect(schema.types.get('Work item')?.display).toEqual({
      showEmpty: false,
      showFile: false,
      showBody: true,
    });
  });

  // Review Minor (M44.1 follow-up): serialize → parse must be the identity
  // for every combination of the three booleans, not just the cases above.
  // `parseDisplayConfig` is module-private, so this routes the serialized
  // value back through `buildSchema` — the same parse path a Type doc's
  // frontmatter takes — rather than growing schema.ts's exported surface
  // for a test-only need.
  it('round-trips every combination of the three display booleans', () => {
    const bools = [true, false];
    for (const showEmpty of bools) {
      for (const showFile of bools) {
        for (const showBody of bools) {
          const config: DisplayConfig = { showEmpty, showFile, showBody };
          const serialized = serializeDisplayConfig(config);
          const schema = buildSchema([typeDoc(serialized ?? undefined)]);
          expect(schema.types.get('Work item')?.display).toEqual(config);
        }
      }
    }
  });
});

describe('layout config (M45.1)', () => {
  it('absent or non-object layout means the defaults — the flat pre-M45 stack', () => {
    expect(parseLayoutConfig(undefined)).toEqual({ heading: [], groups: [] });
    expect(parseLayoutConfig('doc')).toEqual({ heading: [], groups: [] });
    expect(parseLayoutConfig(['status'])).toEqual({ heading: [], groups: [] });
  });

  it('heading keeps strings only, trimmed, first claim wins', () => {
    expect(parseLayoutConfig({ heading: ['status', ' due ', 'status', 7] }).heading).toEqual([
      'status',
      'due',
    ]);
  });

  it('mints group ids in two passes — a declared id is never stolen', () => {
    expect(
      parseLayoutConfig({ groups: [{}, { id: 'group-1', fields: ['a'] }] }).groups.map((g) => g.id),
    ).toEqual(['group-2', 'group-1']);
  });

  it('re-mints a duplicate declared id — the first occurrence keeps it', () => {
    expect(
      parseLayoutConfig({ groups: [{ id: 'g' }, { id: 'g' }] }).groups.map((g) => g.id),
    ).toEqual(['g', 'group-2']);
  });

  it('re-mints the container sentinels — heading and rest can never name a group', () => {
    // layoutEdit's container-address grammar spells 'heading' | 'rest' | groupId,
    // and Task 6's droppable ids extend it; a group wearing a sentinel would
    // swallow drops meant for the real container (id: rest = silent deletion).
    expect(
      parseLayoutConfig({ groups: [{ id: 'heading' }, { id: 'rest' }] }).groups.map((g) => g.id),
    ).toEqual(['group-1', 'group-2']);
  });

  it('falls back group names and drops later claims across containers', () => {
    const l = parseLayoutConfig({
      heading: ['status'],
      groups: [{ name: 'Main', fields: ['status', 'due', 'x'] }, { fields: ['due', 'team'] }],
    });
    // The contested name STAYS where it was claimed first — a later claim
    // evicting the earlier one would pass the group assertions alone.
    expect(l.heading).toEqual(['status']);
    expect(l.groups[0]).toEqual({ id: 'group-1', name: 'Main', fields: ['due', 'x'] });
    expect(l.groups[1]).toEqual({ id: 'group-2', name: 'Group 2', fields: ['team'] });
  });

  it('serializes deviations only — defaults delete the key, empty heading is omitted', () => {
    expect(serializeLayoutConfig({ heading: [], groups: [] })).toBeNull();
    expect(serializeLayoutConfig({ heading: ['status'], groups: [] })).toStrictEqual({
      heading: ['status'],
    });
    expect(
      serializeLayoutConfig({
        heading: [],
        groups: [{ id: 'group-1', name: 'Main', fields: ['due'] }],
      }),
    ).toStrictEqual({ groups: [{ id: 'group-1', name: 'Main', fields: ['due'] }] });
  });

  it('round-trips a parsed layout through the serializer', () => {
    const l = parseLayoutConfig({
      heading: ['status'],
      groups: [{ name: 'Main', fields: ['status', 'due', 'x'] }, { fields: ['due', 'team'] }],
    });
    expect(parseLayoutConfig(serializeLayoutConfig(l))).toEqual(l);
  });

  it('reads a group tab tolerantly — a non-string or a blank is ABSENT, not a tab', () => {
    // Absent is the default tab (M45.6), which is what every group had before
    // the key existed — so garbage degrading to absent degrades to today.
    const l = parseLayoutConfig({
      groups: [
        { id: 'a', name: 'A', fields: [], tab: '  spec  ' },
        { id: 'b', name: 'B', fields: [], tab: 7 },
        { id: 'c', name: 'C', fields: [], tab: true },
        { id: 'd', name: 'D', fields: [], tab: '   ' },
        { id: 'e', name: 'E', fields: [], tab: ['spec'] },
        { id: 'f', name: 'F', fields: [], tab: null },
      ],
    });
    expect(l.groups[0].tab).toBe('spec');
    for (const g of l.groups.slice(1)) expect(g.tab).toBeUndefined();
    // Not merely undefined-valued: the key must be gone, or the deviations-only
    // serializer would round-trip `tab: undefined` into the vault bytes.
    expect(Object.keys(l.groups[1])).toEqual(['id', 'name', 'fields']);
  });

  it('serializes tab only when set — an untabbed group is byte-identical to pre-M45.6', () => {
    expect(
      serializeLayoutConfig({
        heading: [],
        groups: [{ id: 'group-1', name: 'Main', fields: ['due'] }],
      }),
    ).toStrictEqual({ groups: [{ id: 'group-1', name: 'Main', fields: ['due'] }] });
    expect(
      serializeLayoutConfig({
        heading: [],
        groups: [{ id: 'group-1', name: 'Main', fields: ['due'], tab: 'spec' }],
      }),
    ).toStrictEqual({ groups: [{ id: 'group-1', name: 'Main', fields: ['due'], tab: 'spec' }] });
  });

  it('spells absent identically at both doors — a whitespace tab never reaches the vault', () => {
    // The serializer trims like the parser does. Guarding on `!== ''` alone
    // would write `tab: '   '`, which parses back ABSENT: parse(serialize(x))
    // would stop equalling x for that input.
    expect(
      serializeLayoutConfig({
        heading: [],
        groups: [{ id: 'group-1', name: 'Main', fields: [], tab: '   ' }],
      }),
    ).toStrictEqual({ groups: [{ id: 'group-1', name: 'Main', fields: [] }] });
    expect(
      serializeLayoutConfig({
        heading: [],
        groups: [{ id: 'group-1', name: 'Main', fields: [], tab: ' spec ' }],
      }),
    ).toStrictEqual({ groups: [{ id: 'group-1', name: 'Main', fields: [], tab: 'spec' }] });
  });

  it('round-trips a tabbed layout', () => {
    const l = parseLayoutConfig({
      heading: ['status'],
      groups: [
        { id: 'g1', name: 'Main', fields: ['due'], tab: 'spec' },
        { id: 'g2', name: 'Loose', fields: ['team'] },
      ],
    });
    expect(l.groups.map((g) => g.tab)).toEqual(['spec', undefined]);
    expect(parseLayoutConfig(serializeLayoutConfig(l))).toEqual(l);
  });

  it('buildSchema resolves layout from the Type doc frontmatter', () => {
    const doc = makeEntry({
      path: 'types/work-item.md',
      type: 'Type',
      title: 'Work item',
      properties: {
        type: 'Type',
        layout: {
          heading: ['status'],
          groups: [{ id: 'group-1', name: 'Main', fields: ['due'] }],
        },
      } as unknown as ReturnType<typeof makeEntry>['properties'],
    });
    expect(buildSchema([doc]).types.get('Work item')?.layout).toEqual({
      heading: ['status'],
      groups: [{ id: 'group-1', name: 'Main', fields: ['due'] }],
    });
    expect(buildSchema([typeNote]).types.get('Work item')?.layout).toEqual({
      heading: [],
      groups: [],
    });
  });
});
