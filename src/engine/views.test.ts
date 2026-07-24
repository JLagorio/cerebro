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
