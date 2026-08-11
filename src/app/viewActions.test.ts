import { describe, expect, it } from 'vitest';
import { seedView } from '@/app/viewActions';
import { DEFAULT_PRESENTATION, serializeList } from '@/engine/views';
import { VIEW_TYPES } from '@/engine/types';
import type { FilterGroup, ListDefinition, Presentation } from '@/engine/types';

/**
 * Adding a view used to clone the open tab's presentation wholesale (M16.29).
 *
 * Verified live: a Table created while standing on the Gallery came out
 * holding `colorColumns`, and one created off the Gantt came out holding
 * `dateField`, `zoom` and `dependencyField`. A table draws none of those, no
 * control in it mentions them, and the first save writes them to the vault —
 * so the only way to get rid of one was to hand-edit the YAML.
 *
 * The assertions are made against the SERIALIZED view, because that is what
 * reaches the user's file.
 */
const gantt: Presentation = {
  type: 'gantt',
  group: [{ field: 'status' }],
  sort: [{ field: 'due', dir: 'asc' }],
  columns: [{ field: 'status' }, { field: 'due' }],
  limit: 25,
  dateField: 'due',
  zoom: 'week',
  dependencyField: 'blocked_by',
  showTable: false,
};

const gallery: Presentation = {
  type: 'gallery',
  group: [{ field: 'status' }],
  sort: [],
  columns: [{ field: 'status' }],
  cardSize: 'large',
  colorColumns: true,
  gallery: { cover: 'artwork' },
};

const yamlFor = (view: ReturnType<typeof seedView>): string =>
  serializeList({
    name: 'Delivery',
    icon: null,
    color: null,
    order: null,
    source: { type: 'Work item', project: null },
    views: [view],
  } satisfies ListDefinition);

describe('seeding a new view (M16.29)', () => {
  it('drops the gantt axis keys a table cannot read', () => {
    const yaml = yamlFor(seedView('Grid', 'table', [], gantt));
    expect(yaml).not.toMatch(/^\s+dateField:/m);
    expect(yaml).not.toMatch(/^\s+zoom:/m);
    expect(yaml).not.toMatch(/^\s+dependencyField:/m);
    expect(yaml).not.toMatch(/^\s+showTable:/m);
  });

  it('drops the board-only colorColumns a table cannot read', () => {
    const yaml = yamlFor(seedView('Grid', 'table', [], gallery));
    expect(yaml).not.toMatch(/^\s+colorColumns:/m);
    expect(yaml).not.toMatch(/^\s+cardSize:/m);
    expect(yaml).not.toMatch(/^\s+gallery:/m);
  });

  /**
   * The other half of the fix, and the easy thing to get wrong: starting from
   * a blank table when you asked for "another view of this data" is worse than
   * one dead key. The QUERY travels.
   */
  it('keeps the columns, sort, grouping and limit', () => {
    const seeded = seedView('Grid', 'table', [], gantt);
    expect(seeded.presentation.columns).toEqual(gantt.columns);
    expect(seeded.presentation.sort).toEqual(gantt.sort);
    expect(seeded.presentation.group).toEqual(gantt.group);
    expect(seeded.presentation.limit).toBe(25);
  });

  /** A card layout born on another card layout keeps the card settings both
   * of them read — narrowing is per key, not "drop everything unfamiliar". */
  it('carries card size from one card layout to another', () => {
    expect(seedView('Cards', 'board', [], gallery).presentation.cardSize).toBe('large');
  });

  it('takes the new kind as its type, and an id nobody else holds', () => {
    const seeded = seedView('Grid', 'board', ['grid'], gantt);
    expect(seeded.presentation.type).toBe('board');
    expect(seeded.id).toBe('grid-2');
  });
});

/**
 * A filter is what the list IS (M16.34).
 *
 * `newView` hardcodes `filters: null` and nothing overrode it, so adding a
 * Board to a List called "At risk" produced a board of all 45 work items with
 * a header confidently reading 45 — the list's defining filter discarded, no
 * error, no hint. Unlike a presentation key there is nothing to gate: no
 * layout can fail to read a filter.
 */
describe('seedView filters', () => {
  const AT_RISK: FilterGroup = {
    all: [
      { field: 'priority', op: 'any_of', value: ['urgent', 'high'] },
      { any: [{ field: 'status', op: 'equals', value: 'progress' }] },
    ],
  };

  it('carries the filter onto the new view', () => {
    const seeded = seedView('Wall', 'board', [], DEFAULT_PRESENTATION, AT_RISK);
    expect(seeded.filters).toEqual(AT_RISK);
  });

  it('carries it to every layout, because no layout can fail to read one', () => {
    for (const type of VIEW_TYPES) {
      expect(seedView('V', type, [], DEFAULT_PRESENTATION, AT_RISK).filters).toEqual(AT_RISK);
    }
  });

  // Two tabs sharing one nested object means editing either rewrites both.
  it('deep-clones, so the tabs cannot edit each other', () => {
    const seeded = seedView('Wall', 'board', [], DEFAULT_PRESENTATION, AT_RISK);
    const nested = (seeded.filters as { all: unknown[] }).all[1] as { any: unknown[] };
    nested.any.push({ field: 'status', op: 'equals', value: 'review' });
    expect((AT_RISK.all[1] as { any: unknown[] }).any).toHaveLength(1);
  });

  it('leaves an unfiltered list unfiltered', () => {
    expect(seedView('V', 'table', [], DEFAULT_PRESENTATION).filters).toBeNull();
  });
});

/**
 * The tenth kind at the app-layer seam (M29.48).
 *
 * `whiteboard.file` names a RESOURCE the tab owns, not a preference about how
 * to draw: two tabs sharing one pointer is two tabs editing one canvas, and a
 * layout switch that carried the pointer away and back would resurrect a file
 * the user thought they had left behind. `NEVER_SEEDED` and `KEY_NEEDS` (H1)
 * already decide this; these pin it where `seedView` is actually called from,
 * so a refactor of either half is caught on this side too.
 */
describe('seedView and the whiteboard (M29.48)', () => {
  const board: Presentation = {
    type: 'whiteboard',
    group: [{ field: 'status' }],
    sort: [{ field: 'modifiedAt', dir: 'desc' }],
    columns: [{ field: 'status' }],
    whiteboard: { file: 'delivery/whiteboards/map.mmd' },
  };

  it('a new whiteboard tab gets no file pointer and no layout-specific keys', () => {
    // Seeded from a fully-configured gantt: the query travels (that is what
    // "another view of this data" means), the gantt's layout keys do not, and
    // no pointer appears from nowhere.
    const seeded = seedView('Map', 'whiteboard', [], gantt);
    expect(seeded.presentation.type).toBe('whiteboard');
    expect(seeded.presentation.whiteboard).toBeUndefined();
    expect(seeded.presentation.dateField).toBeUndefined();
    expect(seeded.presentation.zoom).toBeUndefined();
    expect(seeded.presentation.dependencyField).toBeUndefined();
    // SharedKeys travel BY DESIGN (they are the query, not the layout):
    // nothing on a whiteboard reads them, nothing is harmed by them, and a
    // later switch back to a record layout finds the query intact.
    expect(seeded.presentation.group).toEqual(gantt.group);
    expect(seeded.presentation.columns).toEqual(gantt.columns);
  });

  it('a whiteboard seeded from a whiteboard gets its OWN canvas', () => {
    expect(seedView('Map 2', 'whiteboard', ['map'], board).presentation.whiteboard).toBeUndefined();
  });

  it('a table seeded from a whiteboard carries no pointer into its YAML', () => {
    const yaml = yamlFor(seedView('Grid', 'table', [], board));
    expect(yaml).not.toContain('whiteboard');
  });
});
