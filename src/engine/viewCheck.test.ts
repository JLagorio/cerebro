import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { makeEntry } from '@/test/factories';
import { planFieldRename } from './fieldRefs';
import { humanize, splitFrontmatter } from './frontmatter';
import { buildSchema, VIRTUAL_FIELDS } from './schema';
import { sortEntries } from './surface';
import type { Entry, FilterGroup, ViewDefinition } from './types';
import { ENTRY_FIELDS, checkView, describeViewProblem, type ViewProblem } from './viewCheck';
import { evaluateFilters } from './viewFilters';
import { parseViewList } from './views';
import { parseWikilinks } from './wikilink';

// --- fixtures ----------------------------------------------------------------

const workItemType = (extra: Record<string, unknown> = {}) =>
  makeEntry({
    path: 'types/work-item.md',
    title: 'Work item',
    type: 'Type',
    properties: {
      statuses: [
        { id: 'todo', group: 'active' },
        { id: 'progress', group: 'active' },
        { id: 'done', group: 'done' },
      ],
      fields: {
        status: { kind: 'status' },
        priority: { kind: 'select', options: [{ id: 'urgent' }, { id: 'high' }, { id: 'low' }] },
        tags: { kind: 'multiselect', options: [{ id: 'ux' }, { id: 'api' }] },
        estimate: { kind: 'number' },
        epic: { kind: 'relation', target: 'Epic' },
        blockers: { kind: 'rollup', relation: 'epic', property: 'status', calculate: 'count' },
      },
      ...extra,
    } as unknown as Entry['properties'],
  });

const epicType = makeEntry({
  path: 'types/epic.md',
  title: 'Epic',
  type: 'Type',
  properties: {
    fields: { stage: { kind: 'status' }, owner: { kind: 'person' } },
  } as unknown as Entry['properties'],
});

const item = (name: string, properties: Record<string, unknown>) =>
  makeEntry({
    path: `items/${name}.md`,
    title: name,
    type: 'Work item',
    properties: properties as Entry['properties'],
  });

const BASE: Entry[] = [
  workItemType(),
  epicType,
  item('a', { status: 'todo', priority: 'urgent', legacy_flag: true }),
  // A ghost: `medium` was retired from priority's options, and a record kept it.
  item('b', { status: 'done', priority: 'medium' }),
  makeEntry({ path: 'notes/loose.md', title: 'Loose', properties: { mood: 'sunny' } }),
];

const viewOf = (
  presentation: Partial<ViewDefinition['presentation']> = {},
  filters: FilterGroup | null = null,
): ViewDefinition =>
  ({
    id: 'v',
    name: 'V',
    icon: null,
    filters,
    presentation: { type: 'table', group: [], sort: [], columns: [], ...presentation },
  }) as ViewDefinition;

function check(view: ViewDefinition, source: string | null = 'Work item', entries = BASE) {
  return checkView(view, source, buildSchema(entries), entries);
}

// --- known fields ---------------------------------------------------------------

describe('checkView: fields', () => {
  it('names a filter on a field nobody declares or holds', () => {
    const view = viewOf({}, { all: [{ field: 'ghost_field', op: 'is_not_empty' }] });
    expect(check(view)).toEqual([
      { code: 'unknown_field', name: 'ghost_field', position: 'filter', filterPath: [0] },
    ]);
  });

  it('never flags an undeclared key a record of the source holds', () => {
    const view = viewOf(
      { columns: [{ field: 'legacy_flag' }] },
      { all: [{ field: 'legacy_flag', op: 'equals', value: true }] },
    );
    expect(check(view)).toEqual([]);
  });

  it('reads only the source’s records: a key another type’s page holds is still unknown', () => {
    const view = viewOf({ sort: [{ field: 'mood', dir: 'asc' }] });
    expect(check(view)).toEqual([{ code: 'unknown_field', name: 'mood', position: 'sort' }]);
  });

  it('accepts the entry fields each position’s reader resolves, and only those', () => {
    const view = viewOf(
      {
        sort: [
          { field: 'createdAt', dir: 'asc' },
          { field: 'title', dir: 'asc' },
        ],
        columns: [{ field: 'title' }, { field: 'createdAt' }],
        dateField: 'modifiedAt',
      },
      { all: [{ field: 'type', op: 'equals', value: 'Work item' }] },
    );
    expect(check(view)).toEqual([
      { code: 'unknown_field', name: 'createdAt', position: 'column' },
      { code: 'unknown_field', name: 'modifiedAt', position: 'dateField' },
    ]);
  });

  it('judges a typeless view against every database and every record', () => {
    const view = viewOf({
      columns: [{ field: 'stage' }, { field: 'mood' }, { field: 'legacy_flag' }, { field: 'nope' }],
    });
    expect(check(view, null)).toEqual([
      { code: 'unknown_field', name: 'nope', position: 'column' },
    ]);
  });

  it('reads a nested type’s fields through the grouping chain', () => {
    const view = viewOf({
      group: [{ field: 'epic', descend: { direction: 'forward', field: 'epic' } }],
      columns: [{ field: 'stage' }, { field: 'owner' }],
    });
    expect(check(view)).toEqual([]);
  });
});

describe('ENTRY_FIELDS follow the readers (M60.1)', () => {
  // Every candidate fact an entry carries, so a reader that starts or stops
  // resolving one fails here before checkView disagrees with the canvas.
  const CANDIDATES = [...VIRTUAL_FIELDS, 'path', 'filename', 'folder', 'snippet', 'id'];
  const bare = [
    makeEntry({
      path: 'x/b.md',
      title: 'Bravo',
      type: 'Note',
      createdAt: '2026-07-02T00:00:00Z',
      modifiedAt: '2026-07-01T00:00:00Z',
    }),
    makeEntry({
      path: 'y/a.md',
      title: 'Alpha',
      type: 'Memo',
      createdAt: '2026-07-01T00:00:00Z',
      modifiedAt: '2026-07-02T00:00:00Z',
    }),
  ];
  const schema = buildSchema(bare);

  it('filter: exactly the names evaluateFilters resolves on an entry with no properties', () => {
    const resolved = CANDIDATES.filter((field) =>
      evaluateFilters(bare[0], { all: [{ field, op: 'is_not_empty' }] }, schema),
    );
    expect(resolved).toEqual([...ENTRY_FIELDS.filter]);
  });

  it('sort: exactly the names sortEntries orders by', () => {
    const resolved = CANDIDATES.filter((field) => {
      const asc = sortEntries(bare, [{ field, dir: 'asc' }], schema).map((e) => e.path);
      const desc = sortEntries(bare, [{ field, dir: 'desc' }], schema).map((e) => e.path);
      return asc.join() !== desc.join();
    });
    expect(resolved).toEqual([...ENTRY_FIELDS.sort]);
  });
});

// --- options, operators, types ----------------------------------------------------

describe('checkView: options', () => {
  it('names a value that is neither an option nor held', () => {
    const view = viewOf(
      {},
      {
        all: [
          { field: 'priority', op: 'any_of', value: ['urgent', 'blocker'] },
          { field: 'tags', op: 'contains', value: 'design' },
        ],
      },
    );
    expect(check(view)).toEqual([
      {
        code: 'unknown_option',
        name: 'priority',
        position: 'filter',
        filterPath: [0],
        option: 'blocker',
      },
      {
        code: 'unknown_option',
        name: 'tags',
        position: 'filter',
        filterPath: [1],
        option: 'design',
      },
    ]);
  });

  it('never flags a ghost value a record holds', () => {
    const view = viewOf({}, { all: [{ field: 'priority', op: 'equals', value: 'medium' }] });
    expect(check(view)).toEqual([]);
  });

  it('takes status options from the type, then the defaults', () => {
    const own = viewOf({}, { all: [{ field: 'status', op: 'equals', value: 'progress' }] });
    expect(check(own)).toEqual([]);
    const wip = viewOf({}, { any: [{ field: 'status', op: 'equals', value: 'wip' }] });
    expect(check(wip)).toEqual([
      {
        code: 'unknown_option',
        name: 'status',
        position: 'filter',
        filterPath: [0],
        option: 'wip',
      },
    ]);
    // A type with no `statuses:` offers the defaults.
    const bare = [workItemType({ statuses: undefined }), epicType];
    const defaults = viewOf({}, { all: [{ field: 'status', op: 'equals', value: 'in-progress' }] });
    expect(check(defaults, 'Work item', bare)).toEqual([]);
    expect(check(own, 'Work item', bare).map((p) => p.option)).toEqual(['progress']);
  });

  it('checks equality and membership ops only, and skips empty values', () => {
    const view = viewOf(
      {},
      {
        all: [
          { field: 'priority', op: 'is_not_empty' },
          { field: 'priority', op: 'equals', value: '' },
        ],
      },
    );
    expect(check(view)).toEqual([]);
  });
});

describe('checkView: operators', () => {
  it('names an operator a declared field’s kind can’t take', () => {
    const view = viewOf(
      {},
      {
        all: [
          { field: 'priority', op: 'before', value: '2026-08-01' },
          { field: 'estimate', op: 'gt', value: 3 },
        ],
      },
    );
    expect(check(view)).toEqual([
      {
        code: 'op_does_not_fit',
        name: 'priority',
        position: 'filter',
        filterPath: [0],
        op: 'before',
        kind: 'select',
      },
    ]);
  });

  it('never flags an operator on a rollup', () => {
    const view = viewOf({}, { all: [{ field: 'blockers', op: 'before', value: 'x' }] });
    expect(check(view)).toEqual([]);
  });

  it('never flags an operator on an undeclared key: it evaluates by value', () => {
    const view = viewOf({}, { all: [{ field: 'legacy_flag', op: 'gt', value: 1 }] });
    expect(check(view)).toEqual([]);
  });

  it('walks nested groups and dashboard widget filters', () => {
    const view = viewOf(
      {
        type: 'dashboard',
        dashboard: {
          rows: [
            {
              id: 'r',
              widgets: [
                {
                  id: 'w1',
                  kind: 'number',
                  filter: { all: [{ field: 'estimate', op: 'contains', value: '3' }] },
                },
              ],
            },
          ],
        },
      } as Partial<ViewDefinition['presentation']>,
      { all: [{ any: [{ field: 'ghost_field', op: 'is_empty' }] }] },
    );
    expect(check(view)).toEqual([
      { code: 'unknown_field', name: 'ghost_field', position: 'filter', filterPath: [0, 0] },
      {
        code: 'op_does_not_fit',
        name: 'estimate',
        position: 'widgetFilter',
        filterPath: [0],
        widget: 'w1',
        op: 'contains',
        kind: 'number',
      },
    ]);
  });
});

describe('checkView: types, dedupe and order', () => {
  it('names a nest through a type that is not a database, once', () => {
    const view = viewOf({
      group: [
        { field: 'parent', descend: { direction: 'reverse', type: 'Task', field: 'parent' } },
      ],
    });
    // The nest's field is not named too: a type that isn't there has no fields.
    expect(check(view)).toEqual([{ code: 'unknown_type', name: 'Task', position: 'nest' }]);
  });

  it('names a nest field the nested type lacks, against that type', () => {
    const view = viewOf({
      group: [
        { field: 'parent', descend: { direction: 'reverse', type: 'Epic', field: 'parent' } },
      ],
    });
    const problems = check(view);
    expect(problems).toEqual([
      { code: 'unknown_field', name: 'parent', position: 'nest', type: 'Epic' },
    ]);
    expect(describeViewProblem(problems[0], 'Work item')).toBe(
      '“parent” in the grouping: Epic has no property by that name.',
    );
  });

  it('dedupes by code, name, position and option, keeping walk order', () => {
    const view = viewOf(
      {
        sort: [{ field: 'zeta', dir: 'asc' }],
        columns: [{ field: 'zeta' }, { field: 'alpha' }, { field: 'zeta' }],
      },
      {
        all: [
          { field: 'alpha', op: 'is_empty' },
          { field: 'alpha', op: 'is_not_empty' },
          { field: 'status', op: 'any_of', value: ['wip', 'wip'] },
        ],
      },
    );
    expect(check(view).map((p) => `${p.code}:${p.name}:${p.position}:${p.option ?? ''}`)).toEqual([
      'unknown_field:alpha:filter:',
      'unknown_option:status:filter:wip',
      'unknown_field:zeta:sort:',
      'unknown_field:zeta:column:',
      'unknown_field:alpha:column:',
    ]);
  });
});

// --- sentences ----------------------------------------------------------------------

describe('describeViewProblem', () => {
  const cases: [ViewProblem, string | null, string][] = [
    [
      { code: 'unknown_field', name: 'ghost_field', position: 'filter', filterPath: [0] },
      'Work item',
      '“ghost_field” in the filter: Work item has no property by that name.',
    ],
    [
      { code: 'unknown_field', name: 'ghost_field', position: 'column' },
      null,
      '“ghost_field” in the columns: no database has a property by that name.',
    ],
    [
      { code: 'unknown_option', name: 'status', position: 'filter', option: 'wip' },
      'Work item',
      '“wip” is not an option of Status.',
    ],
    [
      {
        code: 'op_does_not_fit',
        name: 'priority',
        position: 'filter',
        op: 'before',
        kind: 'select',
      },
      'Work item',
      "“is before” doesn't apply to Priority (Select).",
    ],
    [
      { code: 'unknown_type', name: 'Task', position: 'nest' },
      'Work item',
      'The grouping nests through “Task”, which is not a database.',
    ],
  ];
  it.each(cases)('%j', (problem, source, sentence) => {
    expect(describeViewProblem(problem, source)).toBe(sentence);
  });
});

// --- the rename leaves nothing behind (M60.2) ----------------------------------------

const VAULT = join(__dirname, '../../demo-vault');

/** A frontmatter mapping split the way the scanner splits it (CV-09). */
function split(fm: Record<string, unknown>) {
  const properties: Record<string, unknown> = {};
  const relationships: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(fm)) {
    const links = parseWikilinks(value);
    if (links !== null) relationships[key] = links;
    else properties[key] = value;
  }
  return { properties, relationships };
}

function loadPage(full: string): Entry {
  const path = relative(VAULT, full);
  const { yaml, body } = splitFrontmatter(readFileSync(full, 'utf8'));
  const fm = (yaml === null || yaml === '' ? {} : (YAML.parse(yaml) ?? {})) as Record<
    string,
    unknown
  >;
  const stem = (path.split('/').pop() ?? path).replace(/\.md$/, '');
  return makeEntry({
    path,
    title: /^# (.+)$/m.exec(body)?.[1] ?? humanize(stem),
    type: typeof fm.type === 'string' ? fm.type : null,
    ...(split(fm) as Pick<Entry, 'properties' | 'relationships'>),
  });
}

function demoVault(): Entry[] {
  const out: Entry[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.md')) out.push(loadPage(full));
    }
  };
  walk(VAULT);
  return out;
}

/** An entry with a patch op's `set` applied: null removes a key. */
function patched(e: Entry, set: Record<string, unknown>): Entry {
  const fm: Record<string, unknown> = { ...e.properties };
  for (const [key, targets] of Object.entries(e.relationships)) {
    fm[key] = targets.map((t) => `[[${t}]]`);
  }
  for (const [key, value] of Object.entries(set)) {
    if (value === null) delete fm[key];
    else fm[key] = value;
  }
  return { ...e, ...(split(fm) as Pick<Entry, 'properties' | 'relationships'>) };
}

describe('checkView after a field rename (M60.2)', () => {
  const DEMO = demoVault();
  const workItemViews = (entries: Entry[]) =>
    parseViewList(
      (entries.find((e) => e.path === 'types/work-item.md')?.properties as Record<string, unknown>)
        .views,
    );

  it('every Work item view is clean on the demo vault', () => {
    const schema = buildSchema(DEMO);
    for (const view of workItemViews(DEMO)) {
      expect(checkView(view, 'Work item', schema, DEMO), view.id).toEqual([]);
    }
  });

  it('after renaming assignee, every Work item view is still clean; the stale ones would not be', () => {
    const plan = planFieldRename(
      { type: 'Work item', from: 'assignee', to: 'assigned_to' },
      { entries: DEMO, schema: buildSchema(DEMO), lists: [] },
    );
    if (!plan.ok) throw new Error('refused');
    const sets = new Map(plan.ops.map((op) => [op.path, op.op === 'patch' ? op.set : {}]));
    const after = DEMO.map((e) => {
      const set = sets.get(e.path);
      return set === undefined ? e : patched(e, set);
    });
    const schema = buildSchema(after);
    const views = workItemViews(after);
    expect(views).toHaveLength(4);
    for (const view of views) {
      expect(checkView(view, 'Work item', schema, after), view.id).toEqual([]);
    }
    // The views as they were, against the renamed vault: every one names a
    // field nobody declares or holds any more.
    for (const view of workItemViews(DEMO)) {
      const names = checkView(view, 'Work item', schema, after).map((p) => p.name);
      expect(names, view.id).toContain('assignee');
    }
  });
});
