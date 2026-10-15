import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import type { BatchOp } from './batch';
import {
  SHAPES,
  deleteBlockedWords,
  deleteBlockers,
  groupingUses,
  formulaUses,
  listRefs,
  mapViewRefs,
  planDatabaseRename,
  planFieldRename,
  refOwner,
  renameFlagWords,
  renameRefusalWords,
  ruleAt,
  typeDefRefs,
  viewRefs,
  type RefPosition,
  type DatabaseRenameRead,
} from './fieldRefs';
import { humanize, splitFrontmatter } from './frontmatter';
import { buildSchema, parseLayoutConfig } from './schema';
import { parseViewList } from './views';
import { parseWikilinks } from './wikilink';
import { makeEntry } from '@/test/factories';
import type { Entry, ListDefinition, ListFile, TypeDef, ViewDefinition } from './types';

const typeDoc = (views: unknown[]) =>
  makeEntry({
    path: 'types/work-item.md',
    title: 'Work item',
    type: 'Type',
    properties: {
      fields: { status: { kind: 'status' }, epic: { kind: 'relation' } },
      views,
    } as unknown as Entry['properties'],
  });

const view = (id: string, presentation: Record<string, unknown>) => ({
  id,
  name: id.toUpperCase(),
  presentation: { group: [], sort: [], columns: [], ...presentation },
});

const listOver = (type: string, views: unknown[]): ListFile =>
  ({
    id: 'l',
    path: `lists/${type}.list.yml`,
    project: null,
    collection: null,
    definition: {
      name: 'L',
      icon: null,
      color: null,
      order: null,
      source: { type, project: null },
      views,
    },
  }) as unknown as ListFile;

describe('groupingUses', () => {
  it('finds a band level on the Type doc’s own views', () => {
    const doc = typeDoc([view('board', { type: 'board', group: [{ field: 'status' }] })]);
    expect(groupingUses([doc], [], 'Work item', 'status')).toEqual([
      {
        file: 'types/work-item.md',
        viewId: 'board',
        view: 'BOARD',
        layout: 'board',
        role: 'group',
        widget: null,
      },
    ]);
  });

  it('does not count a level that descends a relation', () => {
    const doc = typeDoc([
      view('tree', {
        type: 'table',
        group: [{ field: 'epic', descend: { direction: 'forward', field: 'epic' } }],
      }),
    ]);
    expect(groupingUses([doc], [], 'Work item', 'epic')).toEqual([]);
  });

  it('finds a chart’s own axis and series', () => {
    const doc = typeDoc([
      view('chart', { type: 'chart', chart: { xField: 'status', groupBy: 'status' } }),
    ]);
    expect(groupingUses([doc], [], 'Work item', 'status').map((u) => u.role)).toEqual([
      'chart-axis',
      'chart-series',
    ]);
  });

  it('finds a dashboard widget’s board and chart grouping', () => {
    const doc = typeDoc([
      view('dash', {
        type: 'dashboard',
        dashboard: {
          rows: [
            {
              id: 'r',
              widgets: [
                { id: 'b', kind: 'board', group: 'status' },
                { id: 'c', kind: 'chart', group: 'status' },
                { id: 't', kind: 'table' },
              ],
            },
          ],
        },
      }),
    ]);
    const uses = groupingUses([doc], [], 'Work item', 'status');
    expect(uses.map((u) => [u.widget, u.role])).toEqual([
      ['b', 'group'],
      ['c', 'group'],
    ]);
  });

  it('reads List files over the type and ignores the others', () => {
    const doc = typeDoc([]);
    const mine = listOver('Work item', [
      view('mine', { type: 'table', group: [{ field: 'status' }] }),
    ]);
    const theirs = listOver('Bet', [
      view('theirs', { type: 'table', group: [{ field: 'status' }] }),
    ]);
    const uses = groupingUses([doc], [mine, theirs], 'Work item', 'status');
    expect(uses.map((u) => [u.file, u.viewId])).toEqual([['lists/Work item.list.yml', 'mine']]);
  });

  it('finds nothing for a type with no Type doc and no List', () => {
    expect(groupingUses([], [], 'Ghost', 'status')).toEqual([]);
  });

  it('finds a chart’s default axis, its first band', () => {
    const doc = typeDoc([view('chart', { type: 'chart', group: [{ field: 'status' }] })]);
    expect(groupingUses([doc], [], 'Work item', 'status').map((u) => [u.layout, u.role])).toEqual([
      ['chart', 'group'],
    ]);
  });

  it('finds a dashboard board widget naming no group: it bands by the status field', () => {
    const dash = (group?: string) =>
      typeDoc([
        view('dash', {
          type: 'dashboard',
          dashboard: { rows: [{ id: 'r', widgets: [{ id: 'b', kind: 'board', group }] }] },
        }),
      ]);
    expect(groupingUses([dash()], [], 'Work item', 'status').map((u) => u.widget)).toEqual(['b']);
    expect(groupingUses([dash('epic')], [], 'Work item', 'status')).toEqual([]);
  });

  it('finds a board in a List over the type', () => {
    const list = listOver('Work item', [
      view('sprint', { type: 'board', group: [{ field: 'status' }] }),
    ]);
    expect(groupingUses([typeDoc([])], [list], 'Work item', 'status')).toEqual([
      {
        file: 'lists/Work item.list.yml',
        viewId: 'sprint',
        view: 'SPRINT',
        layout: 'board',
        role: 'group',
        widget: null,
      },
    ]);
  });

  it('follows the owner rule: another type’s view reaching the type through its nesting', () => {
    const epic = makeEntry({
      path: 'types/epic.md',
      title: 'Epic',
      type: 'Type',
      properties: {
        fields: { status: { kind: 'status' } },
        views: [
          view('by-item-status', {
            type: 'board',
            group: [
              {
                field: 'epic',
                descend: { direction: 'reverse', type: 'Work item', field: 'epic' },
              },
              { field: 'status' },
            ],
          }),
          view('by-priority', {
            type: 'board',
            group: [
              {
                field: 'epic',
                descend: { direction: 'reverse', type: 'Work item', field: 'epic' },
              },
              { field: 'priority' },
            ],
          }),
        ],
      } as unknown as Entry['properties'],
    });
    const doc = makeEntry({
      path: 'types/work-item.md',
      title: 'Work item',
      type: 'Type',
      properties: {
        fields: { status: { kind: 'status' }, priority: { kind: 'select' }, epic: 'relation' },
      } as unknown as Entry['properties'],
    });
    // Epic's own status band is Epic's: both declare it and Epic is the source.
    expect(groupingUses([doc, epic], [], 'Work item', 'status')).toEqual([]);
    // Only Work item declares priority, so the band nested under Epic is its.
    expect(groupingUses([doc, epic], [], 'Work item', 'priority').map((u) => u.viewId)).toEqual([
      'by-priority',
    ]);
  });
});

describe('deleteBlockers', () => {
  const use = (layout: string, widget: string | null = null, viewId = layout) =>
    ({ file: 'types/x.md', viewId, view: viewId, layout, role: 'group', widget }) as const;

  it('keeps boards, charts and dashboard widgets, and lets a table band go', () => {
    const uses = [use('table'), use('board'), use('chart'), use('dashboard', 'w'), use('gantt')];
    expect(deleteBlockers(uses as never).map((u) => u.layout)).toEqual([
      'board',
      'chart',
      'dashboard',
    ]);
  });

  it('names the first view, then how many more', () => {
    const sprint = { ...use('board'), view: 'Sprint' };
    expect(deleteBlockedWords('Assignee', [sprint as never])).toBe(
      "Can't delete “Assignee”: the board “Sprint” groups by it. Regroup that view first.",
    );
    expect(
      deleteBlockedWords('Assignee', [
        sprint as never,
        { ...sprint, role: 'chart-axis' } as never,
        use('chart', null, 'Load') as never,
        use('dashboard', 'w', 'Home') as never,
      ]),
    ).toBe(
      "Can't delete “Assignee”: the board “Sprint” and 2 more group by it. Regroup those views first.",
    );
  });
});

// --- the classification ---------------------------------------------------

const m = (shape: keyof typeof SHAPES, key: string) => `${shape}.${key}`;

const rule = { field: m('FilterRule', 'field'), op: 'equals', value: m('FilterRule', 'value') };

/** A view setting every key a view can store, each name naming its key. */
const maximalView = {
  id: m('ViewDefinition', 'id'),
  name: m('ViewDefinition', 'name'),
  icon: m('ViewDefinition', 'icon'),
  filters: { all: [rule, { any: [rule] }] },
  presentation: {
    type: 'dashboard',
    group: [
      { field: m('GroupSpec', 'field'), dir: 'asc', hideEmpty: true, dateBucket: 'month' },
      {
        field: m('ForwardNest', 'field'),
        descend: { direction: 'forward', field: m('ForwardNest', 'field') },
      },
      {
        field: m('ReverseNest', 'field'),
        descend: {
          direction: 'reverse',
          type: m('ReverseNest', 'type'),
          field: m('ReverseNest', 'field'),
        },
      },
    ],
    sort: [{ field: m('SortSpec', 'field'), dir: 'asc' }],
    columns: [{ field: m('ColumnSpec', 'field'), width: 90, hidden: false, wrap: true }],
    dateField: m('Presentation', 'dateField'),
    dependencyField: m('Presentation', 'dependencyField'),
    gallery: { cover: m('GallerySpec', 'cover'), fit: true },
    chart: {
      value: m('ChartSpec', 'value'),
      xField: m('ChartSpec', 'xField'),
      groupBy: m('ChartSpec', 'groupBy'),
      palette: m('ChartSpec', 'palette'),
      hidden: [m('ChartSpec', 'hidden')],
      hiddenG: [m('ChartSpec', 'hiddenG')],
    },
    dashboard: {
      global: { all: [rule] },
      rows: [
        {
          id: m('DashboardRow', 'id'),
          h: 300,
          widgets: [
            {
              id: m('DashboardWidgetBase', 'id'),
              title: m('DashboardWidgetBase', 'title'),
              kind: 'view',
              list: m('ViewWidget', 'list'),
              collection: m('ViewWidget', 'collection'),
              view: m('ViewWidget', 'view'),
              filter: { any: [rule] },
            },
            { id: 'n', kind: 'number', agg: 'sum', value: m('NumberWidget', 'value') },
            { id: 't', kind: 'table' },
            { id: 'b', kind: 'board', group: m('BoardWidget', 'group') },
            { id: 'tl', kind: 'timeline' },
            {
              id: 'c',
              kind: 'chart',
              group: m('ChartWidget', 'group'),
              chart: { xField: m('ChartSpec', 'xField') },
            },
          ],
        },
      ],
    },
  },
} as unknown as ViewDefinition;

const maximalType = {
  deadline: m('TypeDef', 'deadline'),
  name: m('TypeDef', 'name'),
  icon: m('TypeDef', 'icon'),
  color: m('TypeDef', 'color'),
  fields: [
    {
      name: m('FieldDef', 'name'),
      kind: 'rollup',
      target: m('FieldDef', 'target'),
      relation: m('FieldDef', 'relation'),
      property: m('FieldDef', 'property'),
      from: { type: m('FieldFrom', 'type'), field: m('FieldFrom', 'field') },
    },
  ],
  statuses: [],
  folder: m('TypeDef', 'folder'),
  views: [maximalView],
  display: { showEmpty: true, showFile: true, showBody: false },
  layout: {
    heading: [m('LayoutConfig', 'heading')],
    groups: [
      {
        id: m('LayoutGroup', 'id'),
        name: m('LayoutGroup', 'name'),
        fields: [m('LayoutGroup', 'fields')],
      },
    ],
  },
  tabs: [
    {
      id: m('TabDef', 'id'),
      name: m('TabDef', 'name'),
      icon: m('TabDef', 'icon'),
      content: 'view',
      source: { type: m('TypeTabSource', 'type') },
      view: m('TabDef', 'view'),
      scope: 'related',
    },
    {
      id: 'list-tab',
      name: 'List tab',
      icon: null,
      content: 'view',
      source: { list: m('ListTabSource', 'list'), collection: m('ListTabSource', 'collection') },
    },
  ],
} as unknown as TypeDef;

const maximalList = {
  name: m('ListDefinition', 'name'),
  icon: m('ListDefinition', 'icon'),
  color: m('ListDefinition', 'color'),
  order: 1,
  source: { type: m('ListSource', 'type'), project: m('ListSource', 'project') },
  views: [maximalView],
} as unknown as ListDefinition;

describe('the classification', () => {
  it('every classified key is walked', () => {
    const refs = [...typeDefRefs(maximalType), ...listRefs(maximalList)];
    const reported = new Set(refs.map((r) => r.name));
    for (const [shape, table] of Object.entries(SHAPES)) {
      for (const [key, holds] of Object.entries(table)) {
        const name = `${shape}.${key}`;
        if (holds === 'field' || holds === 'fields' || holds === 'type') {
          expect(reported.has(name), `${name} is ${holds} but the walk never reports it`).toBe(
            true,
          );
        } else {
          expect(reported.has(name), `${name} holds ${holds} but the walk reports it`).toBe(false);
        }
      }
    }
  });

  it('reports each view name at its position, in walk order', () => {
    const at = viewRefs(maximalView).map((r) => [r.name, r.position, r.holds, r.widget ?? null]);
    const expected: [string, RefPosition, 'field' | 'type', string | null][] = [
      [m('FilterRule', 'field'), 'filter', 'field', null],
      [m('FilterRule', 'field'), 'filter', 'field', null],
      [m('GroupSpec', 'field'), 'band', 'field', null],
      [m('ForwardNest', 'field'), 'nest', 'field', null],
      [m('ReverseNest', 'type'), 'nest', 'type', null],
      [m('ReverseNest', 'field'), 'nest', 'field', null],
      [m('SortSpec', 'field'), 'sort', 'field', null],
      [m('ColumnSpec', 'field'), 'column', 'field', null],
      [m('Presentation', 'dateField'), 'dateField', 'field', null],
      [m('Presentation', 'dependencyField'), 'dependencyField', 'field', null],
      [m('GallerySpec', 'cover'), 'galleryCover', 'field', null],
      [m('ChartSpec', 'value'), 'chartValue', 'field', null],
      [m('ChartSpec', 'xField'), 'chartAxis', 'field', null],
      [m('ChartSpec', 'groupBy'), 'chartSeries', 'field', null],
      [m('FilterRule', 'field'), 'widgetFilter', 'field', m('DashboardWidgetBase', 'id')],
      [m('NumberWidget', 'value'), 'widgetValue', 'field', 'n'],
      [m('BoardWidget', 'group'), 'widgetGroup', 'field', 'b'],
      [m('ChartWidget', 'group'), 'widgetGroup', 'field', 'c'],
      [m('ChartSpec', 'xField'), 'chartAxis', 'field', 'c'],
      [m('FilterRule', 'field'), 'dashboardFilter', 'field', null],
    ];
    expect(at).toEqual(expected);
  });

  it('numbers band and nest levels apart, and finds each filter rule by its path', () => {
    const refs = viewRefs(maximalView);
    expect(refs.filter((r) => r.position === 'band').map((r) => r.level)).toEqual([0]);
    expect(refs.filter((r) => r.position === 'nest').map((r) => r.level)).toEqual([0, 1, 1]);
    const filters = refs.filter((r) => r.filterPath !== undefined);
    expect(filters.map((r) => r.filterPath)).toEqual([[0], [1, 0], [0], [0]]);
    for (const ref of filters) expect(ruleAt(maximalView, ref)).toEqual(rule);
  });

  it('mapViewRefs rewrites a copy, and a nest level keeps field === descend.field', () => {
    const before = JSON.stringify(maximalView);
    const next = mapViewRefs(maximalView, (ref) => `${ref.name}!`);
    expect(JSON.stringify(maximalView)).toBe(before);
    expect(viewRefs(next).map((r) => r.name)).toEqual(
      viewRefs(maximalView).map((r) => `${r.name}!`),
    );
    for (const g of next.presentation.group) {
      if (g.descend !== undefined) expect(g.field).toBe(g.descend.field);
    }
    // Values are never names.
    expect(next.presentation.chart?.hidden).toEqual([m('ChartSpec', 'hidden')]);
    expect((next.filters as { all: { value: string }[] }).all[0].value).toBe(
      m('FilterRule', 'value'),
    );
  });
});

// --- the demo vault -------------------------------------------------------

const VAULT = join(__dirname, '../../demo-vault');

/** One demo-vault page, parsed the way the scanner splits it. */
function loadPage(full: string): Entry {
  const path = relative(VAULT, full);
  const { yaml, body } = splitFrontmatter(readFileSync(full, 'utf8'));
  const fm = (yaml === null || yaml === '' ? {} : (YAML.parse(yaml) ?? {})) as Record<
    string,
    unknown
  >;
  const properties: Record<string, unknown> = {};
  const relationships: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(fm)) {
    const links = parseWikilinks(value);
    if (links !== null) relationships[key] = links;
    else properties[key] = value;
  }
  const stem = (path.split('/').pop() ?? path).replace(/\.md$/, '');
  return makeEntry({
    path,
    title: /^# (.+)$/m.exec(body)?.[1] ?? humanize(stem),
    type: typeof fm.type === 'string' ? fm.type : null,
    properties: properties as Entry['properties'],
    relationships,
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

const DEMO = demoVault();

const sourceRead = (content: string): DatabaseRenameRead => ({
  content,
  hash: createHash('sha256').update(content).digest('hex'),
});
const demoReads = () =>
  new Map(
    DEMO.map((entry) => [entry.path, sourceRead(readFileSync(join(VAULT, entry.path), 'utf8'))]),
  );

function databasePlan(
  from: string,
  to: string,
  entries = DEMO,
  reads = demoReads(),
  lists: ListFile[] = [],
) {
  const result = planDatabaseRename(
    { from, to },
    { entries, schema: buildSchema(entries), lists, reads },
  );
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.refusal)}`);
  return result;
}

describe('planDatabaseRename (M60.11)', () => {
  it('retags the demo’s 45 work items and rewrites every stored database reference in one plan', () => {
    const reads = demoReads();
    const result = databasePlan('Work item', 'Task', DEMO, reads);
    expect(result.flagged).toEqual([]);
    expect(result.counts).toEqual({
      typeDocs: 4,
      schemaReferences: 6,
      records: 45,
      pointers: 3,
      views: 0,
    });
    const retags = result.ops.filter((op) => op.op === 'patch' && op.set.type === 'Task');
    expect(retags).toHaveLength(45);
    expect(retags.map((op) => op.path)).toEqual(
      DEMO.filter((e) => e.type === 'Work item')
        .map((e) => e.path)
        .sort(),
    );
    expect(patchOf(result.ops, 'types/work-item.md').folder).toBeUndefined();
    expect(fieldsOf(patchOf(result.ops, 'types/work-item.md')).blocked_by).toEqual({
      kind: 'relation',
      target: 'Task',
    });
    expect(fieldsOf(patchOf(result.ops, 'types/key-result.md')).deliverables).toEqual({
      kind: 'relation',
      target: 'Task',
    });
    expect(fieldsOf(patchOf(result.ops, 'types/epic.md')).progress).toMatchObject({
      from: { type: 'Task', field: 'epic' },
    });
    expect(fieldsOf(patchOf(result.ops, 'types/project.md')).progress).toMatchObject({
      from: { type: 'Task', field: 'project' },
      calculate: 'percent_done',
    });
    expect(patchOf(result.ops, 'types/project.md').tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'tasks', source: { type: 'Task' }, scope: 'related' }),
      ]),
    );
    expect(patchOf(result.ops, 'types/epic.md').tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'work-items', source: { type: 'Task' }, scope: 'related' }),
      ]),
    );
    expect(result.ops.filter((op) => op.path === 'types/work-item.md').map((op) => op.op)).toEqual([
      'patch',
      'body',
    ]);
    const ownBody = result.ops.find((op) => op.path === 'types/work-item.md' && op.op === 'body');
    expect(ownBody).toMatchObject({
      body: splitFrontmatter(reads.get('types/work-item.md')!.content).body.replace(
        '# Work item',
        '# Task',
      ),
    });
    const delivery = result.ops.filter((op) => op.path === 'delivery/delivery.md');
    expect(delivery).toHaveLength(1);
    expect(delivery[0]).toEqual({
      op: 'replace_file',
      path: 'delivery/delivery.md',
      content: reads
        .get('delivery/delivery.md')!
        .content.replaceAll('database: Work item', 'database: Task'),
      expectHash: reads.get('delivery/delivery.md')!.hash,
    });
    for (const op of result.ops) expect(op.expectHash).toBe(reads.get(op.path)!.hash);
    expect(new Set(result.ops.map((op) => op.path)).size).toBe(50);
  });

  it('pins only an existing implicit record home, never moves the Type doc', () => {
    const result = databasePlan('Epic', 'Programme');
    expect(patchOf(result.ops, 'types/epic.md').folder).toBe('records/epics');
    expect(result.ops.some((op) => op.path === 'types/programme.md')).toBe(false);
    const own = makeEntry({ path: 'types/empty.md', title: 'Empty', type: 'Type' });
    const reads = new Map([[own.path, sourceRead('---\ntype: Type\n---\n# Empty\n')]]);
    const empty = databasePlan('Empty', 'Renamed', [own], reads);
    expect(empty.ops).toHaveLength(1);
    expect(empty.ops[0].op).toBe('body');
  });

  it('flags Lists and knowledge references without changing them or counting them as rewrites', () => {
    const entry = makeEntry({ path: 'knowledge/concept.md', title: 'Concept', type: 'Work item' });
    const reads = demoReads();
    reads.set(
      entry.path,
      sourceRead(
        '---\ntype: Work item\n---\n# Concept\n```cerebro-database\ndatabase: Work item\n```\n',
      ),
    );
    const list = listOver('Work item', []);
    const result = databasePlan('Work item', 'Task', [...DEMO, entry], reads, [list]);
    expect(result.flagged).toEqual([
      { kind: 'knowledge', path: entry.path },
      { kind: 'list', path: list.path },
    ]);
    expect(result.ops.some((op) => op.path === entry.path || op.path === list.path)).toBe(false);
    expect(result.counts.records).toBe(45);
    expect(result.counts.pointers).toBe(3);
  });

  it('combines retag and pointer rewrite as patch then body, with exact source preconditions', () => {
    const entry = makeEntry({ path: 'templates/work.md', type: 'Work item' });
    const reads = demoReads();
    const content =
      '---\ntype: Work item\nother: keep\n---\n# Template\n```cerebro-database\ndatabase: Work item\nview: all\n```\n';
    reads.set(entry.path, sourceRead(content));
    const result = databasePlan('Work item', 'Task', [...DEMO, entry], reads);
    expect(result.ops.filter((op) => op.path === entry.path)).toEqual([
      {
        op: 'patch',
        path: entry.path,
        set: { type: 'Task' },
        expectHash: reads.get(entry.path)!.hash,
      },
      {
        op: 'body',
        path: entry.path,
        body: splitFrontmatter(content).body.replace('database: Work item', 'database: Task'),
        expectHash: reads.get(entry.path)!.hash,
      },
    ]);
  });

  it('preserves raw field additions and uses the read’s fields instead of an earlier scan', () => {
    const reads = demoReads();
    const path = 'types/work-item.md';
    const old = reads.get(path)!.content;
    reads.set(
      path,
      sourceRead(
        old.replace(
          'blocked_by: { kind: relation, target: Work item }',
          'blocked_by: { kind: relation, target: Work item, future: kept }\n  custom: { kind: future, from: { type: Work item, field: edge, other: kept } }',
        ),
      ),
    );
    const result = databasePlan('Work item', 'Task', DEMO, reads);
    const fields = fieldsOf(patchOf(result.ops, path));
    expect(fields.blocked_by).toEqual({ kind: 'relation', target: 'Task', future: 'kept' });
    expect(fields.custom).toEqual({
      kind: 'future',
      from: { type: 'Task', field: 'edge', other: 'kept' },
    });
    expect(result.counts.schemaReferences).toBe(7);
  });

  it('walks reverse nests and tab sources while leaving ordinary text and view ids alone', () => {
    const own = makeEntry({ path: 'types/a.md', title: 'A', type: 'Type' });
    const other = makeEntry({ path: 'types/b.md', title: 'B', type: 'Type' });
    const reads = new Map([
      [own.path, sourceRead('---\ntype: Type\n---\n# A\n')],
      [
        other.path,
        sourceRead(
          '---\ntype: Type\nviews:\n- id: A\n  name: A\n  presentation:\n    type: table\n    group:\n    - field: link\n      descend: { direction: reverse, type: A, field: link }\ntabs:\n- { id: A, name: A, content: view, source: { type: A }, view: A }\n---\n# B\nA stays prose.\n',
        ),
      ],
    ]);
    const result = databasePlan('A', 'Next', [own, other], reads);
    expect(result.counts.schemaReferences).toBe(2);
    expect(result.counts.views).toBe(1);
    const patch = patchOf(result.ops, other.path);
    expect(parseViewList(patch.views)[0]).toMatchObject({
      id: 'A',
      name: 'A',
      presentation: { group: [{ descend: { type: 'Next', field: 'link' } }] },
    });
    expect(patch.tabs).toEqual([
      expect.objectContaining({ id: 'A', name: 'A', source: { type: 'Next' }, view: 'A' }),
    ]);
  });

  it('flags missing reads, changed scan snapshots and broken YAML, and refuses an unavailable own doc', () => {
    const reads = demoReads();
    reads.delete('types/key-result.md');
    reads.set('types/epic.md', sourceRead('---\ntype: Type\nfields: [\n---\n# Epic\n'));
    const record = DEMO.find((entry) => entry.type === 'Work item')!;
    const entries = DEMO.map((entry) =>
      entry === record ? { ...entry, hash: 'old-scan-hash' } : entry,
    );
    const result = databasePlan('Work item', 'Task', entries, reads);
    expect(result.flagged).toEqual(
      expect.arrayContaining([
        { kind: 'readFailed', path: 'types/key-result.md' },
        { kind: 'yamlError', path: 'types/epic.md' },
        { kind: 'readFailed', path: record.path, detail: 'Changed since the scan' },
      ]),
    );
    expect(
      result.ops.some((op) =>
        ['types/key-result.md', 'types/epic.md', record.path].includes(op.path),
      ),
    ).toBe(false);
    reads.delete('types/work-item.md');
    expect(
      planDatabaseRename(
        { from: 'Work item', to: 'Task' },
        { entries, schema: buildSchema(entries), lists: [], reads },
      ),
    ).toEqual({ ok: false, refusal: { code: 'sourceUnavailable', path: 'types/work-item.md' } });
    reads.set('types/work-item.md', sourceRead('---\ntype: Type\nfields: [\n---\n# Work item\n'));
    expect(
      planDatabaseRename(
        { from: 'Work item', to: 'Task' },
        { entries, schema: buildSchema(entries), lists: [], reads },
      ),
    ).toEqual({ ok: false, refusal: { code: 'sourceInvalid', path: 'types/work-item.md' } });
  });
});

function plan(type: string, from: string, to: string, entries = DEMO, lists: ListFile[] = []) {
  const result = planFieldRename(
    { type, from, to },
    { entries, schema: buildSchema(entries), lists },
  );
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.refusal)}`);
  return result;
}

const patchOf = (ops: BatchOp[], path: string): Record<string, unknown> => {
  const op = ops.find((o) => o.op === 'patch' && o.path === path);
  if (op === undefined || op.op !== 'patch') throw new Error(`no patch on ${path}`);
  return op.set;
};

const fieldsOf = (set: Record<string, unknown>) => set.fields as Record<string, unknown>;

describe('planFieldRename on the demo vault', () => {
  const workItems = DEMO.filter((e) => e.type === 'Work item');

  it('renaming Work item’s assignee rewrites its four views, the planning group and every record, and nothing else', () => {
    expect(workItems).toHaveLength(45);
    const p = plan('Work item', 'assignee', 'assigned_to');
    expect(p.flagged).toEqual([]);
    expect(p.counts).toEqual({ typeDocs: 1, views: 4, records: 45 });
    expect(p.ops.map((o) => o.path)).toEqual([
      'types/work-item.md',
      ...workItems.map((e) => e.path).sort(),
    ]);

    const doc = patchOf(p.ops, 'types/work-item.md');
    expect(Object.keys(doc).sort()).toEqual(['fields', 'layout', 'views']);
    // The key keeps its slot in the mapping.
    expect(Object.keys(fieldsOf(doc))).toEqual([
      'status',
      'priority',
      'assigned_to',
      'due',
      'window',
      'estimate',
      'epic',
      'blocked_by',
      'project',
    ]);
    const views = parseViewList(doc.views);
    expect(views.map((v) => v.id)).toEqual([
      'all',
      'at-risk-work',
      'this-month',
      'delivery-schedule',
    ]);
    for (const view of views) {
      const names = viewRefs(view).map((r) => r.name);
      expect(names, view.id).toContain('assigned_to');
      expect(names, view.id).not.toContain('assignee');
    }
    expect(parseLayoutConfig(doc.layout)).toEqual({
      heading: ['status', 'priority'],
      groups: [{ id: 'planning', name: 'Planning', fields: ['assigned_to', 'due', 'estimate'] }],
    });

    const fld1 = patchOf(p.ops, 'projects/guided-onboarding-ga/items/fld-1.md');
    expect(fld1).toEqual({ assigned_to: '[[ana-rios]]', assignee: null });
  });

  it('Key result’s objective follows into the OKR tree’s reverse nest', () => {
    const p = plan('Key result', 'objective', 'goal');
    expect(Object.keys(fieldsOf(patchOf(p.ops, 'types/key-result.md')))).toContain('goal');
    const tree = parseViewList(patchOf(p.ops, 'types/objective.md').views)[0];
    expect(tree.presentation.group[0]).toEqual({
      field: 'goal',
      descend: { direction: 'reverse', type: 'Key result', field: 'goal' },
    });
    expect(tree.presentation.group[1].field).toBe('deliverables');
  });

  it('Key result’s deliverables follows into the second nest level', () => {
    const p = plan('Key result', 'deliverables', 'outputs');
    const tree = parseViewList(patchOf(p.ops, 'types/objective.md').views)[0];
    expect(tree.presentation.group[1]).toEqual({
      field: 'outputs',
      descend: { direction: 'forward', field: 'outputs' },
    });
    expect(tree.presentation.group[0].field).toBe('objective');
  });

  it('Key result’s attainment follows into Objective’s progress rollup', () => {
    const p = plan('Key result', 'attainment', 'score');
    const objective = fieldsOf(patchOf(p.ops, 'types/objective.md'));
    expect(objective.progress).toEqual({
      kind: 'rollup',
      relation: 'key_results',
      property: 'score',
      calculate: 'avg',
      format: 'progress',
      precision: 0,
    });
    expect(patchOf(p.ops, 'types/objective.md').views).toBeUndefined();
  });

  it('Work item’s epic follows into Epic’s from.field', () => {
    const p = plan('Work item', 'epic', 'parent_epic');
    const epic = fieldsOf(patchOf(p.ops, 'types/epic.md'));
    expect(epic.progress).toEqual({
      kind: 'rollup',
      from: { type: 'Work item', field: 'parent_epic' },
      property: 'status',
      calculate: 'count',
    });
  });

  it('Work item’s status follows into Epic’s rollup property and flags the OKR tree’s column', () => {
    const p = plan('Work item', 'status', 'state');
    expect(
      (fieldsOf(patchOf(p.ops, 'types/epic.md')).progress as { property: string }).property,
    ).toBe('state');
    expect(p.flagged).toEqual([
      { kind: 'ambiguous', path: 'types/objective.md', detail: 'okr-tree' },
    ]);
    // The ambiguous column is left as written, so Objective's doc is not touched.
    expect(p.ops.some((o) => o.path === 'types/objective.md')).toBe(false);
  });

  it('leaves a filter on status in an Objective view alone: Objective declares it', () => {
    const entries = DEMO.map((e) => {
      if (e.path !== 'types/objective.md') return e;
      const views = (e.properties as Record<string, unknown>).views as unknown[];
      const atRisk = {
        id: 'at-risk',
        name: 'At risk',
        icon: null,
        filters: { all: [{ field: 'status', op: 'equals', value: 'at-risk' }] },
        presentation: { type: 'table', group: [], sort: [], columns: [{ field: 'status' }] },
      };
      return {
        ...e,
        properties: { ...e.properties, views: [...views, atRisk] } as Entry['properties'],
      };
    });
    const p = plan('Work item', 'status', 'state', entries);
    expect(p.ops.some((o) => o.path === 'types/objective.md')).toBe(false);
    expect(p.flagged).toEqual([
      { kind: 'ambiguous', path: 'types/objective.md', detail: 'okr-tree' },
    ]);
  });
});

// --- refusals and flags ---------------------------------------------------

const recipeDoc = (fields: Record<string, unknown>, views: unknown[] = []) =>
  makeEntry({
    path: 'types/recipe.md',
    title: 'Recipe',
    type: 'Type',
    hash: 'd'.repeat(64),
    properties: { fields, views } as unknown as Entry['properties'],
  });

const recipe = (path: string, properties: Record<string, unknown>, hash: string | null = null) =>
  makeEntry({
    path,
    title: path,
    type: 'Recipe',
    properties: properties as Entry['properties'],
    hash,
  });

const listFile = (path: string, type: string | null, views: unknown[]): ListFile =>
  ({
    id: path,
    path,
    project: null,
    collection: null,
    definition: {
      name: path,
      icon: null,
      color: null,
      order: null,
      source: { type, project: null },
      views,
    },
  }) as unknown as ListFile;

const tableOn = (field: string) => ({
  id: 'v',
  name: 'V',
  icon: null,
  filters: null,
  presentation: {
    type: 'table',
    group: [],
    sort: [{ field: 'title', dir: 'asc' }],
    columns: [{ field }],
  },
});

describe('planFieldRename refusals and flags', () => {
  it('refuses the whole rename when a record already holds the new key', () => {
    const entries = [
      recipeDoc({ cuisine: 'text' }),
      recipe('recipes/a.md', { cuisine: 'thai', flavor: 'hot' }),
      recipe('recipes/b.md', { flavor: 'mild' }),
      recipe('recipes/c.md', { cuisine: 'oaxacan' }),
    ];
    expect(
      planFieldRename(
        { type: 'Recipe', from: 'cuisine', to: 'flavor' },
        { entries, schema: buildSchema(entries), lists: [] },
      ),
    ).toEqual({ ok: false, refusal: { code: 'collision', holders: 2 } });
    expect(renameRefusalWords(2, 'flavor')).toBe(
      '2 records already have “flavor”. Nothing was renamed.',
    );
    expect(renameRefusalWords(1, 'flavor')).toBe(
      '1 record already has “flavor”. Nothing was renamed.',
    );
  });

  it('flags list files, agent triggers, untargeted rollups and knowledge records, and never writes them', () => {
    const entries = [
      recipeDoc({ cuisine: 'text' }),
      recipe('recipes/a.md', { cuisine: 'thai' }, 'a'.repeat(64)),
      recipe('knowledge/recipes/k.md', { cuisine: 'thai' }),
      makeEntry({
        path: 'types/menu.md',
        title: 'Menu',
        type: 'Type',
        properties: {
          fields: {
            dishes: { kind: 'relation' },
            cuisines: {
              kind: 'rollup',
              relation: 'dishes',
              property: 'cuisine',
              calculate: 'show',
            },
          },
        } as unknown as Entry['properties'],
      }),
      makeEntry({
        path: 'records/agents/chef.md',
        title: 'Chef',
        type: 'Agent',
        properties: {
          when: [{ event: 'changed', field: 'cuisine' }],
        } as unknown as Entry['properties'],
      }),
    ];
    const lists = [
      listFile('lists/typed.list.yml', 'Recipe', [tableOn('cuisine')]),
      listFile('lists/typeless.list.yml', null, [tableOn('cuisine')]),
      listFile('lists/other.list.yml', 'Recipe', [tableOn('title')]),
    ];
    const p = plan('Recipe', 'cuisine', 'kitchen', entries, lists);
    expect(p.flagged).toEqual([
      { kind: 'untargetedRollup', path: 'types/menu.md', detail: 'cuisines' },
      { kind: 'knowledge', path: 'knowledge/recipes/k.md' },
      { kind: 'trigger', path: 'records/agents/chef.md' },
      { kind: 'list', path: 'lists/typed.list.yml' },
      { kind: 'list', path: 'lists/typeless.list.yml' },
    ]);
    const flaggedPaths = new Set(p.flagged.map((f) => f.path));
    expect(p.ops.filter((o) => flaggedPaths.has(o.path))).toEqual([]);
    expect(renameFlagWords(p.flagged, 'cuisine')).toBe(
      'Not changed: 2 list files still name “cuisine”. ' +
        'Not changed: 1 agent trigger still names “cuisine”. ' +
        'Not changed: 1 rollup reads “cuisine” through a relation with no target. ' +
        'Not changed: 1 knowledge page still holds “cuisine”.',
    );
    expect(renameFlagWords([], 'cuisine')).toBeNull();
  });

  it('sends one op per path, Type docs first, hashed only when the scan knows the bytes', () => {
    const entries = [
      recipeDoc({ cuisine: 'text' }, [tableOn('cuisine')]),
      recipe('recipes/b.md', { cuisine: 'thai' }),
      recipe('recipes/a.md', { cuisine: 'oaxacan' }, 'a'.repeat(64)),
      recipe('recipes/c.md', { other: 1 }),
    ];
    const p = plan('Recipe', 'cuisine', 'kitchen', entries);
    expect(p.ops).toEqual([
      {
        op: 'patch',
        path: 'types/recipe.md',
        set: {
          fields: { kitchen: 'text' },
          views: [
            {
              id: 'v',
              name: 'V',
              icon: null,
              filters: null,
              presentation: {
                type: 'table',
                group: [],
                sort: [{ field: 'title', dir: 'asc' }],
                columns: [{ field: 'kitchen' }],
              },
            },
          ],
        },
        expectHash: 'd'.repeat(64),
      },
      {
        op: 'patch',
        path: 'recipes/a.md',
        set: { kitchen: 'oaxacan', cuisine: null },
        expectHash: 'a'.repeat(64),
      },
      { op: 'patch', path: 'recipes/b.md', set: { kitchen: 'thai', cuisine: null } },
    ]);
  });

  it('moves links as frontmatter spells them: one as a scalar, several as a list', () => {
    const linked = (path: string, targets: string[]) =>
      makeEntry({ path, title: path, type: 'Recipe', relationships: { cuisine: targets } });
    const p = plan('Recipe', 'cuisine', 'kitchen', [
      recipeDoc({ cuisine: 'relation' }),
      linked('recipes/one.md', ['thai']),
      linked('recipes/two.md', ['thai', 'oaxacan']),
    ]);
    expect(patchOf(p.ops, 'recipes/one.md')).toEqual({ kitchen: '[[thai]]', cuisine: null });
    expect(patchOf(p.ops, 'recipes/two.md')).toEqual({
      kitchen: ['[[thai]]', '[[oaxacan]]'],
      cuisine: null,
    });
  });

  it('keeps keys the model does not parse on every spec it edits', () => {
    const entries = [recipeDoc({ cuisine: { kind: 'text', hint: 'free text', 'x-legacy': true } })];
    const p = plan('Recipe', 'cuisine', 'kitchen', entries);
    expect(fieldsOf(patchOf(p.ops, 'types/recipe.md'))).toEqual({
      kitchen: { kind: 'text', hint: 'free text', 'x-legacy': true },
    });
  });

  it('flags a Type doc it cannot read, and still renames the rest', () => {
    const broken = makeEntry({
      path: 'types/broken.md',
      title: 'Broken',
      type: 'Type',
      parseError: 'bad indentation',
    });
    const p = plan('Recipe', 'cuisine', 'kitchen', [recipeDoc({ cuisine: 'text' }), broken]);
    expect(p.flagged).toEqual([{ kind: 'yamlError', path: 'types/broken.md' }]);
    expect(p.ops.map((o) => o.path)).toEqual(['types/recipe.md']);
    expect(renameFlagWords(p.flagged, 'cuisine')).toBe(
      'Not changed: 1 type doc has YAML errors and was not checked.',
    );
  });
});

describe('refOwner', () => {
  const schema = buildSchema(DEMO);
  const okr = parseViewList(
    (DEMO.find((e) => e.path === 'types/objective.md')!.properties as Record<string, unknown>)
      .views,
  )[0];
  const scope = { source: { type: 'Objective', project: null }, group: okr.presentation.group };

  it('gives a nest its exact owner and a column with several declarers to nobody', () => {
    const refs = viewRefs(okr);
    const nests = refs.filter((r) => r.position === 'nest' && r.holds === 'field');
    expect(nests.map((r) => refOwner(r, scope, schema))).toEqual([
      { owner: 'Key result' },
      { owner: 'Key result' },
    ]);
    const status = refs.find((r) => r.position === 'column' && r.name === 'status')!;
    expect(refOwner(status, scope, schema)).toEqual({
      ambiguous: ['Objective', 'Key result', 'Work item'],
    });
    const progress = refs.find((r) => r.position === 'column' && r.name === 'progress')!;
    // Epic declares a progress too, but Epic is not in this view's chain.
    expect(refOwner(progress, scope, schema)).toEqual({ owner: 'Objective' });
  });

  it('gives a source-scoped ref to the source when the source declares it', () => {
    expect(refOwner({ name: 'status', holds: 'field', position: 'sort' }, scope, schema)).toEqual({
      owner: 'Objective',
    });
    expect(refOwner({ name: 'title', holds: 'field', position: 'sort' }, scope, schema)).toBeNull();
  });
});

it('renames a declared deadline in the same Type-doc patch (M61.3b)', () => {
  const doc = makeEntry({
    path: 'types/dated.md',
    title: 'Dated',
    type: 'Type',
    properties: { deadline: 'due', fields: { due: { kind: 'date' } } } as never,
  });
  const result = planFieldRename(
    { type: 'Dated', from: 'due', to: 'finish' },
    { entries: [doc], schema: buildSchema([doc]), lists: [] },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(patchOf(result.ops, doc.path)).toEqual({
    fields: { finish: { kind: 'date' } },
    deadline: 'finish',
  });
});

describe('formula references (M61.4)', () => {
  const doc = makeEntry({
    path: 'types/metric.md',
    title: 'Metric',
    type: 'Type',
    properties: {
      fields: {
        target_value: { kind: 'number' },
        current: { kind: 'number' },
        gap: { kind: 'formula', formula: '{Target value} - current' },
        broken: { kind: 'formula', formula: 'target_value +' },
        prose: { kind: 'text', formula: 'target_value' },
      },
    } as never,
  });
  const schema = buildSchema([doc]);

  it('classifies formula inputs and finds the formula that holds an input', () => {
    expect(formulaUses([doc], 'Metric', 'target_value')).toEqual([
      { path: doc.path, field: 'gap' },
    ]);
    expect(
      typeDefRefs(schema.types.get('Metric')!).filter((ref) => ref.position === 'formulaRef'),
    ).toEqual([
      expect.objectContaining({ name: 'target_value', field: 'gap' }),
      expect.objectContaining({ name: 'current', field: 'gap' }),
    ]);
  });

  it('renames canonical formula references in the same patch and flags unreadable expressions', () => {
    const plan = planFieldRename(
      { type: 'Metric', from: 'target_value', to: 'Target' },
      { entries: [doc], schema, lists: [] },
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.ops[0].set?.fields).toMatchObject({
      Target: { kind: 'number' },
      gap: { kind: 'formula', formula: 'Target - current' },
      broken: { kind: 'formula', formula: 'target_value +' },
      prose: { kind: 'text', formula: 'target_value' },
    });
    expect(plan.flagged).toContainEqual({ kind: 'formula', path: doc.path, detail: 'broken' });
    expect(renameFlagWords(plan.flagged, 'target_value')).toBe(
      "Not changed: the formula “Broken” couldn't be read.",
    );
  });
});
