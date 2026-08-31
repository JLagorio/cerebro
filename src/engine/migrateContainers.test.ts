import { describe, expect, it } from 'vitest';
import { isMigrated, planMigration } from './migrateContainers';
import { buildSchema } from './schema';
import { makeEntry } from './testHelpers';
import type { CollectionFile, Entry, ListFile, Presentation, ViewDefinition } from './types';

const typeDoc = (title: string, properties: Record<string, unknown> = {}): Entry =>
  makeEntry({
    path: `types/${title.toLowerCase().replace(/\s+/g, '-')}.md`,
    title,
    type: 'Type',
    properties: properties as Entry['properties'],
  });

const presentation = (): Presentation => ({
  type: 'table',
  group: [],
  sort: [],
  columns: [],
});

const view = (id: string, name = id): ViewDefinition => ({
  id,
  name,
  icon: null,
  filters: null,
  presentation: presentation(),
});

const collection = (
  folder: string,
  over: Partial<CollectionFile['definition']> = {},
): CollectionFile => ({
  folder,
  declared: true,
  definition: {
    name: folder,
    icon: null,
    color: null,
    order: null,
    description: null,
    ...over,
  },
});

const list = (
  id: string,
  type: string | null,
  over: { collection?: string | null; name?: string; views?: ViewDefinition[] } = {},
): ListFile => {
  const folder = over.collection === undefined ? 'delivery' : over.collection;
  return {
    id,
    project: null,
    collection: folder,
    path: `${folder === null ? '' : `${folder}/`}${id}.list.yml`,
    definition: {
      name: over.name ?? id,
      icon: null,
      color: null,
      order: null,
      source: { type, project: null },
      views: over.views ?? [view('table', 'Table')],
    },
  };
};

describe('planMigration: collections become pages', () => {
  it('folds a collection.yml into the folder note it should always have been', () => {
    const plan = planMigration(
      [],
      [collection('delivery', { name: 'Delivery', icon: 'rocket' })],
      [],
      buildSchema([]),
    );
    expect(plan.folderNotes).toHaveLength(1);
    expect(plan.folderNotes[0]).toMatchObject({
      folder: 'delivery',
      path: 'delivery/delivery.md',
      retires: 'delivery/collection.yml',
      merges: false,
    });
    expect(plan.folderNotes[0].frontmatter).toEqual({ name: 'Delivery', icon: 'rocket' });
  });

  /**
   * Deviations only, like every other writer here. A collection that declared
   * no icon must not put `icon: null` into somebody's page — the point of
   * folding these files in is that the page reads like a page, not like a
   * config file that moved house.
   */
  it('writes only what the collection actually declared', () => {
    const plan = planMigration([], [collection('work')], [], buildSchema([]));
    expect(plan.folderNotes[0].frontmatter).toEqual({ name: 'work' });
  });

  /**
   * A folder that is a Collection only because it holds Lists has no
   * `collection.yml` and nothing stored about it. Converting it would invent
   * a page nobody asked for — and there would be nothing to retire.
   */
  it('leaves an undeclared collection alone', () => {
    const undeclared = { ...collection('adhoc'), declared: false };
    expect(planMigration([], [undeclared], [], buildSchema([])).folderNotes).toEqual([]);
  });

  it('merges into an existing folder note rather than displacing it', () => {
    const entries = [makeEntry({ path: 'delivery/delivery.md', title: 'Delivery' })];
    const plan = planMigration(entries, [collection('delivery')], [], buildSchema([]));
    expect(plan.folderNotes[0]).toMatchObject({ path: 'delivery/delivery.md', merges: true });
  });
});

describe('planMigration: lists become a database views', () => {
  const schema = buildSchema([typeDoc('Work item'), typeDoc('Objective')]);

  it('moves a list onto the database its source names', () => {
    const plan = planMigration([], [], [list('at-risk', 'Work item', { name: 'At risk' })], schema);
    expect(plan.databases).toHaveLength(1);
    expect(plan.databases[0]).toMatchObject({
      database: 'Work item',
      retires: ['delivery/at-risk.list.yml'],
    });
    expect(plan.databases[0].views.map((v) => v.name)).toEqual(['At risk']);
  });

  /**
   * The whole point of merging: three lists over Work item become three tabs
   * of Work item. Their VIEWS were all called "Table"; the LIST names are what
   * carried the meaning, so those are what survive — otherwise the database
   * ends up with three indistinguishable tabs.
   */
  it('keeps several lists over one database distinguishable', () => {
    const lists = [
      list('at-risk', 'Work item', { name: 'At risk' }),
      list('this-month', 'Work item', { name: 'This month' }),
      list('schedule', 'Work item', { name: 'Delivery schedule' }),
    ];
    const plan = planMigration([], [], lists, schema);
    expect(plan.databases).toHaveLength(1);
    expect(plan.databases[0].views.map((v) => v.name)).toEqual([
      'At risk',
      'This month',
      'Delivery schedule',
    ]);
    // Ids were unique per FILE and are now unique per database.
    const ids = plan.databases[0].views.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('qualifies each view of a list that had several', () => {
    const many = list('board-and-table', 'Work item', {
      name: 'Delivery',
      views: [view('table', 'Table'), view('board', 'Board')],
    });
    const names = planMigration([], [], [many], schema).databases[0].views.map((v) => v.name);
    expect(names).toEqual(['Delivery · Table', 'Delivery · Board']);
  });

  it('appends after the views the database already saved', () => {
    const withViews = buildSchema([
      typeDoc('Work item', {
        views: [{ id: 'mine', name: 'Mine', presentation: { type: 'table' } }],
      }),
    ]);
    const plan = planMigration(
      [],
      [],
      [list('at-risk', 'Work item', { name: 'At risk' })],
      withViews,
    );
    expect(plan.databases[0].views.map((v) => v.name)).toEqual(['Mine', 'At risk']);
  });

  /**
   * An id collision with a view the database already had would silently
   * shadow one of them — `resolveView` finds by id and takes the first.
   */
  it('never reuses an id the database already had', () => {
    const withViews = buildSchema([
      typeDoc('Work item', {
        views: [{ id: 'at-risk', name: 'Mine', presentation: { type: 'table' } }],
      }),
    ]);
    const ids = planMigration(
      [],
      [],
      [list('at-risk', 'Work item')],
      withViews,
    ).databases[0].views.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries the filters and presentation across unchanged', () => {
    const filtered = list('urgent', 'Work item', {
      views: [
        {
          ...view('table'),
          filters: { all: [{ field: 'priority', op: 'equals', value: 'high' }] },
          presentation: { ...presentation(), type: 'board' },
        },
      ],
    });
    const moved = planMigration([], [], [filtered], schema).databases[0].views[0];
    expect(moved.presentation.type).toBe('board');
    expect(moved.filters).toEqual({ all: [{ field: 'priority', op: 'equals', value: 'high' }] });
  });
});

describe('planMigration: what it refuses to move', () => {
  const schema = buildSchema([typeDoc('Work item')]);

  /**
   * D9. A List over "Everything" queries across every database and so belongs
   * to none. There is nowhere in the new model to put it, and dropping it
   * would destroy a query somebody wrote — so it keeps its file, and the plan
   * says why rather than staying silent.
   */
  it('keeps a typeless list, with a reason', () => {
    const plan = planMigration([], [], [list('everything', null)], schema);
    expect(plan.databases).toEqual([]);
    expect(plan.kept).toEqual([
      { path: 'delivery/everything.list.yml', reason: expect.stringContaining('belongs to none') },
    ]);
  });

  /**
   * A list naming a type with no Type doc is pointing at a ghost. Writing
   * views onto it would CREATE that database as a side effect of a migration,
   * which is not a migration's job.
   */
  it('keeps a list whose database does not exist, naming it', () => {
    const plan = planMigration([], [], [list('ghosts', 'Phantom')], schema);
    expect(plan.databases).toEqual([]);
    expect(plan.kept[0].reason).toContain('Phantom');
  });

  it('reports a top-level list by its real path', () => {
    const plan = planMigration([], [], [list('loose', null, { collection: null })], schema);
    expect(plan.kept[0].path).toBe('loose.list.yml');
  });
});

describe('isMigrated', () => {
  /**
   * Idempotence is what makes it safe to ask this question on every scan: a
   * vault with nothing left to convert plans nothing. Kept lists do NOT make
   * a vault unmigrated — they are the finished state for those files, and
   * counting them would leave the app permanently offering a conversion that
   * would do nothing.
   */
  it('is true for a vault with nothing left to convert', () => {
    expect(isMigrated(planMigration([], [], [], buildSchema([])))).toBe(true);
  });

  it('stays true when the only remaining lists are ones it refuses to move', () => {
    const plan = planMigration([], [], [list('everything', null)], buildSchema([]));
    expect(plan.kept).toHaveLength(1);
    expect(isMigrated(plan)).toBe(true);
  });

  it('is false while a collection or a list still needs moving', () => {
    expect(isMigrated(planMigration([], [collection('delivery')], [], buildSchema([])))).toBe(
      false,
    );
    const schema = buildSchema([typeDoc('Work item')]);
    expect(isMigrated(planMigration([], [], [list('a', 'Work item')], schema))).toBe(false);
  });
});
