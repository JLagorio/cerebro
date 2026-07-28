import { describe, expect, it } from 'vitest';
import { resolveCollection } from './collections';
import { buildSchema } from './schema';
import { makeEntry } from './testHelpers';
import type { ViewFile } from './types';

const DEFAULT_LIST_PRESENTATION = {
  type: 'list',
  groupBy: 'status',
  orderBy: { field: 'modifiedAt', dir: 'desc' },
  visibleFields: ['key', 'status', 'priority', 'assignee', 'due', 'estimate'],
};

const FOUNDATIONS = 'projects/foundations/project.md';
const LAUNCH = 'projects/launch/project.md';

function fixture() {
  const entries = [
    makeEntry({
      path: 'types/work-item.md',
      filename: 'work-item.md',
      folder: 'types',
      title: 'Work item',
      type: 'Type',
      properties: {
        fields: {
          status: { kind: 'status' },
          priority: {
            kind: 'select',
            options: [
              { id: 'urgent', color: '#D6453D' },
              { id: 'high', color: '#DE8F0A' },
              { id: 'low', color: '#A8AFC2' },
            ],
          },
        },
      },
    }),
    makeEntry({
      path: FOUNDATIONS,
      filename: 'project.md',
      folder: 'projects/foundations',
      project: FOUNDATIONS,
      title: 'Foundations',
      type: 'Project',
      properties: { key: 'FLD' },
    }),
    makeEntry({
      path: LAUNCH,
      filename: 'project.md',
      folder: 'projects/launch',
      project: LAUNCH,
      title: 'Launch',
      type: 'Project',
      properties: { key: 'LNC' },
    }),
    makeEntry({
      path: 'projects/foundations/items/fld-1.md',
      filename: 'fld-1.md',
      folder: 'projects/foundations/items',
      project: FOUNDATIONS,
      title: 'Older item',
      type: 'Work item',
      properties: { status: 'done', priority: 'low' },
      modifiedAt: '2026-07-01T00:00:00.000Z',
    }),
    makeEntry({
      path: 'projects/foundations/items/fld-2.md',
      filename: 'fld-2.md',
      folder: 'projects/foundations/items',
      project: FOUNDATIONS,
      title: 'Newer item',
      type: 'Work item',
      properties: { status: 'todo', priority: 'urgent' },
      modifiedAt: '2026-07-03T00:00:00.000Z',
    }),
    makeEntry({
      path: 'projects/launch/items/lnc-1.md',
      filename: 'lnc-1.md',
      folder: 'projects/launch/items',
      project: LAUNCH,
      title: 'Launch item',
      type: 'Work item',
      properties: { status: 'done', priority: 'high' },
      modifiedAt: '2026-07-02T00:00:00.000Z',
    }),
    // A doc inside the project folder must NOT appear on the item canvas.
    makeEntry({
      path: 'projects/foundations/meetings/kickoff.md',
      filename: 'kickoff.md',
      folder: 'projects/foundations/meetings',
      project: FOUNDATIONS,
      title: 'Kickoff',
      type: null,
    }),
  ];
  return { entries, schema: buildSchema(entries) };
}

function mkView(partial: Partial<ViewFile['definition']> & { id: string }): ViewFile {
  const { id, ...definition } = partial;
  return {
    id,
    project: null,
    definition: {
      name: id,
      icon: null,
      color: null,
      order: null,
      source: { type: null, project: null },
      filters: null,
      presentation: {
        type: 'list',
        groupBy: 'status',
        orderBy: { field: 'modifiedAt', dir: 'desc' },
        visibleFields: ['key', 'status'],
      },
      ...definition,
    },
  };
}

describe('resolveCollection', () => {
  it('a project selection collects its contained Work items only', () => {
    const { entries, schema } = fixture();
    const collection = resolveCollection(
      { kind: 'project', path: FOUNDATIONS },
      entries,
      schema,
      [],
    );
    expect(collection.title).toBe('Foundations');
    // Docs and the project.md itself are excluded — items only, sorted.
    expect(collection.entries.map((e) => e.path)).toEqual([
      'projects/foundations/items/fld-2.md',
      'projects/foundations/items/fld-1.md',
    ]);
    expect(collection.presentation).toEqual(DEFAULT_LIST_PRESENTATION);
  });

  it('a missing project yields an empty collection titled by the path stem', () => {
    const { entries, schema } = fixture();
    const collection = resolveCollection(
      { kind: 'project', path: 'projects/gone/project.md' },
      entries,
      schema,
      [],
    );
    expect(collection.title).toBe('project');
    expect(collection.entries).toEqual([]);
    expect(collection.presentation).toEqual(DEFAULT_LIST_PRESENTATION);
  });

  it('a view selection applies its filters and presentation', () => {
    const { entries, schema } = fixture();
    const view = mkView({
      id: 'done-work',
      name: 'Done work',
      source: { type: null, project: null },
      filters: {
        all: [
          { field: 'type', op: 'equals', value: 'Work item' },
          { field: 'status', op: 'equals', value: 'done' },
        ],
      },
      presentation: {
        type: 'board',
        groupBy: 'status',
        orderBy: { field: 'modifiedAt', dir: 'asc' },
        visibleFields: ['key', 'status'],
      },
    });
    const collection = resolveCollection({ kind: 'view', id: 'done-work' }, entries, schema, [view]);
    expect(collection.title).toBe('Done work');
    expect(collection.presentation).toEqual(view.definition.presentation);
    expect(collection.entries.map((e) => e.path)).toEqual([
      'projects/foundations/items/fld-1.md',
      'projects/launch/items/lnc-1.md',
    ]);
  });

  it('a filterless, typeless view collects every entry but the schema docs', () => {
    const { entries, schema } = fixture();
    const view = mkView({ id: 'everything' });
    const collection = resolveCollection(
      { kind: 'view', id: 'everything' },
      entries,
      schema,
      [view],
    );
    // M3.5: `type: Type` docs are the model, so a content view leaves them out.
    const typeDocs = entries.filter((e) => e.type === 'Type').length;
    expect(typeDocs).toBeGreaterThan(0);
    expect(collection.entries).toHaveLength(entries.length - typeDocs);
    expect(collection.entries.some((e) => e.type === 'Type')).toBe(false);
  });

  it('a type-rooted view lists only that type, scoped by project (M3.5)', () => {
    const { entries, schema } = fixture();
    const project = entries.find((e) => e.type === 'Project');
    expect(project).toBeDefined();
    const view = mkView({
      id: 'projects',
      source: { type: 'Project', project: null },
    });
    const collection = resolveCollection({ kind: 'view', id: 'projects' }, entries, schema, [view]);
    expect(collection.entries.length).toBeGreaterThan(0);
    expect(collection.entries.every((e) => e.type === 'Project')).toBe(true);
  });

  it('an unknown view id yields an empty default collection titled by the id', () => {
    const { entries, schema } = fixture();
    const collection = resolveCollection({ kind: 'view', id: 'nope' }, entries, schema, []);
    expect(collection.title).toBe('nope');
    expect(collection.entries).toEqual([]);
    expect(collection.presentation).toEqual(DEFAULT_LIST_PRESENTATION);
  });

  it('home and settings selections resolve to empty collections', () => {
    const { entries, schema } = fixture();
    expect(resolveCollection({ kind: 'home' }, entries, schema, []).entries).toEqual([]);
    expect(resolveCollection({ kind: 'settings' }, entries, schema, []).entries).toEqual([]);
  });

  it('ordering by a select field follows the declared option order', () => {
    const { entries, schema } = fixture();
    const view = mkView({
      id: 'by-priority',
      source: { type: null, project: null },
      filters: { all: [{ field: 'type', op: 'equals', value: 'Work item' }] },
      presentation: {
        type: 'list',
        groupBy: null,
        orderBy: { field: 'priority', dir: 'asc' },
        visibleFields: ['key'],
      },
    });
    const collection = resolveCollection(
      { kind: 'view', id: 'by-priority' },
      entries,
      schema,
      [view],
    );
    // urgent -> high -> low per the declared options, not alphabetical
    expect(collection.entries.map((e) => e.path)).toEqual([
      'projects/foundations/items/fld-2.md',
      'projects/launch/items/lnc-1.md',
      'projects/foundations/items/fld-1.md',
    ]);
  });

  it('entries without the order field sort last', () => {
    const { entries } = fixture();
    const bare = makeEntry({
      path: 'projects/foundations/items/bare.md',
      filename: 'bare.md',
      folder: 'projects/foundations/items',
      project: FOUNDATIONS,
      title: 'Bare',
      type: 'Work item',
      modifiedAt: '2026-07-09T00:00:00.000Z',
    });
    const all = [...entries, bare];
    const schemaAll = buildSchema(all);
    const view = mkView({
      id: 'by-due',
      source: { type: null, project: null },
      filters: { all: [{ field: 'type', op: 'equals', value: 'Work item' }] },
      presentation: {
        type: 'list',
        groupBy: null,
        orderBy: { field: 'priority', dir: 'asc' },
        visibleFields: ['key'],
      },
    });
    const collection = resolveCollection({ kind: 'view', id: 'by-due' }, all, schemaAll, [view]);
    expect(collection.entries[collection.entries.length - 1].path).toBe(
      'projects/foundations/items/bare.md',
    );
  });
});
