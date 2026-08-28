import { describe, expect, it } from 'vitest';
import { resolveLayout } from './layout';
import { LAYOUT_DEFAULTS } from './types';
import type { FieldDef, LayoutConfig } from './types';

const f = (name: string): FieldDef => ({ name, kind: 'text' });
const fields = [f('status'), f('due'), f('team'), f('budget')];

describe('resolveLayout (M45.1)', () => {
  it('resolves the default config to the flat stack', () => {
    expect(resolveLayout(LAYOUT_DEFAULTS, fields)).toEqual({
      heading: [],
      groups: [],
      rest: fields,
      flat: true,
    });
  });

  it('places by name, skips dead pointers, keeps empty groups, rest in declaration order', () => {
    const r = resolveLayout(
      {
        heading: ['due', 'ghost'],
        groups: [
          { id: 'g1', name: 'Main', fields: ['budget', 'gone'] },
          { id: 'g2', name: 'Empty', fields: ['ghost2'] },
        ],
      },
      fields,
    );
    expect(r.heading.map((d) => d.name)).toEqual(['due']);
    expect(r.groups.map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(r.groups[0].name).toBe('Main');
    expect(r.groups[0].fields.map((d) => d.name)).toEqual(['budget']);
    expect(r.groups[1].fields).toEqual([]);
    expect(r.rest.map((d) => d.name)).toEqual(['status', 'team']);
    expect(r.flat).toBe(false);
  });

  it('is flat about the RESOLVED shape: an all-dead layout is flat', () => {
    const r = resolveLayout({ heading: ['ghost'], groups: [] }, fields);
    expect(r.flat).toBe(true);
    expect(r.rest).toEqual(fields);
  });

  it('is not flat when only groups place fields', () => {
    const r = resolveLayout(
      { heading: [], groups: [{ id: 'g1', name: 'Main', fields: ['team'] }] },
      fields,
    );
    expect(r.flat).toBe(false);
    expect(r.rest.map((d) => d.name)).toEqual(['status', 'due', 'budget']);
  });

  it('follows the layout order in containers, not roster order', () => {
    const r = resolveLayout({ heading: ['budget', 'status'], groups: [] }, fields);
    expect(r.heading.map((d) => d.name)).toEqual(['budget', 'status']);
  });

  it('leaves an empty rest when the layout claims every field', () => {
    const r = resolveLayout(
      {
        heading: ['status'],
        groups: [{ id: 'g1', name: 'All', fields: ['due', 'team', 'budget'] }],
      },
      fields,
    );
    expect(r.rest).toEqual([]);
    expect(r.flat).toBe(false);
  });

  it('is flat against an empty roster — every pointer is dead', () => {
    const r = resolveLayout(
      { heading: ['status'], groups: [{ id: 'g1', name: 'Main', fields: ['due'] }] },
      [],
    );
    expect(r).toEqual({
      heading: [],
      groups: [{ id: 'g1', name: 'Main', fields: [] }],
      rest: [],
      flat: true,
    });
  });

  it('never mutates the config — dead pointers survive until the editor prunes on Apply', () => {
    const config: LayoutConfig = {
      heading: ['due', 'ghost'],
      groups: [{ id: 'g1', name: 'Main', fields: ['gone', 'budget'] }],
    };
    resolveLayout(config, fields);
    expect(config).toEqual({
      heading: ['due', 'ghost'],
      groups: [{ id: 'g1', name: 'Main', fields: ['gone', 'budget'] }],
    });
  });
});
