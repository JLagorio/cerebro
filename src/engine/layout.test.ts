import { describe, expect, it } from 'vitest';
import { resolveLayout, revealableFields } from './layout';
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

  it('never mutates its inputs — dead pointers survive until the editor prunes on Apply', () => {
    // Frozen inputs make ANY write throw under strict mode — including a
    // transient mutate-then-restore, or a write to the roster, which a
    // compare-after-the-fact alone would miss.
    const config: LayoutConfig = {
      heading: ['due', 'ghost'],
      groups: [{ id: 'g1', name: 'Main', fields: ['gone', 'budget'] }],
    };
    Object.freeze(config);
    Object.freeze(config.heading);
    Object.freeze(config.groups);
    for (const g of config.groups) {
      Object.freeze(g);
      Object.freeze(g.fields);
    }
    const roster = Object.freeze(fields.map((d) => Object.freeze({ ...d })));
    resolveLayout(config, roster as FieldDef[]);
    expect(config).toEqual({
      heading: ['due', 'ghost'],
      groups: [{ id: 'g1', name: 'Main', fields: ['gone', 'budget'] }],
    });
  });
});

describe('resolveLayout is global to the record (M46.1)', () => {
  const config: LayoutConfig = {
    heading: ['status'],
    groups: [
      { id: 'g-spec', name: 'Spec', fields: ['due'] },
      { id: 'g-plan', name: 'Plan', fields: ['team'] },
      { id: 'g-loose', name: 'Loose', fields: ['budget'] },
    ],
  };

  it('resolves EVERY group — nothing can narrow them to a tab', () => {
    const r = resolveLayout(config, fields);
    expect(r.groups.map((g) => g.id)).toEqual(['g-spec', 'g-plan', 'g-loose']);
    // Structural, not a permissive default: there is no third parameter to
    // pass a scope through. Pinning the arity is what keeps a scoping seam
    // from creeping back in under a new name.
    expect(resolveLayout).toHaveLength(2);
  });

  it('puts no tab on a resolved group — the key is gone, not merely unset', () => {
    expect(Object.keys(resolveLayout(config, fields).groups[0])).toEqual(['id', 'name', 'fields']);
  });
});

// `revealableFields` is the union of a resolution's containers, and the
// property stacks count the folds inside it to size their one expander — an
// expander that promises rows it must be able to produce. The claim that
// makes the count equal the declared roster is pinned HERE, on the
// derivation, instead of being inferred from two component surfaces.
describe('revealableFields', () => {
  it('reveals the whole roster — the containers partition it', () => {
    const byName = (defs: FieldDef[]) => defs.map((d) => d.name).sort();
    const placed = resolveLayout(
      {
        heading: ['status'],
        groups: [
          { id: 'g1', name: 'Spec', fields: ['due'] },
          { id: 'g2', name: 'Plan', fields: ['team'] },
        ],
      },
      fields,
    );
    expect(byName(revealableFields(placed))).toEqual(byName(fields));
    // And the flat case needs no special arm — a resolution that claimed
    // nothing puts the whole roster in `rest`.
    expect(revealableFields(resolveLayout({ heading: ['ghost'], groups: [] }, fields))).toEqual(
      fields,
    );
  });
});
