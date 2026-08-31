import { describe, expect, it } from 'vitest';
import { buildSchema } from './schema';
import { makeEntry } from './testHelpers';
import {
  isLockedField,
  isSystemType,
  listTypes,
  serializeFields,
  systemTypeSpec,
  typePresentation,
  typeStyle,
  typeTabs,
  typeViews,
} from './typeCatalog';
import type { Entry, FieldDef, Presentation } from './types';

const typeDoc = (title: string, patch: Parameters<typeof makeEntry>[0] = {}): Entry =>
  makeEntry({
    path: `types/${title.toLowerCase().replace(/\s+/g, '-')}.md`,
    title,
    type: 'Type',
    ...patch,
  });

describe('system types', () => {
  // M12.2: the metamodel is the only system type. Project and Work item are
  // ordinary types — rename them, delete them, or never declare them.
  it('marks only Type as system', () => {
    expect(isSystemType('Type')).toBe(true);
    expect(isSystemType('Project')).toBe(false);
    expect(isSystemType('Work item')).toBe(false);
    expect(isSystemType('Recipe')).toBe(false);
  });

  it('locks only the metamodel schema keys', () => {
    expect(isLockedField('Type', 'fields')).toBe(true);
    expect(isLockedField('Type', 'statuses')).toBe(true);
    expect(isLockedField('Work item', 'status')).toBe(false);
    expect(isLockedField('Project', 'key')).toBe(false);
    expect(isLockedField('Recipe', 'anything')).toBe(false);
  });
});

describe('listTypes', () => {
  it('lists only the metamodel in an empty vault', () => {
    const listing = listTypes([], buildSchema([]));
    const names = listing.map((t) => t.name);
    expect(names).toEqual(['Type']);
    expect(listing.every((t) => t.system)).toBe(true);
    expect(listing.every((t) => t.count === 0)).toBe(true);
  });

  it('merges declared types, counts records, and resolves the doc path', () => {
    const entries = [
      typeDoc('Recipe', { properties: { icon: 'chef-hat', color: '#DE8F0A' } }),
      makeEntry({ path: 'recipes/pasta.md', title: 'Pasta', type: 'Recipe' }),
      makeEntry({ path: 'recipes/soup.md', title: 'Soup', type: 'Recipe' }),
    ];
    const recipe = listTypes(entries, buildSchema(entries)).find((t) => t.name === 'Recipe');
    expect(recipe).toMatchObject({
      name: 'Recipe',
      icon: 'chef-hat',
      color: '#DE8F0A',
      count: 2,
      system: false,
      docPath: 'types/recipe.md',
    });
  });

  it('lists ghost types referenced by records but never declared', () => {
    const entries = [makeEntry({ path: 'a.md', type: 'Mystery' })];
    const ghost = listTypes(entries, buildSchema(entries)).find((t) => t.name === 'Mystery');
    expect(ghost).toMatchObject({ count: 1, system: false, docPath: null, icon: 'file-text' });
  });

  it('uses the metamodel fallback style when its Type doc declares none', () => {
    const meta = listTypes([], buildSchema([])).find((t) => t.name === 'Type');
    expect(meta).toMatchObject({ icon: 'shapes', docPath: null });
  });

  it('prefers the Type doc styling over the system fallback', () => {
    const entries = [typeDoc('Type', { properties: { icon: 'rocket', color: '#DE3B4E' } })];
    const meta = listTypes(entries, buildSchema(entries)).find((t) => t.name === 'Type');
    expect(meta).toMatchObject({ icon: 'rocket', color: '#DE3B4E', system: true });
    expect(systemTypeSpec('Type')?.fallbackIcon).toBe('shapes');
  });
});

describe('serializeFields', () => {
  it('round-trips through the schema parser', () => {
    const fields: FieldDef[] = [
      { name: 'status', kind: 'status' },
      {
        name: 'priority',
        kind: 'select',
        options: [
          { id: 'high', label: 'High', color: '#DE8F0A' },
          { id: 'low', label: 'Low', color: null },
        ],
      },
      { name: 'due', kind: 'date' },
      { name: 'points', kind: 'rollup', relation: 'items', property: 'estimate', calculate: 'sum' },
    ];
    const entries = [typeDoc('Ticket', { properties: { fields: serializeFields(fields) } })];
    expect(buildSchema(entries).types.get('Ticket')?.fields).toEqual(fields);
  });

  // M45.1: parseFieldDef reads all three of these; a serializer that drops
  // them loses data on any def that round-trips (applyTypeLayout's ADDED path).
  it('keeps visibility, dateFormat, and timeFormat on the spec', () => {
    const fields: FieldDef[] = [
      { name: 'due', kind: 'date', dateFormat: 'full', timeFormat: '24', visibility: 'hide' },
    ];
    const spec = serializeFields(fields).due as Record<string, unknown>;
    expect(spec).toMatchObject({ dateFormat: 'full', timeFormat: '24', visibility: 'hide' });
    const entries = [typeDoc('Ticket', { properties: { fields: serializeFields(fields) } })];
    expect(buildSchema(entries).types.get('Ticket')?.fields).toEqual(fields);
  });

  it('emits none of the three keys when the def carries none (deviations only)', () => {
    const spec = serializeFields([{ name: 'due', kind: 'date' }]).due as Record<string, unknown>;
    expect(spec).toEqual({ kind: 'date' });
  });

  // An EXPLICIT default is still the default: absent already means
  // 'show' / 'short' / '12', and a Type doc should not carry the absence of
  // an opinion — same rule as the `format !== 'plain'` guard.
  it('normalizes explicit defaults to no key on disk', () => {
    const spec = serializeFields([
      { name: 'due', kind: 'date', dateFormat: 'short', timeFormat: '12', visibility: 'show' },
    ]).due as Record<string, unknown>;
    expect(spec).toEqual({ kind: 'date' });
  });
});

describe('typeStyle', () => {
  it('resolves declared styling, the metamodel fallback, and the default', () => {
    const entries = [typeDoc('Recipe', { properties: { icon: 'chef-hat', color: '#DE8F0A' } })];
    const schema = buildSchema(entries);
    expect(typeStyle('Recipe', schema)).toEqual({ icon: 'chef-hat', color: '#DE8F0A' });
    expect(typeStyle('Type', schema)).toEqual({ icon: 'shapes', color: '#8B7CF6' });
    // M12.2: Project is nobody special — undeclared, it styles like any ghost.
    expect(typeStyle('Project', schema)).toEqual({ icon: 'file-text', color: null });
    expect(typeStyle(null, schema)).toEqual({ icon: 'file-text', color: null });
    expect(typeStyle('Mystery', schema)).toEqual({ icon: 'file-text', color: null });
  });
});

describe('typePresentation', () => {
  it('shows the declared fields and groups by status when the type has one', () => {
    const entries = [
      typeDoc('Work item', {
        properties: { fields: { status: { kind: 'status' }, due: { kind: 'date' } } },
      }),
    ];
    const p = typePresentation('Work item', buildSchema(entries));
    expect(p.group).toEqual([{ field: 'status' }]);
    expect(p.columns).toEqual([{ field: 'status' }, { field: 'due' }]);
  });

  it('falls back to a flat list for types without a status field', () => {
    const entries = [typeDoc('Person', { properties: { fields: { role: { kind: 'text' } } } })];
    const p = typePresentation('Person', buildSchema(entries));
    expect(p.group).toEqual([]);
    expect(p.columns).toEqual([{ field: 'role' }]);
  });

  // M19.1: a type that declares nothing used to borrow DEFAULT_PRESENTATION's
  // columns, so a brand-new type opened on a grid of Key, Status, Priority,
  // Assignee, Due and Estimate — six headers for properties no record had and
  // the record's own detail panel correctly showed none of.
  it('invents no columns for a type that declares no fields', () => {
    const entries = [typeDoc('Project')];
    const p = typePresentation('Project', buildSchema(entries));
    expect(p.columns).toEqual([]);
    expect(p.group).toEqual([]);
  });

  it('invents no columns for a type that has no Type doc at all', () => {
    const p = typePresentation('Nothing declared this', buildSchema([]));
    expect(p.columns).toEqual([]);
  });
});

describe('typeTabs (M44.5)', () => {
  it('synthesizes Overview when a type saved none — nothing written until owned', () => {
    const entries = [typeDoc('Work item')];
    expect(typeTabs('Work item', buildSchema(entries))).toEqual([
      { id: 'overview', name: 'Overview', icon: null, content: 'overview' },
    ]);
  });

  it('returns the saved list verbatim when one exists', () => {
    const entries = [
      typeDoc('Work item', {
        properties: { tabs: [{ id: 'spec', name: 'Spec', content: 'sections' }] },
      }),
    ];
    expect(typeTabs('Work item', buildSchema(entries)).map((t) => t.id)).toEqual(['spec']);
  });
});

/**
 * `views:` on a Type doc (M47.1).
 *
 * M12.3 built this and, like `folder:`, nothing has exercised it: no Type doc
 * in `demo-vault/` saves a view, and the only test that ever put `views:` on
 * one asserts a REFUSAL (`viewTab.test.ts` — a dashboard saved on a type is
 * not a legal record tab). So the guard was measured and the feature was not.
 * M47 turns a type's saved views into the views of a database, which makes
 * this the load-bearing path.
 */
describe('typeViews (M47.1)', () => {
  const savedView = (id: string, type: Presentation['type'] = 'table') => ({
    id,
    name: id,
    presentation: { type },
  });

  it('synthesizes one table when a type saved none — nothing written until owned', () => {
    const views = typeViews('Work item', buildSchema([typeDoc('Work item')]));
    expect(views).toHaveLength(1);
    expect(views[0]?.id).toBe('all');
    expect(views[0]?.presentation.type).toBe('table');
  });

  it('returns the saved views, in order, when a type declares them', () => {
    const entries = [
      typeDoc('Work item', {
        properties: { views: [savedView('board', 'board'), savedView('cal', 'calendar')] },
      }),
    ];
    const views = typeViews('Work item', buildSchema(entries));
    expect(views.map((v) => v.id)).toEqual(['board', 'cal']);
    expect(views.map((v) => v.presentation.type)).toEqual(['board', 'calendar']);
  });

  /**
   * Decision D8 of the M47 spec, from the other side: a database page that is
   * its own folder note contributes its views exactly like one in `types/`.
   * `buildSchema` scans every entry and never consults the path — pinned here
   * so the spec's claim has a test behind it and not just a reading of the code.
   */
  it('reads views off a Type doc that is a folder note, not a types/ file', () => {
    const entries = [
      typeDoc('Reading', {
        path: 'reading/reading.md',
        properties: { views: [savedView('shelf')] },
      }),
    ];
    expect(typeViews('Reading', buildSchema(entries)).map((v) => v.id)).toEqual(['shelf']);
  });

  /**
   * Vault-tolerant: `views: []` is not "this type has no views", it is a
   * hand-edited file saying nothing. Falling through to the synthesized table
   * is what keeps an empty list from rendering a type screen with no view at
   * all — the "unavailable is never empty" rule, applied to a container.
   */
  it('falls back to the default table when `views:` is empty or malformed', () => {
    for (const views of [[], null, 'table', 42, { id: 'x' }]) {
      const entries = [typeDoc('Work item', { properties: { views } as Entry['properties'] })];
      expect(typeViews('Work item', buildSchema(entries)).map((v) => v.id)).toEqual(['all']);
    }
  });
});
