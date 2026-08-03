import { describe, expect, it } from 'vitest';
import { seedView } from '@/app/viewActions';
import { serializeList } from '@/engine/views';
import type { ListDefinition, Presentation } from '@/engine/types';

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
