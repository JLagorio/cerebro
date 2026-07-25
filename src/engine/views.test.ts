import { describe, expect, it } from 'vitest';
import { parseViewYaml, serializeView } from './views';
import type { ViewDefinition } from './types';

const DEFAULT_LIST_PRESENTATION = {
  type: 'list',
  groupBy: 'status',
  orderBy: { field: 'modifiedAt', dir: 'desc' },
  visibleFields: ['key', 'status', 'priority', 'assignee', 'due', 'estimate'],
};

const ACTIVE_WORK_YAML = `name: Active work
icon: flame
color: '#DE8F0A'
order: 2
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
      definition: {
        name: 'Active work',
        icon: 'flame',
        color: '#DE8F0A',
        order: 2,
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
          groupBy: 'status',
          orderBy: { field: 'due', dir: 'asc' },
          visibleFields: ['key', 'status', 'assignee'],
        },
      },
    });
  });

  it('bad yaml falls back to name = id and the default list presentation', () => {
    const view = parseViewYaml('mystery', 'a: [1, 2');
    expect(view.definition).toEqual({
      name: 'mystery',
      icon: null,
      color: null,
      order: null,
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
      groupBy: 'status',
      orderBy: { field: 'modifiedAt', dir: 'desc' },
      visibleFields: ['key', 'status', 'priority', 'assignee', 'due', 'estimate'],
    });
  });

  it('an explicit groupBy null stays null (flat list)', () => {
    const view = parseViewYaml('flat', 'presentation:\n  groupBy: null\n');
    expect(view.definition.presentation.groupBy).toBeNull();
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
        groupBy: null,
        orderBy: { field: 'title', dir: 'asc' },
        visibleFields: ['key', 'status'],
      },
    };
    expect(parseViewYaml('sprint-board', serializeView(def)).definition).toEqual(def);
  });
});
