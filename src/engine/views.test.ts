import { describe, expect, it } from 'vitest';
import { FILTER_OPS, VIEW_TYPES } from '@/engine/types';
import {
  clonePresentation,
  layoutLabel,
  moveSortKey,
  moveView,
  newView,
  nextViewId,
  parseListYaml,
  replaceView,
  resolveView,
  serializeList,
} from './views';
import type { FilterGroup, ListDefinition, ListFile, Presentation, SortSpec } from './types';

// M19.1: `group` and `columns` are empty here on purpose. A default
// presentation is what a view looks like before anything is known about its
// source, and both of those name FIELDS — which is why this fixture used to
// carry a Jira issue's six (key/status/priority/assignee/due/estimate) and a
// status band, and why a fresh type opened on six columns nothing declared.
const DEFAULT_LIST_PRESENTATION = {
  type: 'list',
  group: [],
  sort: [{ field: 'modifiedAt', dir: 'desc' }],
  columns: [],
  rowHeight: undefined,
};

const NO_SOURCE = { type: null, project: null };

/**
 * M11: a List holds views. A pre-M11 file's `presentation`/`filters` migrate
 * into its FIRST view, so these read that one — which is what "the view" meant
 * before there could be more than one.
 */
const firstView = (list: ListFile) => list.definition.views[0];
const presentationOf = (list: ListFile) => firstView(list).presentation;
const filtersOf = (list: ListFile) => firstView(list).filters;

/** A one-view List, for the round-trip cases. */
function oneView(
  base: Omit<ListDefinition, 'views'>,
  presentation: Presentation,
  filters: FilterGroup | null = null,
  name = layoutLabel(presentation.type),
): ListDefinition {
  return { ...base, views: [{ id: 'view', name, icon: null, filters, presentation }] };
}

const ACTIVE_WORK_YAML = `name: Active work
icon: flame
color: '#DE8F0A'
order: 2
source:
  type: Work item
filters:
  all:
    - { field: type, op: equals, value: Work item }
    - any:
        - { field: status, op: any_of, value: [todo, doing] }
        - { field: priority, op: equals, value: urgent }
presentation:
  type: board
  groupBy: status
  orderBy: { field: due, dir: asc }
  visibleFields: [key, status, assignee]
`;

describe('parseListYaml', () => {
  it('parses a complete view file', () => {
    expect(parseListYaml('active-work', ACTIVE_WORK_YAML)).toEqual({
      id: 'active-work',
      project: null,
      collection: null,
      // Defaulted when the caller states no path — the store passes the real
      // one from the scan.
      path: 'active-work.list.yml',
      definition: {
        name: 'Active work',
        icon: 'flame',
        color: '#DE8F0A',
        order: 2,
        source: { type: 'Work item', project: null },
        // M11: the pre-M11 single view, migrated. It is named after its
        // layout because the file never gave it a name of its own.
        views: [
          {
            id: 'view',
            name: 'Board',
            icon: null,
            filters: {
              all: [
                { field: 'type', op: 'equals', value: 'Work item' },
                {
                  any: [
                    { field: 'status', op: 'any_of', value: ['todo', 'doing'] },
                    { field: 'priority', op: 'equals', value: 'urgent' },
                  ],
                },
              ],
            },
            presentation: {
              type: 'board',
              group: [{ field: 'status' }],
              sort: [{ field: 'due', dir: 'asc' }],
              columns: [{ field: 'key' }, { field: 'status' }, { field: 'assignee' }],
              rowHeight: undefined,
            },
          },
        ],
      },
    });
  });

  it('carries the project scope through (Task 6)', () => {
    const scoped = parseListYaml('delivery', 'name: Delivery\n', {
      project: 'projects/atlas/project.md',
    });
    expect(scoped.project).toBe('projects/atlas/project.md');
    expect(parseListYaml('global', 'name: G\n').project).toBeNull();
  });

  it('bad yaml falls back to name = id and the default list presentation', () => {
    const view = parseListYaml('mystery', 'a: [1, 2');
    expect(view.definition).toEqual({
      name: 'mystery',
      icon: null,
      color: null,
      order: null,
      source: NO_SOURCE,
      views: [
        {
          id: 'view',
          name: 'List',
          icon: null,
          filters: null,
          presentation: DEFAULT_LIST_PRESENTATION,
        },
      ],
    });
  });

  it('a scalar yaml document gets full defaults', () => {
    const view = parseListYaml('plain', 'just some text');
    expect(view.definition.name).toBe('plain');
    expect(presentationOf(view)).toEqual(DEFAULT_LIST_PRESENTATION);
  });

  it('an empty file gets full defaults', () => {
    expect(presentationOf(parseListYaml('empty', ''))).toEqual(DEFAULT_LIST_PRESENTATION);
  });

  it('missing presentation fields fall back individually', () => {
    const view = parseListYaml('partial', 'name: Partial\npresentation:\n  type: board\n');
    expect(presentationOf(view)).toEqual({ ...DEFAULT_LIST_PRESENTATION, type: 'board' });
  });

  it('an explicit groupBy null stays flat', () => {
    const view = parseListYaml('flat', 'presentation:\n  groupBy: null\n');
    expect(presentationOf(view).group).toEqual([]);
  });

  it('drops malformed filter rules but keeps valid ones', () => {
    const view = parseListYaml(
      'broken',
      'filters:\n  all:\n    - { field: status }\n    - { field: status, op: equals, value: done }\n',
    );
    expect(filtersOf(view)).toEqual({
      all: [{ field: 'status', op: 'equals', value: 'done' }],
    });
  });

  it('a filters value that is not a group becomes null', () => {
    expect(filtersOf(parseListYaml('junk', 'filters: nonsense'))).toBeNull();
  });

  // Note 13 hardening: a self-referencing YAML alias inside filters: used to
  // recurse forever in parseFilterNode (stack overflow) — views/*.yml is
  // user-editable, so cyclic nodes must be dropped like any malformed node.
  it('a self-referencing flow alias inside filters does not throw', () => {
    const view = parseListYaml('cyclic-flow', 'filters: &a { all: [ *a ] }');
    expect(filtersOf(view)).toEqual({ all: [] });
  });

  it('a self-referencing block alias inside filters does not throw', () => {
    const view = parseListYaml('cyclic-block', 'filters: &a\n  all:\n    - *a\n');
    expect(filtersOf(view)).toEqual({ all: [] });
  });

  it('drops only the cyclic node and keeps valid siblings', () => {
    const view = parseListYaml(
      'cyclic-mixed',
      'filters: &a { all: [ *a, { field: status, op: equals, value: done } ] }',
    );
    expect(filtersOf(view)).toEqual({
      all: [{ field: 'status', op: 'equals', value: 'done' }],
    });
  });

  it('an indirect cycle through a nested group is dropped', () => {
    const view = parseListYaml(
      'cyclic-nested',
      'filters:\n  all:\n    - &g\n      any:\n        - *g\n',
    );
    expect(filtersOf(view)).toEqual({ all: [{ any: [] }] });
  });

  it('non-cyclic alias reuse is kept', () => {
    const view = parseListYaml(
      'shared-alias',
      'filters:\n  all:\n    - &r { field: status, op: equals, value: done }\n    - *r\n',
    );
    expect(filtersOf(view)).toEqual({
      all: [
        { field: 'status', op: 'equals', value: 'done' },
        { field: 'status', op: 'equals', value: 'done' },
      ],
    });
  });
});

/**
 * Multiple views per List (M11).
 *
 * The invariant everything downstream leans on is that `views` is never empty,
 * so the migration cases matter as much as the multi-view ones: a vault full of
 * pre-M11 files must open with one view each rather than none.
 */
describe('views', () => {
  it('migrates a pre-M11 single-view file into one view named after its layout', () => {
    const view = parseListYaml('legacy', 'presentation:\n  type: board\n');
    expect(view.definition.views).toHaveLength(1);
    expect(view.definition.views[0].name).toBe('Board');
    expect(view.definition.views[0].presentation.type).toBe('board');
  });

  it('parses several views, each with its own layout and filters', () => {
    const view = parseListYaml(
      'multi',
      [
        'name: Delivery',
        'source: { type: Work item }',
        'views:',
        '  - id: grid',
        '    name: All work',
        '    presentation: { type: table }',
        '  - id: at-risk',
        '    name: At risk',
        '    filters:',
        '      all:',
        '        - { field: status, op: equals, value: blocked }',
        '    presentation: { type: board }',
      ].join('\n'),
    );
    expect(view.definition.views.map((v) => [v.id, v.name, v.presentation.type])).toEqual([
      ['grid', 'All work', 'table'],
      ['at-risk', 'At risk', 'board'],
    ]);
    // Filters are PER VIEW: the first tab is unfiltered even though the
    // second one is.
    expect(view.definition.views[0].filters).toBeNull();
    expect(view.definition.views[1].filters).toEqual({
      all: [{ field: 'status', op: 'equals', value: 'blocked' }],
    });
  });

  it('never yields an empty views array, even for an empty views key', () => {
    expect(parseListYaml('none', 'views: []\n').definition.views).toHaveLength(1);
    expect(parseListYaml('nul', 'views: null\n').definition.views).toHaveLength(1);
  });

  it('de-duplicates ids so two tabs are never addressed by one name', () => {
    const view = parseListYaml(
      'dupes',
      'views:\n  - { id: board, presentation: { type: board } }\n  - { id: board, presentation: { type: table } }\n',
    );
    expect(view.definition.views.map((v) => v.id)).toEqual(['board', 'board-2']);
  });

  it('names a view after its layout when the file gives it none', () => {
    const view = parseListYaml('unnamed', 'views:\n  - { presentation: { type: calendar } }\n');
    expect(view.definition.views[0].name).toBe('Calendar');
  });

  it('ignores the legacy top-level presentation once `views:` is present', () => {
    // A file caught mid-migration must not have its new configuration
    // overridden by the stale key it replaced.
    const view = parseListYaml(
      'both',
      'presentation: { type: gantt }\nviews:\n  - { id: t, presentation: { type: table } }\n',
    );
    expect(view.definition.views).toHaveLength(1);
    expect(view.definition.views[0].presentation.type).toBe('table');
  });

  it('round-trips several views through serialize/parse', () => {
    const def: ListDefinition = {
      name: 'Delivery',
      icon: null,
      color: null,
      order: null,
      source: { type: 'Work item', project: null },
      views: [
        {
          id: 'grid',
          name: 'All work',
          icon: null,
          filters: null,
          presentation: {
            type: 'table',
            group: [],
            // Non-empty: an empty chain is how a file says "no preference",
            // and the parser answers that with the default sort.
            sort: [{ field: 'modifiedAt', dir: 'desc' }],
            columns: [{ field: 'status' }],
          },
        },
        {
          id: 'risk',
          name: 'At risk',
          icon: 'triangle-alert',
          filters: { all: [{ field: 'status', op: 'equals', value: 'blocked' }] },
          presentation: {
            type: 'board',
            group: [{ field: 'status' }],
            sort: [{ field: 'due', dir: 'asc' }],
            columns: [],
          },
        },
      ],
    };
    expect(parseListYaml('delivery', serializeList(def)).definition).toEqual(def);
  });

  it('writes `views:` and never the legacy keys, so a file converges', () => {
    const yaml = serializeList(parseListYaml('old', 'presentation:\n  type: board\n').definition);
    expect(yaml).toContain('views:');
    expect(yaml).not.toMatch(/^presentation:/m);
    expect(yaml).not.toMatch(/^filters:/m);
  });

  it('round-trips the per-view chip style and the name-column width', () => {
    const def = parseListYaml(
      'styled',
      'views:\n  - { id: v, presentation: { type: table, chips: type-icon, titleWidth: 340 } }\n',
    ).definition;
    expect(def.views[0].presentation.chips).toBe('type-icon');
    expect(def.views[0].presentation.titleWidth).toBe(340);
    expect(parseListYaml('styled', serializeList(def)).definition).toEqual(def);
  });

  it('round-trips the footer calculations, per column and on the name column', () => {
    const def = parseListYaml(
      'totals',
      'views:\n  - { id: v, presentation: { type: table, titleCalc: count_all, columns: [{ field: cost, calc: sum }] } }\n',
    ).definition;
    expect(def.views[0].presentation.titleCalc).toBe('count_all');
    expect(def.views[0].presentation.columns[0].calc).toBe('sum');
    expect(parseListYaml('totals', serializeList(def)).definition).toEqual(def);
  });

  it('round-trips the frozen-column count', () => {
    const def = parseListYaml(
      'pinned',
      'views:\n  - { id: v, presentation: { type: table, frozenColumns: 3 } }\n',
    ).definition;
    expect(def.views[0].presentation.frozenColumns).toBe(3);
    expect(parseListYaml('pinned', serializeList(def)).definition).toEqual(def);
  });

  it('migrates the old titleFrozen flag rather than dropping the setting', () => {
    // `titleFrozen: false` said "the name column scrolls", which is the same
    // statement as "nothing is frozen". A view saved before M16.18 must not
    // silently re-pin its first column.
    const def = parseListYaml(
      'legacy',
      'views:\n  - { id: v, presentation: { type: table, titleFrozen: false } }\n',
    ).definition;
    expect(def.views[0].presentation.frozenColumns).toBe(0);
    // `titleFrozen: true` was the default and carried no information.
    const on = parseListYaml(
      'legacy-on',
      'views:\n  - { id: v, presentation: { type: table, titleFrozen: true } }\n',
    ).definition;
    expect(on.views[0].presentation.frozenColumns).toBeUndefined();
    // Written back in the new spelling only, so a file converges on one shape.
    expect(serializeList(def)).not.toContain('titleFrozen');
  });

  it('round-trips the whiteboard file pointer (M29.45)', () => {
    const yaml = [
      'name: Ops',
      'views:',
      '  - id: canvas',
      '    name: Canvas',
      '    presentation:',
      '      type: whiteboard',
      '      whiteboard:',
      '        file: delivery/whiteboards/canvas.mmd',
    ].join('\n');
    const list = parseListYaml('ops', yaml);
    const view = list.definition.views[0];
    expect(view.presentation.type).toBe('whiteboard');
    expect(view.presentation.whiteboard).toEqual({ file: 'delivery/whiteboards/canvas.mmd' });

    // The serializer is an ALLOWLIST — this line is the proof the key was
    // added to it, which is the failure mode that loses user data silently.
    const out = parseListYaml('ops', serializeList(list.definition));
    expect(out.definition.views[0].presentation.whiteboard).toEqual({
      file: 'delivery/whiteboards/canvas.mmd',
    });
  });

  it('drops a blank or malformed whiteboard pointer rather than storing it', () => {
    for (const bad of ['whiteboard: 7', 'whiteboard:\n        file: ""', 'whiteboard: {}']) {
      const yaml = `views:\n  - presentation:\n      type: whiteboard\n      ${bad}\n`;
      const list = parseListYaml('t', yaml);
      expect(list.definition.views[0].presentation.whiteboard).toBeUndefined();
    }
  });

  it('a null file pointer is never written to YAML', () => {
    const def = parseListYaml(
      't',
      'views:\n  - presentation:\n      type: whiteboard\n',
    ).definition;
    const view = def.views[0];
    const withNull = {
      ...def,
      views: [{ ...view, presentation: { ...view.presentation, whiteboard: { file: null } } }],
    };
    // Key-anchored, not a bare substring: `type: whiteboard` is on every one of
    // this tab's serializations and says nothing about the pointer.
    expect(serializeList(withNull)).not.toMatch(/^\s+whiteboard:/m);
  });

  it('clonePresentation deep-copies the whiteboard pointer', () => {
    const p: Presentation = {
      type: 'whiteboard',
      group: [],
      sort: [{ field: 'modifiedAt', dir: 'desc' }],
      columns: [],
      whiteboard: { file: 'a.mmd' },
    };
    const copy = clonePresentation(p);
    expect(copy.whiteboard).toEqual(p.whiteboard);
    expect(copy.whiteboard).not.toBe(p.whiteboard);
  });

  it('drops a nonsense frozen count rather than pinning by a fraction', () => {
    const def = parseListYaml(
      'bad',
      'views:\n  - { id: v, presentation: { frozenColumns: -2 } }\n',
    ).definition;
    expect(def.views[0].presentation.frozenColumns).toBeUndefined();
  });

  it('drops a calculation it cannot compute rather than storing it', () => {
    // A hand-edited view file naming `median` must degrade to "no
    // calculation"; letting it through would reach `aggregate`'s exhaustive
    // guard with a value the union says cannot exist.
    const def = parseListYaml(
      'bogus',
      'views:\n  - { id: v, presentation: { titleCalc: median, columns: [{ field: cost, calc: mode }] } }\n',
    ).definition;
    expect(def.views[0].presentation.titleCalc).toBeUndefined();
    expect(def.views[0].presentation.columns[0].calc).toBeUndefined();
  });

  it('drops a chip style it does not recognize rather than trusting it', () => {
    const def = parseListYaml(
      'bad',
      'views:\n  - { id: v, presentation: { chips: rainbow } }\n',
    ).definition;
    expect(def.views[0].presentation.chips).toBeUndefined();
  });

  it('resolveView falls back to the first tab for an unknown id', () => {
    const def = parseListYaml(
      'multi',
      'views:\n  - { id: a, presentation: { type: table } }\n  - { id: b, presentation: { type: board } }\n',
    ).definition;
    expect(resolveView(def, 'b').id).toBe('b');
    expect(resolveView(def, 'gone').id).toBe('a');
    expect(resolveView(def, null).id).toBe('a');
    expect(resolveView(def).id).toBe('a');
  });

  it('replaceView touches only the named tab', () => {
    const def = parseListYaml(
      'multi',
      'views:\n  - { id: a, presentation: { type: table } }\n  - { id: b, presentation: { type: board } }\n',
    ).definition;
    const next = replaceView(def, 'b', { ...def.views[1], name: 'Renamed' });
    expect(next.views[0]).toBe(def.views[0]);
    expect(next.views[1].name).toBe('Renamed');
  });

  it('nextViewId avoids collisions', () => {
    expect(nextViewId('Board', [])).toBe('board');
    expect(nextViewId('Board', ['board'])).toBe('board-2');
    expect(nextViewId('Board', ['board', 'board-2'])).toBe('board-3');
    // A name that slugifies to nothing still gets a usable id.
    expect(nextViewId('!!!', [])).toBe('view');
  });

  it('newView seeds from the view you were on, keeping its columns', () => {
    const base: Presentation = {
      type: 'table',
      group: [{ field: 'status' }],
      sort: [{ field: 'due', dir: 'asc' }],
      columns: [{ field: 'status', width: 200 }],
    };
    const made = newView('At risk', 'board', ['grid'], base);
    expect(made.id).toBe('at-risk');
    expect(made.presentation.type).toBe('board');
    expect(made.presentation.columns).toEqual(base.columns);
    // Deep copy: editing the new view must not reach back into the old one.
    expect(made.presentation.columns).not.toBe(base.columns);
  });

  it('newView falls back to the layout name when given none', () => {
    expect(newView('', 'calendar').name).toBe('Calendar');
  });
});

describe('serializeList', () => {
  it('round-trips through parseListYaml', () => {
    const def = oneView(
      {
        name: 'Sprint board',
        icon: null,
        color: null,
        order: 3,
        source: NO_SOURCE,
      },
      {
        type: 'board',
        group: [],
        sort: [{ field: 'title', dir: 'asc' }],
        columns: [{ field: 'key' }, { field: 'status' }],
      },
      {
        any: [
          { field: 'status', op: 'is_empty' },
          {
            all: [
              { field: 'priority', op: 'none_of', value: ['low'] },
              { field: 'due', op: 'before', value: '2026-09-01' },
            ],
          },
        ],
      },
    );
    expect(parseListYaml('sprint-board', serializeList(def)).definition).toEqual(def);
  });

  /**
   * The read-side allowlist and the operator union were two hand-written
   * lists (M16.25). An operator missing from `views.ts`'s copy made
   * `parseFilterNode` treat the rule as MALFORMED and drop it, so the view
   * reopened with one fewer condition and silently showed records it had been
   * configured to hide. This asserts the two can no longer disagree.
   */
  it('round-trips every operator in the catalog', () => {
    const def = oneView(
      { name: 'Every op', icon: null, color: null, order: null, source: NO_SOURCE },
      {
        type: 'table',
        group: [],
        sort: [{ field: 'title', dir: 'asc' }],
        columns: [{ field: 'key' }],
      },
      {
        all: FILTER_OPS.map((op) => ({
          field: 'due',
          op,
          // Whatever shape the operator takes, the value has to survive too:
          // an `is_between` that came back as a scalar would silently become
          // "between X and undefined".
          ...(op === 'is_empty' || op === 'is_not_empty'
            ? {}
            : op === 'is_between'
              ? { value: ['2026-01-01', '2026-12-31'] }
              : op === 'any_of' || op === 'none_of'
                ? { value: ['a', 'b'] }
                : { value: '2026-06-01' }),
        })),
      },
    );
    const back = parseListYaml('every-op', serializeList(def)).definition;
    expect(back).toEqual(def);
    expect(back.views[0].filters).not.toBeNull();
  });

  /**
   * A typed value editor writes real numbers and real booleans (M16.25). YAML
   * keeps both, so a rule authored as `is 5` must not come back as `is "5"`.
   */
  it('round-trips a rule whose value is a number and one whose value is a boolean', () => {
    const def = oneView(
      { name: 'Typed', icon: null, color: null, order: null, source: NO_SOURCE },
      {
        type: 'table',
        group: [],
        sort: [{ field: 'title', dir: 'asc' }],
        columns: [{ field: 'key' }],
      },
      {
        all: [
          { field: 'estimate', op: 'gte', value: 5 },
          { field: 'done', op: 'equals', value: true },
        ],
      },
    );
    expect(parseListYaml('typed', serializeList(def)).definition).toEqual(def);
  });

  it('round-trips a load limit, and drops a nonsense one on read (M16.26)', () => {
    const def = oneView(
      { name: 'Capped', icon: null, color: null, order: null, source: NO_SOURCE },
      {
        type: 'table',
        group: [],
        sort: [{ field: 'title', dir: 'asc' }],
        columns: [{ field: 'key' }],
        limit: 25,
      },
    );
    expect(parseListYaml('capped', serializeList(def)).definition).toEqual(def);
    // A limit only a hand-edit can produce. Honouring it would render an
    // empty canvas that nothing on screen can explain or undo.
    expect(presentationOf(parseListYaml('v', 'presentation:\n  limit: 0\n')).limit).toBeUndefined();
  });

  // M3.5: a view is rooted in a type, and a relation level descends it — both
  // have to survive the YAML round trip or a saved view loses its shape.
  it('round-trips a type-rooted nesting view', () => {
    const def = oneView(
      {
        name: 'OKR tree',
        icon: 'target',
        color: null,
        order: 1,
        source: { type: 'Objective', project: 'projects/atlas/project.md' },
      },
      {
        type: 'table',
        sort: [{ field: 'title', dir: 'asc' }],
        // M9.7: nesting is a level of the ONE grouping chain.
        group: [
          {
            field: 'objective',
            descend: { direction: 'reverse', type: 'Key result', field: 'objective' },
          },
        ],
        columns: [{ field: 'status' }, { field: 'progress' }],
      },
    );
    expect(parseListYaml('okr-tree', serializeList(def)).definition).toEqual(def);
  });

  it('accepts the shorthand `childrenVia: <field>` as a forward descent', () => {
    const view = parseListYaml('t', 'presentation:\n  type: tree\n  childrenVia: key_results\n');
    expect(presentationOf(view).group).toEqual([
      { field: 'key_results', descend: { direction: 'forward', field: 'key_results' } },
    ]);
  });

  // M9.1 back-compat: every view file written before the chain model must
  // keep opening, and must land on the v2 shape rather than a half-migration.
  // M10 retired `tree` and `split`. Every file naming one must keep opening,
  // and must land on a live kind WITHOUT losing its configuration — a tree's
  // nesting already lived in the grouping chain, so a nested table is exactly
  // what it was describing.
  describe('retired view kinds', () => {
    const parse = (yaml: string) => presentationOf(parseListYaml('v', yaml));

    it('migrates `tree` to a table, keeping its relation levels', () => {
      const p = parse(
        [
          'presentation:',
          '  type: tree',
          '  group:',
          '    - relation: { type: Key result, field: objective }',
        ].join('\n'),
      );
      expect(p.type).toBe('table');
      expect(p.group).toEqual([
        {
          field: 'objective',
          descend: { direction: 'reverse', type: 'Key result', field: 'objective' },
        },
      ]);
    });

    it('migrates `split` to a table, keeping its columns', () => {
      const p = parse('presentation:\n  type: split\n  columns: [{ field: status, width: 140 }]\n');
      expect(p.type).toBe('table');
      expect(p.columns).toEqual([{ field: 'status', width: 140 }]);
    });

    it('writes the migrated kind back, so a file converges on one shape', () => {
      const def = parseListYaml('t', 'presentation:\n  type: tree\n').definition;
      expect(serializeList(def)).toContain('type: table');
      expect(serializeList(def)).not.toContain('tree');
    });

    it('falls back to the default kind for a name that never existed', () => {
      expect(parse('presentation:\n  type: kanban-deluxe\n').type).toBe('list');
    });

    it('leaves a file with no stated kind on the default', () => {
      expect(parse('presentation: {}\n').type).toBe('list');
    });

    // M16.3: driven by VIEW_TYPES, so a kind added to the union is parsed
    // here automatically. Omitting one from the LAYOUTS allowlist used to
    // downgrade every saved file of that kind to `list`, silently.
    it('accepts every live kind verbatim', () => {
      for (const kind of VIEW_TYPES) {
        expect(parse(`presentation:\n  type: ${kind}\n`).type).toBe(kind);
      }
    });
  });

  // M10 axis configuration. Written only when set, so a table's YAML does not
  // carry three keys about date axes it has no use for.
  describe('date-axis keys', () => {
    const parse = (yaml: string) => presentationOf(parseListYaml('v', yaml));

    it('round-trips dateField, zoom, and dependencyField', () => {
      const def = oneView(
        {
          name: 'Schedule',
          icon: null,
          color: null,
          order: null,
          source: { type: 'Work item', project: null },
        },
        {
          type: 'gantt',
          group: [],
          sort: [{ field: 'due', dir: 'asc' }],
          columns: [{ field: 'status' }],
          dateField: 'window',
          zoom: 'month',
          dependencyField: 'blocked_by',
        },
      );
      expect(parseListYaml('s', serializeList(def)).definition).toEqual(def);
    });

    it('omits them entirely when unset', () => {
      const yaml = serializeList(
        oneView(
          {
            name: 'Grid',
            icon: null,
            color: null,
            order: null,
            source: { type: null, project: null },
          },
          { type: 'table', group: [], sort: [], columns: [] },
        ),
      );
      expect(yaml).not.toContain('dateField');
      expect(yaml).not.toContain('zoom');
      expect(yaml).not.toContain('dependencyField');
      // The M11 keys follow the same rule — a table's YAML says nothing about
      // chip styling it never configured.
      expect(yaml).not.toContain('chips');
      expect(yaml).not.toContain('titleWidth');
    });

    it('drops a zoom it does not recognize rather than trusting it', () => {
      expect(parse('presentation:\n  type: gantt\n  zoom: fortnight\n').zoom).toBeUndefined();
    });

    it('drops a blank dateField so inference still runs', () => {
      expect(parse("presentation:\n  type: calendar\n  dateField: ''\n").dateField).toBeUndefined();
    });

    // M16.23 grid chrome. Same rule: stored only off its default, so no
    // existing calendar file gains three keys the day this shipped.
    it('round-trips the calendar grid settings', () => {
      const def = oneView(
        {
          name: 'Weeks',
          icon: null,
          color: null,
          order: null,
          source: { type: 'Campaign', project: null },
        },
        {
          type: 'calendar',
          group: [],
          sort: [{ field: 'due', dir: 'asc' }],
          columns: [],
          calendarSpan: 'week',
          showWeekends: false,
          weekStart: 'monday',
        },
      );
      expect(parseListYaml('s', serializeList(def)).definition).toEqual(def);
    });

    it('omits the grid settings when they are at their defaults', () => {
      const yaml = serializeList(
        oneView(
          {
            name: 'Months',
            icon: null,
            color: null,
            order: null,
            source: { type: 'Campaign', project: null },
          },
          {
            type: 'calendar',
            group: [],
            sort: [],
            columns: [],
            calendarSpan: 'month',
            showWeekends: true,
            weekStart: 'sunday',
          },
        ),
      );
      expect(yaml).not.toContain('calendarSpan');
      expect(yaml).not.toContain('showWeekends');
      expect(yaml).not.toContain('weekStart');
    });

    it('round-trips showTable BOTH ways', () => {
      // Unlike the rest it has no single default — a gantt shows its table and
      // a timeline does not — so `false` has to survive as `false` rather than
      // being written off as "the default, omit it".
      for (const showTable of [true, false]) {
        const def = oneView(
          {
            name: 'Schedule',
            icon: null,
            color: null,
            order: null,
            source: { type: 'Work item', project: null },
          },
          {
            type: 'timeline',
            group: [],
            sort: [{ field: 'due', dir: 'asc' }],
            columns: [],
            showTable,
          },
        );
        expect(parseListYaml('s', serializeList(def)).definition).toEqual(def);
      }
    });

    it('ignores grid settings it does not recognize', () => {
      const p = parse(
        'presentation:\n  type: calendar\n  calendarSpan: fortnight\n  weekStart: tuesday\n',
      );
      expect(p.calendarSpan).toBeUndefined();
      expect(p.weekStart).toBeUndefined();
    });
  });

  /**
   * The layout-specific settings blocks (M16.22, M16.27). Same contract the
   * date-axis keys have: a saved gallery or chart reopens as one with its
   * settings intact, and a layout that configured nothing writes no block at
   * all — `parseViewType` silently downgrading an unknown kind was this
   * milestone's bug, and a settings block nobody can read back is the same
   * failure one level down.
   */
  describe('layout settings blocks', () => {
    const parse = (yaml: string) => presentationOf(parseListYaml('v', yaml));

    it('round-trips cover, size and fit', () => {
      const def = oneView(
        {
          name: 'Assets',
          icon: null,
          color: null,
          order: null,
          source: { type: 'Work item', project: null },
        },
        {
          type: 'gallery',
          group: [],
          sort: [{ field: 'title', dir: 'asc' }],
          columns: [{ field: 'status' }],
          cardSize: 'large',
          gallery: { cover: 'artwork', fit: true },
        },
      );
      expect(parseListYaml('g', serializeList(def)).definition).toEqual(def);
    });

    /**
     * A pre-M16.29 gallery stored its card size as `gallery.size` while the
     * board stored the same setting as `cardSize`, so the settings panel
     * offered the control twice and each copy wrote a key the other layout
     * ignored. The two collapsed onto `cardSize`; a file written by the old
     * panel has to keep the size its owner chose rather than snap to medium.
     */
    it('migrates a pre-M16.29 gallery.size onto cardSize', () => {
      const p = parse('presentation:\n  type: gallery\n  gallery:\n    size: large\n');
      expect(p.cardSize).toBe('large');
      expect(p.gallery).toBeUndefined();
    });

    /** Both spellings on one file can only come from a hand edit; the current
     * key wins rather than being overwritten by the legacy one. */
    it('prefers cardSize over a legacy gallery.size', () => {
      const p = parse(
        'presentation:\n  type: gallery\n  cardSize: small\n  gallery:\n    size: large\n',
      );
      expect(p.cardSize).toBe('small');
    });

    it('omits the block entirely when the gallery was never configured', () => {
      const yaml = serializeList(
        oneView(
          { name: 'Cards', icon: null, color: null, order: null, source: NO_SOURCE },
          { type: 'gallery', group: [], sort: [], columns: [] },
        ),
      );
      // The word appears as the LAYOUT (`type: gallery`); what must not be
      // there is a settings block nobody configured.
      expect(yaml).not.toMatch(/^\s+gallery:/m);
    });

    // A hand-edited size that no layout implements would otherwise reach the
    // grid as an unknown key and index METRICS to undefined.
    it('drops a card size it does not recognize', () => {
      const p = parse('presentation:\n  type: gallery\n  gallery:\n    size: enormous\n');
      expect(p.cardSize).toBeUndefined();
      expect(p.gallery).toBeUndefined();
    });

    /**
     * The chart's settings (M16.27). Note what is NOT here: the X axis, which
     * is the grouping chain and round-trips as `group` like every other
     * layout's.
     */
    it('round-trips the chart block', () => {
      const def = oneView(
        {
          name: 'Burndown',
          icon: null,
          color: null,
          order: null,
          source: { type: 'Work item', project: null },
        },
        {
          type: 'chart',
          group: [{ field: 'status' }],
          // Non-empty on purpose: an empty chain is not representable —
          // parseSortChain restores the default, which predates this and is
          // not what the chart block is being tested for.
          sort: [{ field: 'title', dir: 'asc' }],
          columns: [],
          chart: { kind: 'donut', agg: 'sum', value: 'estimate', omitZero: true },
        },
      );
      expect(parseListYaml('c', serializeList(def)).definition).toEqual(def);
    });

    it('drops a chart type nothing draws', () => {
      expect(
        parse('presentation:\n  type: chart\n  chart:\n    kind: sankey\n').chart,
      ).toBeUndefined();
    });

    it('omits the chart block when the view never configured one', () => {
      const yaml = serializeList(
        oneView(
          { name: 'Bars', icon: null, color: null, order: null, source: NO_SOURCE },
          { type: 'chart', group: [], sort: [], columns: [] },
        ),
      );
      expect(yaml).not.toMatch(/^\s+chart:/m);
    });

    /**
     * The dashboard's blocks (M16.28) — a LIST, unlike the other two, so a
     * malformed member is dropped alone rather than taking the others with it.
     */
    it('round-trips a dashboard’s blocks in order', () => {
      const def = oneView(
        { name: 'Ops', icon: null, color: null, order: null, source: NO_SOURCE },
        {
          type: 'dashboard',
          group: [],
          sort: [{ field: 'modifiedAt', dir: 'desc' }],
          columns: [],
          dashboard: {
            blocks: [
              { id: 'total', kind: 'number', agg: 'sum', value: 'estimate', title: 'Points' },
              { id: 'grid', kind: 'view', list: 'delivery', collection: 'ops', wide: true },
              { id: 'count', kind: 'number', agg: 'count' },
            ],
          },
        },
      );
      expect(parseListYaml('d', serializeList(def)).definition).toEqual(def);
    });

    it('drops a view block with no list to point at, keeping its siblings', () => {
      const p = parse(
        'presentation:\n  type: dashboard\n  dashboard:\n    blocks:\n      - { id: a, kind: view }\n      - { id: b, kind: number, agg: count }\n',
      );
      expect(p.dashboard?.blocks).toEqual([{ id: 'b', kind: 'number', agg: 'count' }]);
    });

    it('makes block ids unique, because a delete addresses one', () => {
      const p = parse(
        'presentation:\n  type: dashboard\n  dashboard:\n    blocks:\n      - { id: x, kind: number, agg: count }\n      - { id: x, kind: number, agg: count }\n',
      );
      expect(p.dashboard?.blocks.map((b) => b.id)).toEqual(['x', 'block-2']);
    });

    it('forgets a value property the measure cannot use', () => {
      const p = parse(
        'presentation:\n  type: dashboard\n  dashboard:\n    blocks:\n      - { id: n, kind: number, agg: count, value: estimate }\n',
      );
      expect(p.dashboard?.blocks[0]).toEqual({ id: 'n', kind: 'number', agg: 'count' });
    });

    it('reads an empty dashboard as empty, not as unconfigured', () => {
      // `blocks: []` is a dashboard someone emptied; absent is one nobody has
      // touched. Both render the same, but only the first survives a rewrite.
      expect(
        parse('presentation:\n  type: dashboard\n  dashboard:\n    blocks: []\n').dashboard,
      ).toEqual({ blocks: [] });
      expect(parse('presentation:\n  type: dashboard\n').dashboard).toBeUndefined();
    });

    it('keeps a cover even when the rest of the block is junk', () => {
      const p = parse(
        'presentation:\n  type: gallery\n  gallery:\n    cover: artwork\n    size: 7\n    fit: yes please\n',
      );
      expect(p.gallery).toEqual({ cover: 'artwork' });
    });
  });

  // M16.20 board card keys. Same rule as the axis keys: written only when
  // set, so switching a board back to its defaults leaves the file as it was
  // rather than storing three keys that say "the default".
  describe('board card keys', () => {
    const parse = (yaml: string) => presentationOf(parseListYaml('v', yaml));

    it('round-trips cardSize, cardPreview, and colorColumns', () => {
      const def = oneView(
        {
          name: 'Wall',
          icon: null,
          color: null,
          order: null,
          source: { type: 'Work item', project: null },
        },
        {
          type: 'board',
          group: [{ field: 'status' }],
          sort: [{ field: 'due', dir: 'asc' }],
          columns: [{ field: 'status' }],
          cardSize: 'large',
          cardPreview: 'content',
          colorColumns: true,
        },
      );
      expect(parseListYaml('w', serializeList(def)).definition).toEqual(def);
    });

    it('omits them entirely when unset', () => {
      const yaml = serializeList(
        oneView(
          {
            name: 'Grid',
            icon: null,
            color: null,
            order: null,
            source: { type: null, project: null },
          },
          { type: 'table', group: [], sort: [], columns: [] },
        ),
      );
      expect(yaml).not.toContain('cardSize');
      expect(yaml).not.toContain('cardPreview');
      expect(yaml).not.toContain('colorColumns');
    });

    it('drops a card size it does not recognize rather than trusting it', () => {
      expect(
        parse('presentation:\n  type: board\n  cardSize: enormous\n').cardSize,
      ).toBeUndefined();
    });

    // 'cover' is the one Notion offers and we cannot render — a record has no
    // cover image. Accepting it here would put a value on disk that the board
    // silently ignores forever.
    it('drops a card preview it cannot render', () => {
      expect(
        parse('presentation:\n  type: board\n  cardPreview: cover\n').cardPreview,
      ).toBeUndefined();
    });

    it('treats anything but true as colorColumns off', () => {
      expect(parse('presentation:\n  type: board\n  colorColumns: false\n').colorColumns).toBe(
        undefined,
      );
      expect(parse("presentation:\n  type: board\n  colorColumns: 'yes'\n").colorColumns).toBe(
        undefined,
      );
    });
  });

  describe('v1 → v2 presentation migration', () => {
    it('lifts groupBy, orderBy, visibleFields, and childrenVia into chains', () => {
      const view = parseListYaml(
        'legacy',
        [
          'presentation:',
          '  type: tree',
          '  groupBy: priority',
          '  orderBy: { field: due, dir: asc }',
          '  visibleFields: [status, owner]',
          '  childrenVia: { type: Key result, field: objective }',
        ].join('\n'),
      );
      const p = presentationOf(view);
      expect(p.sort).toEqual([{ field: 'due', dir: 'asc' }]);
      expect(p.columns).toEqual([{ field: 'status' }, { field: 'owner' }]);
      // The legacy hierarchy becomes a relation LEVEL of the group chain.
      expect(p.group).toEqual([
        { field: 'priority' },
        {
          field: 'objective',
          descend: { direction: 'reverse', type: 'Key result', field: 'objective' },
        },
      ]);
    });

    it('lets v2 keys win when a file carries both shapes', () => {
      const view = parseListYaml(
        'both',
        [
          'presentation:',
          '  groupBy: status',
          '  group: [{ field: assignee }]',
          '  visibleFields: [status]',
          '  columns: [{ field: due, width: 220 }]',
        ].join('\n'),
      );
      const p = presentationOf(view);
      expect(p.group).toEqual([{ field: 'assignee' }]);
      expect(p.columns).toEqual([{ field: 'due', width: 220 }]);
    });

    it('round-trips a multi-level grouping and hierarchy chain', () => {
      const def = oneView(
        {
          name: 'Deep',
          icon: null,
          color: null,
          order: null,
          source: { type: 'Objective', project: null },
        },
        {
          type: 'table',
          group: [
            { field: 'status' },
            { field: 'owner', dir: 'desc' },
            {
              field: 'objective',
              descend: { direction: 'reverse', type: 'Key result', field: 'objective' },
            },
            {
              field: 'key_result',
              descend: { direction: 'reverse', type: 'Work item', field: 'key_result' },
            },
          ],
          sort: [
            { field: 'priority', dir: 'asc' },
            { field: 'due', dir: 'desc' },
          ],
          columns: [
            { field: 'status', width: 180 },
            { field: 'owner', hidden: true },
          ],
        },
      );
      expect(parseListYaml('deep', serializeList(def)).definition).toEqual(def);
    });

    it('caps nesting and banding separately', () => {
      const levels = Array.from({ length: 9 }, (_, i) => `  - { type: T${i}, field: y }`).join(
        '\n',
      );
      const view = parseListYaml(
        'deep',
        `presentation:\n  groupBy: null\n  hierarchy:\n${levels}\n`,
      );
      const p = presentationOf(view);
      // A chain that mixes both must not have its nesting truncated by the
      // band cap, nor the other way round.
      expect(p.group.filter((g) => g.descend !== undefined)).toHaveLength(6);
      expect(p.group.filter((g) => g.descend === undefined)).toHaveLength(0);
    });
  });
});

/**
 * A sort chain is ORDERED — the first key decides and later ones break its
 * ties — and there was no grip anywhere (`ChainBuilder.tsx:110-141`). The only
 * way to demote the leading key was to delete every row and re-add them in the
 * order you wanted (M16.26).
 */
describe('moveSortKey', () => {
  const chain: SortSpec[] = [
    { field: 'status', dir: 'asc' },
    { field: 'due', dir: 'desc' },
    { field: 'title', dir: 'asc' },
  ];

  it('promotes a key to the front', () => {
    expect(moveSortKey(chain, 2, 0).map((s) => s.field)).toEqual(['title', 'status', 'due']);
  });
  it('demotes a key to the back', () => {
    expect(moveSortKey(chain, 0, 2).map((s) => s.field)).toEqual(['due', 'title', 'status']);
  });
  it('a move to the same slot is not a new array to persist', () => {
    expect(moveSortKey(chain, 1, 1)).toBe(chain);
  });
  /**
   * Called from a pointer drag whose slot maths was measured against a DOM
   * that may have re-rendered mid-gesture, so a stale index must be a no-op
   * rather than a splice that duplicates or drops a key.
   */
  it('an out-of-range index leaves the chain untouched', () => {
    expect(moveSortKey(chain, 5, 0)).toBe(chain);
    expect(moveSortKey(chain, 0, -1)).toBe(chain);
    expect(moveSortKey(chain, 0, 9)).toBe(chain);
  });
});

/**
 * Tab order is the order of the `views:` array on disk, and nothing could
 * write a different one: no drag handler, no Move left/right item, and no
 * action anywhere in the app (M16.26).
 */
describe('moveView', () => {
  const views = [
    newView('One', 'table', []),
    newView('Two', 'board', ['one']),
    newView('Three', 'list', ['one', 'two']),
  ];

  it('moves a tab by id, not by index', () => {
    expect(moveView(views, 'three', 0).map((v) => v.id)).toEqual(['three', 'one', 'two']);
  });
  it('an unknown id changes nothing', () => {
    expect(moveView(views, 'nope', 0)).toBe(views);
  });
  it('a target outside the strip changes nothing', () => {
    expect(moveView(views, 'one', 3)).toBe(views);
  });
  it('the moved tab keeps its whole definition, not just its name', () => {
    const moved = moveView(views, 'two', 0);
    expect(moved[0]).toBe(views[1]);
  });
});
