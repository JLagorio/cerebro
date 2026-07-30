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
} from './typeCatalog';
import type { Entry, FieldDef } from './types';

const typeDoc = (title: string, patch: Parameters<typeof makeEntry>[0] = {}): Entry =>
  makeEntry({
    path: `types/${title.toLowerCase().replace(/\s+/g, '-')}.md`,
    title,
    type: 'Type',
    ...patch,
  });

describe('system types', () => {
  it('marks Project, Work item, and Type as system', () => {
    expect(isSystemType('Project')).toBe(true);
    expect(isSystemType('Work item')).toBe(true);
    expect(isSystemType('Type')).toBe(true);
    expect(isSystemType('Recipe')).toBe(false);
  });

  it('locks built-in fields but not custom ones', () => {
    expect(isLockedField('Work item', 'status')).toBe(true);
    expect(isLockedField('Work item', 'severity')).toBe(false);
    expect(isLockedField('Project', 'key')).toBe(true);
    expect(isLockedField('Recipe', 'anything')).toBe(false);
  });
});

describe('listTypes', () => {
  it('always includes system types, even in an empty vault', () => {
    const listing = listTypes([], buildSchema([]));
    const names = listing.map((t) => t.name);
    expect(names).toEqual(['Project', 'Type', 'Work item']);
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

  it('uses system fallbacks when no Type doc styles them', () => {
    const project = listTypes([], buildSchema([])).find((t) => t.name === 'Project');
    expect(project).toMatchObject({ icon: 'folder-kanban', docPath: null });
  });

  it('prefers the Type doc styling over the system fallback', () => {
    const entries = [typeDoc('Project', { properties: { icon: 'rocket', color: '#DE3B4E' } })];
    const project = listTypes(entries, buildSchema(entries)).find((t) => t.name === 'Project');
    expect(project).toMatchObject({ icon: 'rocket', color: '#DE3B4E', system: true });
    expect(systemTypeSpec('Project')?.fallbackIcon).toBe('folder-kanban');
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
    const entries = [
      typeDoc('Ticket', { properties: { fields: serializeFields(fields) } }),
    ];
    expect(buildSchema(entries).types.get('Ticket')?.fields).toEqual(fields);
  });
});

describe('typeStyle', () => {
  it('resolves declared styling, system fallbacks, and the default', () => {
    const entries = [typeDoc('Recipe', { properties: { icon: 'chef-hat', color: '#DE8F0A' } })];
    const schema = buildSchema(entries);
    expect(typeStyle('Recipe', schema)).toEqual({ icon: 'chef-hat', color: '#DE8F0A' });
    expect(typeStyle('Project', schema)).toEqual({ icon: 'folder-kanban', color: '#14B8A6' });
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
    const entries = [
      typeDoc('Person', { properties: { fields: { role: { kind: 'text' } } } }),
    ];
    const p = typePresentation('Person', buildSchema(entries));
    expect(p.group).toEqual([]);
    expect(p.columns).toEqual([{ field: 'role' }]);
  });
});
