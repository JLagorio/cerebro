import { computeChart } from './chart';
import { evaluateFilters } from './viewFilters';
import { sortEntries } from './surface';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATUSES,
  VIRTUAL_FIELDS,
  buildSchema,
  parseLayoutConfig,
  serializeDisplayConfig,
  serializeLayoutConfig,
} from './schema';
import type { DisplayConfig } from './types';
import { makeEntry } from './testHelpers';
import { bigEpic, bigTasks, computedVault, emptyEpic, smallEpic } from '@/test/computedVault';

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

describe('project progress (M61.11b)', () => {
  const progressType = makeEntry({
    path: 'types/project.md',
    type: 'Type',
    title: 'Project',
    properties: {
      fields: {
        progress: {
          kind: 'rollup',
          from: { type: 'Work item', field: 'project' },
          property: 'status',
          calculate: 'percent_done',
          format: 'progress',
          precision: 0,
        },
      },
    },
  });
  const workType = makeEntry({
    path: 'types/work-item.md',
    type: 'Type',
    title: 'Work item',
    properties: { fields: { status: 'status', project: { kind: 'relation', target: 'Project' } } },
  });
  const work = ['done', 'todo', 'todo', 'todo', 'cancelled'].map((status, i) =>
    makeEntry({
      path: `records/work-items/${i}.md`,
      type: 'Work item',
      properties: { status },
      relationships: { project: ['flight-deck'] },
    }),
  );

  it('is numeric in reads and percent-formatted on the page', () => {
    const schema = buildSchema([progressType, workType, project, ...work]);
    expect(schema.fieldValue(project, 'progress')).toBe(25);
    expect(schema.resolveField(project, 'progress').display).toBe('25%');
  });

  it('leaves a project with no measured work blank', () => {
    const schema = buildSchema([progressType, workType, project]);
    expect(schema.fieldValue(project, 'progress')).toBeUndefined();
    expect(schema.resolveField(project, 'progress').display).toBe('');
  });
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

// M60.1: the one value every view reads. Filter, sort, group, chart and the
// dashboard number all call it, so these pin its order once.
describe('fieldValue', () => {
  const schema = buildSchema(computedVault());

  it('pins the virtual fields in one order', () => {
    expect(VIRTUAL_FIELDS).toEqual(['title', 'type', 'createdAt', 'modifiedAt']);
  });

  it('reads the page title, never a frontmatter `title:` key', () => {
    expect(bigEpic.properties.title).toBe('Zeta');
    expect(schema.fieldValue(bigEpic, 'title')).toBe('Big');
    expect(schema.fieldValue(bigEpic, 'type')).toBe('Epic');
  });

  it('gives created and edited time as the entry’s own stamps', () => {
    expect(schema.fieldValue(bigEpic, 'createdAt')).toBe('2026-08-01T12:00:00Z');
    expect(schema.fieldValue(bigEpic, 'modifiedAt')).toBe('2026-07-25T12:00:00Z');
    expect(schema.fieldValue(bigEpic, 'created')).toBe('2026-08-01T12:00:00Z');
    expect(schema.fieldValue(bigEpic, 'edited')).toBe('2026-07-25T12:00:00Z');
  });

  it('gives count and sum rollups as numbers', () => {
    expect(schema.fieldValue(bigEpic, 'task_count')).toBe(10);
    expect(schema.fieldValue(smallEpic, 'task_count')).toBe(9);
    expect(schema.fieldValue(bigEpic, 'points')).toBe(10);
    expect(schema.fieldValue(smallEpic, 'points')).toBe(18);
    // A count of nothing is a measured zero, not an absence.
    expect(schema.fieldValue(emptyEpic, 'task_count')).toBe(0);
  });

  it('leaves a sum over prose, or over nothing, undefined — never 0', () => {
    expect(schema.fieldValue(bigEpic, 'prose_sum')).toBeUndefined();
    expect(schema.fieldValue(emptyEpic, 'points')).toBeUndefined();
  });

  it('keeps a show rollup’s text', () => {
    expect(schema.fieldValue(smallEpic, 'notes')).toBe(Array(9).fill('beta').join(', '));
  });

  it('gives a derived relation the linking records’ stems', () => {
    expect(schema.fieldValue(bigEpic, 'tasks')).toEqual(
      Array.from({ length: 10 }, (_, i) => `big-${i + 1}`),
    );
    expect(schema.fieldValue(emptyEpic, 'tasks')).toEqual([]);
  });

  it('gives a stored relation its bracket-stripped targets', () => {
    expect(schema.fieldValue(bigTasks[0], 'epic')).toEqual(['big']);
  });

  it('falls through to an undeclared property, and absent is undefined', () => {
    expect(schema.fieldValue(bigEpic, 'colour')).toBe('red');
    expect(schema.fieldValue(bigTasks[0], 'estimate')).toBe(1);
    expect(schema.fieldValue(bigEpic, 'nothing_here')).toBeUndefined();
  });

  it('answers a repeat read from its memo', () => {
    expect(schema.fieldValue(bigEpic, 'tasks')).toBe(schema.fieldValue(bigEpic, 'tasks'));
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

  it('ignores a group `tab:` key and never writes one back (M46.1)', () => {
    // The only accommodation the reversal gets: a `layout:` written by a
    // local M45.6 build parses as though the key were never there — no
    // throw, no migration, no compatibility branch — and sheds it on the
    // next Apply. No user of a shipped build can have one.
    const l = parseLayoutConfig({
      heading: ['status'],
      groups: [
        { id: 'g1', name: 'Main', fields: ['due'], tab: 'spec' },
        { id: 'g2', name: 'Loose', fields: ['team'] },
      ],
    });
    expect(l.groups.map((g) => Object.keys(g))).toEqual([
      ['id', 'name', 'fields'],
      ['id', 'name', 'fields'],
    ]);
    expect(l.groups.map((g) => g.id)).toEqual(['g1', 'g2']);
    // The key does not survive a round-trip: what the vault gets back is a
    // pre-M45.6 group, byte for byte.
    expect(serializeLayoutConfig(l)).toStrictEqual({
      heading: ['status'],
      groups: [
        { id: 'g1', name: 'Main', fields: ['due'] },
        { id: 'g2', name: 'Loose', fields: ['team'] },
      ],
    });
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

describe('declared reminder offsets (M64.3b)', () => {
  it('reads only supported offsets on stored date and date-range fields', () => {
    const doc = makeEntry({
      path: 'types/dated.md',
      title: 'Dated',
      type: 'Type',
      properties: {
        fields: {
          due: { kind: 'date', remind: '1d' },
          window: { kind: 'daterange', remind: '0d' },
          other: { kind: 'date', remind: '3h' },
          words: { kind: 'text', remind: '1d' },
          created: { kind: 'created_time', remind: '1w' },
        },
      },
    });
    expect(buildSchema([doc]).types.get('Dated')?.fields).toEqual([
      { name: 'due', kind: 'date', remind: '1d' },
      { name: 'window', kind: 'daterange', remind: '0d' },
      { name: 'other', kind: 'date' },
      { name: 'words', kind: 'text' },
      { name: 'created', kind: 'created_time' },
    ]);
  });
});

describe('declared deadlines (M61.3b)', () => {
  it.each([
    ['date', 'due', 'due'],
    ['daterange', 'due', 'due'],
    ['date', ' due ', 'due'],
    ['date', 'Due', null],
    ['date', 'unknown', null],
    ['select', 'due', null],
    ['created_time', 'due', null],
    ['date', 2, null],
    ['date', ['due'], null],
    ['date', null, null],
  ])('resolves %s / %s without guessing', (kind, deadline, expected) => {
    const doc = makeEntry({
      type: 'Type',
      title: 'Dated',
      properties: { fields: { due: { kind } }, deadline },
    });
    expect(buildSchema([doc]).types.get('Dated')?.deadline).toBe(expected);
  });
});

describe('formula reads (M61.4)', () => {
  function formulaVault() {
    const doc = makeEntry({
      path: 'types/key-result.md',
      title: 'Key result',
      type: 'Type',
      properties: {
        fields: {
          target: { kind: 'number' },
          current: { kind: 'number' },
          starts: { kind: 'date' },
          gap: { kind: 'formula', formula: 'target - current', format: 'currency' },
          doubled: { kind: 'formula', formula: 'gap * 2' },
          next: { kind: 'formula', formula: 'starts + .5', dateFormat: 'ymd', timeFormat: '24' },
          broken: { kind: 'formula', formula: 'missing + 1' },
          cycle: { kind: 'formula', formula: 'cycle + 1' },
        },
      },
    });
    const full = makeEntry({
      path: 'results/full.md',
      type: 'Key result',
      properties: {
        target: 100,
        current: 30,
        starts: '2026-07-28 14:30',
        gap: 999,
        doubled: 999,
      },
    });
    const empty = makeEntry({
      path: 'results/empty.md',
      type: 'Key result',
      properties: {
        target: 100,
        gap: 999,
      },
    });
    return { full, empty, schema: buildSchema([doc, full, empty]) };
  }

  it('computes numbers and nested formulas, ignores stored output, and formats the result', () => {
    const { full, schema } = formulaVault();
    expect(schema.fieldValue(full, 'gap')).toBe(70);
    expect(schema.fieldValue(full, 'doubled')).toBe(140);
    expect(schema.resolveField(full, 'gap')).toMatchObject({ raw: 70, display: '$70' });
    expect(schema.resolveField(full, 'doubled')).toMatchObject({ raw: 140, display: '140' });
  });

  it('computes and displays date results with their property format', () => {
    const { full, schema } = formulaVault();
    expect(schema.fieldValue(full, 'next')).toBe('2026-07-29 02:30');
    expect(schema.resolveField(full, 'next').display).toBe('2026/07/29 02:30');
  });

  it('keeps missing, invalid and cyclic results empty even when frontmatter stores output', () => {
    const { full, empty, schema } = formulaVault();
    for (const [entry, field] of [
      [empty, 'gap'],
      [empty, 'doubled'],
      [full, 'broken'],
      [full, 'cycle'],
    ] as const) {
      expect(schema.fieldValue(entry, field)).toBeUndefined();
      expect(schema.resolveField(entry, field)).toMatchObject({ raw: undefined, display: '' });
    }
  });

  it('shares one computed value with filters, sorts and chart measures', () => {
    const { full, empty, schema } = formulaVault();
    expect(evaluateFilters(full, { all: [{ field: 'gap', op: 'gt', value: 60 }] }, schema)).toBe(
      true,
    );
    expect(
      evaluateFilters(empty, { all: [{ field: 'gap', op: 'equals', value: 0 }] }, schema),
    ).toBe(false);
    expect(evaluateFilters(empty, { all: [{ field: 'gap', op: 'is_empty' }] }, schema)).toBe(true);
    expect(sortEntries([empty, full], [{ field: 'gap', dir: 'desc' }], schema)).toEqual([
      full,
      empty,
    ]);
    const chart = computeChart(
      [full, empty],
      {
        type: 'chart',
        group: [],
        sort: [],
        columns: [],
        chart: { kind: 'number', agg: 'sum', value: 'gap' },
      },
      schema,
    );
    expect(chart.total).toBe(70);
  });
});

it('email_domain names exactly a declared text or URL field', () => {
  for (const kind of ['text', 'url', 'email', 'number', 'formula']) {
    const row = makeEntry({
      path: 'types/business.md',
      title: 'Business',
      type: 'Type',
      properties: { email_domain: ' domain ', fields: { domain: { kind } } },
    });
    expect(buildSchema([row]).types.get('Business')?.emailDomain).toBe(
      ['text', 'url'].includes(kind) ? 'domain' : null,
    );
    const wrong = { ...row, properties: { ...row.properties, email_domain: 'Domain' } };
    expect(buildSchema([wrong]).types.get('Business')?.emailDomain).toBeNull();
  }
});
