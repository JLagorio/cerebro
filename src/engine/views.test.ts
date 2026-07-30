import { describe, expect, it } from 'vitest';
import { parseViewYaml, serializeView } from './views';
import type { ViewDefinition } from './types';

const DEFAULT_LIST_PRESENTATION = {
  type: 'list',
  group: [{ field: 'status' }],
  sort: [{ field: 'modifiedAt', dir: 'desc' }],
  columns: [
    { field: 'key' }, { field: 'status' }, { field: 'priority' },
    { field: 'assignee' }, { field: 'due' }, { field: 'estimate' },
  ],
  rowHeight: undefined,
};

const NO_SOURCE = { type: null, project: null };

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

describe('parseViewYaml', () => {
  it('parses a complete view file', () => {
    expect(parseViewYaml('active-work', ACTIVE_WORK_YAML)).toEqual({
      id: 'active-work',
      project: null,
      definition: {
        name: 'Active work',
        icon: 'flame',
        color: '#DE8F0A',
        order: 2,
        source: { type: 'Work item', project: null },
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
    });
  });

  it('carries the project scope through (Task 6)', () => {
    const scoped = parseViewYaml('delivery', 'name: Delivery\n', 'projects/atlas/project.md');
    expect(scoped.project).toBe('projects/atlas/project.md');
    expect(parseViewYaml('global', 'name: G\n').project).toBeNull();
  });

  it('bad yaml falls back to name = id and the default list presentation', () => {
    const view = parseViewYaml('mystery', 'a: [1, 2');
    expect(view.definition).toEqual({
      name: 'mystery',
      icon: null,
      color: null,
      order: null,
      source: NO_SOURCE,
      filters: null,
      presentation: DEFAULT_LIST_PRESENTATION,
    });
  });

  it('a scalar yaml document gets full defaults', () => {
    const view = parseViewYaml('plain', 'just some text');
    expect(view.definition.name).toBe('plain');
    expect(view.definition.presentation).toEqual(DEFAULT_LIST_PRESENTATION);
  });

  it('an empty file gets full defaults', () => {
    expect(parseViewYaml('empty', '').definition.presentation).toEqual(DEFAULT_LIST_PRESENTATION);
  });

  it('missing presentation fields fall back individually', () => {
    const view = parseViewYaml('partial', 'name: Partial\npresentation:\n  type: board\n');
    expect(view.definition.presentation).toEqual({
      type: 'board',
      group: [{ field: 'status' }],
      sort: [{ field: 'modifiedAt', dir: 'desc' }],
      columns: [
        { field: 'key' }, { field: 'status' }, { field: 'priority' },
        { field: 'assignee' }, { field: 'due' }, { field: 'estimate' },
      ],
      rowHeight: undefined,
    });
  });

  it('an explicit groupBy null stays flat', () => {
    const view = parseViewYaml('flat', 'presentation:\n  groupBy: null\n');
    expect(view.definition.presentation.group).toEqual([]);
  });

  it('drops malformed filter rules but keeps valid ones', () => {
    const view = parseViewYaml(
      'broken',
      'filters:\n  all:\n    - { field: status }\n    - { field: status, op: equals, value: done }\n',
    );
    expect(view.definition.filters).toEqual({
      all: [{ field: 'status', op: 'equals', value: 'done' }],
    });
  });

  it('a filters value that is not a group becomes null', () => {
    expect(parseViewYaml('junk', 'filters: nonsense').definition.filters).toBeNull();
  });

  // Note 13 hardening: a self-referencing YAML alias inside filters: used to
  // recurse forever in parseFilterNode (stack overflow) — views/*.yml is
  // user-editable, so cyclic nodes must be dropped like any malformed node.
  it('a self-referencing flow alias inside filters does not throw', () => {
    const view = parseViewYaml('cyclic-flow', 'filters: &a { all: [ *a ] }');
    expect(view.definition.filters).toEqual({ all: [] });
  });

  it('a self-referencing block alias inside filters does not throw', () => {
    const view = parseViewYaml('cyclic-block', 'filters: &a\n  all:\n    - *a\n');
    expect(view.definition.filters).toEqual({ all: [] });
  });

  it('drops only the cyclic node and keeps valid siblings', () => {
    const view = parseViewYaml(
      'cyclic-mixed',
      'filters: &a { all: [ *a, { field: status, op: equals, value: done } ] }',
    );
    expect(view.definition.filters).toEqual({
      all: [{ field: 'status', op: 'equals', value: 'done' }],
    });
  });

  it('an indirect cycle through a nested group is dropped', () => {
    const view = parseViewYaml(
      'cyclic-nested',
      'filters:\n  all:\n    - &g\n      any:\n        - *g\n',
    );
    expect(view.definition.filters).toEqual({ all: [{ any: [] }] });
  });

  it('non-cyclic alias reuse is kept', () => {
    const view = parseViewYaml(
      'shared-alias',
      'filters:\n  all:\n    - &r { field: status, op: equals, value: done }\n    - *r\n',
    );
    expect(view.definition.filters).toEqual({
      all: [
        { field: 'status', op: 'equals', value: 'done' },
        { field: 'status', op: 'equals', value: 'done' },
      ],
    });
  });
});

describe('serializeView', () => {
  it('round-trips through parseViewYaml', () => {
    const def: ViewDefinition = {
      name: 'Sprint board',
      icon: null,
      color: null,
      order: 3,
      source: NO_SOURCE,
      filters: {
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
      presentation: {
        type: 'board',
        group: [],
        sort: [{ field: 'title', dir: 'asc' }],
        columns: [{ field: 'key' }, { field: 'status' }],
      },
    };
    expect(parseViewYaml('sprint-board', serializeView(def)).definition).toEqual(def);
  });

  // M3.5: a view is rooted in a type, and a tree descends a relation — both
  // have to survive the YAML round trip or a saved view loses its shape.
  it('round-trips a type-rooted tree view', () => {
    const def: ViewDefinition = {
      name: 'OKR tree',
      icon: 'target',
      color: null,
      order: 1,
      source: { type: 'Objective', project: 'projects/atlas/project.md' },
      filters: null,
      presentation: {
        type: 'tree',
        sort: [{ field: 'title', dir: 'asc' }],
        // M9.7: nesting is a level of the ONE grouping chain.
        group: [
          { field: 'objective', descend: { direction: 'reverse', type: 'Key result', field: 'objective' } },
        ],
        columns: [{ field: 'status' }, { field: 'progress' }],
      },
    };
    expect(parseViewYaml('okr-tree', serializeView(def)).definition).toEqual(def);
  });

  it('accepts the shorthand `childrenVia: <field>` as a forward descent', () => {
    const view = parseViewYaml('t', 'presentation:\n  type: tree\n  childrenVia: key_results\n');
    expect(view.definition.presentation.group).toEqual([
      { field: 'key_results', descend: { direction: 'forward', field: 'key_results' } },
    ]);
  });

  // M9.1 back-compat: every view file written before the chain model must
  // keep opening, and must land on the v2 shape rather than a half-migration.
  describe('v1 → v2 presentation migration', () => {
    it('lifts groupBy, orderBy, visibleFields, and childrenVia into chains', () => {
      const view = parseViewYaml(
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
      const p = view.definition.presentation;
      expect(p.sort).toEqual([{ field: 'due', dir: 'asc' }]);
      expect(p.columns).toEqual([{ field: 'status' }, { field: 'owner' }]);
      // The legacy hierarchy becomes a relation LEVEL of the group chain.
      expect(p.group).toEqual([
        { field: 'priority' },
        { field: 'objective', descend: { direction: 'reverse', type: 'Key result', field: 'objective' } },
      ]);
    });

    it('lets v2 keys win when a file carries both shapes', () => {
      const view = parseViewYaml(
        'both',
        [
          'presentation:',
          '  groupBy: status',
          '  group: [{ field: assignee }]',
          '  visibleFields: [status]',
          '  columns: [{ field: due, width: 220 }]',
        ].join('\n'),
      );
      const p = view.definition.presentation;
      expect(p.group).toEqual([{ field: 'assignee' }]);
      expect(p.columns).toEqual([{ field: 'due', width: 220 }]);
    });

    it('round-trips a multi-level grouping and hierarchy chain', () => {
      const def: ViewDefinition = {
        name: 'Deep',
        icon: null,
        color: null,
        order: null,
        source: { type: 'Objective', project: null },
        filters: null,
        presentation: {
          type: 'tree',
          group: [
            { field: 'status' },
            { field: 'owner', dir: 'desc' },
            { field: 'objective', descend: { direction: 'reverse', type: 'Key result', field: 'objective' } },
            { field: 'key_result', descend: { direction: 'reverse', type: 'Work item', field: 'key_result' } },
          ],
          sort: [{ field: 'priority', dir: 'asc' }, { field: 'due', dir: 'desc' }],
          columns: [{ field: 'status', width: 180 }, { field: 'owner', hidden: true }],
        },
      };
      expect(parseViewYaml('deep', serializeView(def)).definition).toEqual(def);
    });

    it('caps nesting and banding separately', () => {
      const levels = Array.from({ length: 9 }, (_, i) => `  - { type: T${i}, field: y }`).join('\n');
      const view = parseViewYaml('deep', `presentation:\n  groupBy: null\n  hierarchy:\n${levels}\n`);
      const p = view.definition.presentation;
      // A chain that mixes both must not have its nesting truncated by the
      // band cap, nor the other way round.
      expect(p.group.filter((g) => g.descend !== undefined)).toHaveLength(6);
      expect(p.group.filter((g) => g.descend === undefined)).toHaveLength(0);
    });
  });
});
