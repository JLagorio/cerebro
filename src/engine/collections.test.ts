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

function fixture() {
  const entries = [
    makeEntry({
      path: 'type/work-item.md',
      filename: 'work-item.md',
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
      path: 'spaces/product.md',
      filename: 'product.md',
      title: 'Product',
      type: 'Space',
      properties: { color: '#3D8BE8' },
    }),
    makeEntry({
      path: 'projects/foundations.md',
      filename: 'foundations.md',
      title: 'Foundations',
      type: 'Project',
      properties: { key: 'FLD' },
      relationships: { space: ['product'] },
    }),
    makeEntry({
      path: 'projects/launch.md',
      filename: 'launch.md',
      title: 'Launch',
      type: 'Project',
      properties: { key: 'LNC' },
      relationships: { space: ['product'] },
    }),
    makeEntry({
      path: 'items/fld-1.md',
      filename: 'fld-1.md',
      title: 'Older item',
      type: 'Work item',
      properties: { status: 'done', priority: 'low' },
      relationships: { project: ['foundations'] },
      modifiedAt: '2026-07-01T00:00:00.000Z',
    }),
    makeEntry({
      path: 'items/fld-2.md',
      filename: 'fld-2.md',
      title: 'Newer item',
      type: 'Work item',
      properties: { status: 'todo', priority: 'urgent' },
      relationships: { project: ['foundations'] },
      modifiedAt: '2026-07-03T00:00:00.000Z',
    }),
    makeEntry({
      path: 'items/lnc-1.md',
      filename: 'lnc-1.md',
      title: 'Launch item',
      type: 'Work item',
      properties: { status: 'done', priority: 'high' },
      relationships: { project: ['launch'] },
      modifiedAt: '2026-07-02T00:00:00.000Z',
    }),
  ];
  return { entries, schema: buildSchema(entries) };
}

function mkView(partial: Partial<ViewFile['definition']> & { id: string }): ViewFile {
  const { id, ...definition } = partial;
  return {
    id,
    definition: {
      name: id,
      icon: null,
      color: null,
      order: null,
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
  it('a project selection collects its items with the default presentation', () => {
    const { entries, schema } = fixture();
    const collection = resolveCollection(
      { kind: 'project', path: 'projects/foundations.md' },
      entries,
      schema,
      [],
    );
    expect(collection.title).toBe('Foundations');
    expect(collection.entries.map((e) => e.path)).toEqual(['items/fld-2.md', 'items/fld-1.md']);
    expect(collection.presentation).toEqual(DEFAULT_LIST_PRESENTATION);
  });

  it('a missing project yields an empty collection titled by the path stem', () => {
    const { entries, schema } = fixture();
    const collection = resolveCollection(
      { kind: 'project', path: 'projects/gone.md' },
      entries,
      schema,
      [],
    );
    expect(collection.title).toBe('gone');
    expect(collection.entries).toEqual([]);
    expect(collection.presentation).toEqual(DEFAULT_LIST_PRESENTATION);
  });

  it('a space selection collects items across its projects', () => {
    const { entries, schema } = fixture();
    const collection = resolveCollection(
      { kind: 'space', path: 'spaces/product.md' },
      entries,
      schema,
      [],
    );
    expect(collection.title).toBe('Product');
    expect(collection.entries.map((e) => e.path)).toEqual([
      'items/fld-2.md',
      'items/lnc-1.md',
      'items/fld-1.md',
    ]);
  });

  it('a view selection applies its filters and presentation', () => {
    const { entries, schema } = fixture();
    const view = mkView({
      id: 'done-work',
      name: 'Done work',
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
    expect(collection.entries.map((e) => e.path)).toEqual(['items/fld-1.md', 'items/lnc-1.md']);
  });

  it('a filterless view collects every entry', () => {
    const { entries, schema } = fixture();
    const view = mkView({ id: 'everything' });
    const collection = resolveCollection(
      { kind: 'view', id: 'everything' },
      entries,
      schema,
      [view],
    );
    expect(collection.entries).toHaveLength(entries.length);
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
      'items/fld-2.md',
      'items/lnc-1.md',
      'items/fld-1.md',
    ]);
  });

  it('entries without the order field sort last', () => {
    const { entries } = fixture();
    const bare = makeEntry({
      path: 'items/bare.md',
      filename: 'bare.md',
      title: 'Bare',
      type: 'Work item',
      relationships: { project: ['foundations'] },
      modifiedAt: '2026-07-09T00:00:00.000Z',
    });
    const all = [...entries, bare];
    const schemaAll = buildSchema(all);
    const view = mkView({
      id: 'by-due',
      filters: { all: [{ field: 'type', op: 'equals', value: 'Work item' }] },
      presentation: {
        type: 'list',
        groupBy: null,
        orderBy: { field: 'priority', dir: 'asc' },
        visibleFields: ['key'],
      },
    });
    const collection = resolveCollection({ kind: 'view', id: 'by-due' }, all, schemaAll, [view]);
    expect(collection.entries[collection.entries.length - 1].path).toBe('items/bare.md');
  });
});
