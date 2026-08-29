import { describe, expect, it } from 'vitest';
import { resolveLayout } from './layout';
import type { LayoutTab } from './layout';
import { layoutTabScope } from './typeCatalog';
import { LAYOUT_DEFAULTS } from './types';
import type { FieldDef, LayoutConfig, TabDef } from './types';

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

describe('resolveLayout tab filter (M45.6)', () => {
  /** Three sections: one on `spec`, one on `plan`, one untabbed. */
  const tabbed: LayoutConfig = {
    heading: ['status'],
    groups: [
      { id: 'g-spec', name: 'Spec', fields: ['due'], tab: 'spec' },
      { id: 'g-plan', name: 'Plan', fields: ['team'], tab: 'plan' },
      { id: 'g-loose', name: 'Loose', fields: ['budget'] },
    ],
  };

  /** The seam a caller builds by hand; `layoutTabScope` builds the same shape
   * from a real tab roster (proved end to end at the bottom of this block). */
  const on = (id: string, isDefault: boolean, live = ['spec', 'plan']): LayoutTab => ({
    id,
    isDefault,
    isLive: (tabId) => live.includes(tabId),
  });

  it('resolves EVERY group without the tab argument — the pre-M45.6 behavior, verbatim', () => {
    // The load-bearing backward-compatibility claim: every call site that
    // predates M45.6 keeps its exact result, tabbed groups included.
    expect(resolveLayout(tabbed, fields)).toEqual(
      resolveLayout(
        {
          heading: ['status'],
          groups: [
            { id: 'g-spec', name: 'Spec', fields: ['due'] },
            { id: 'g-plan', name: 'Plan', fields: ['team'] },
            { id: 'g-loose', name: 'Loose', fields: ['budget'] },
          ],
        },
        fields,
      ),
    );
    expect(resolveLayout(tabbed, fields).groups.map((g) => g.id)).toEqual([
      'g-spec',
      'g-plan',
      'g-loose',
    ]);
  });

  it('shows a tabbed section on its own tab, and the untabbed one on the default', () => {
    expect(resolveLayout(tabbed, fields, on('spec', true)).groups.map((g) => g.id)).toEqual([
      'g-spec',
      'g-loose',
    ]);
  });

  it('hides a tabbed section on another tab', () => {
    expect(resolveLayout(tabbed, fields, on('plan', false)).groups.map((g) => g.id)).toEqual([
      'g-plan',
    ]);
  });

  it('hides an untabbed section on a NON-default tab', () => {
    const r = resolveLayout(tabbed, fields, on('plan', false));
    expect(r.groups.map((g) => g.id)).not.toContain('g-loose');
  });

  it('keeps rest global — a field claimed by a section on another tab is not loose here', () => {
    // Rest has no tab dimension (M45.6 decision): claiming is computed against
    // every group, so `due` and `team` never reappear as loose remainder.
    const r = resolveLayout(tabbed, fields, on('spec', true));
    expect(r.rest).toEqual([]);
  });

  it('shows a DEAD tab pointer on the default tab — a section never vanishes', () => {
    const dead: LayoutConfig = {
      heading: [],
      groups: [{ id: 'g-orphan', name: 'Orphan', fields: ['due'], tab: 'deleted-tab' }],
    };
    expect(resolveLayout(dead, fields, on('spec', true)).groups.map((g) => g.id)).toEqual([
      'g-orphan',
    ]);
    // It lands on the default tab ONCE, not on every tab.
    expect(resolveLayout(dead, fields, on('plan', false)).groups).toEqual([]);
  });

  it('describes flat by the VISIBLE shape — a tab holding no section keeps the flat stack', () => {
    const only: LayoutConfig = {
      heading: [],
      groups: [{ id: 'g-spec', name: 'Spec', fields: ['due'], tab: 'spec' }],
    };
    expect(resolveLayout(only, fields, on('spec', true)).flat).toBe(false);
    const other = resolveLayout(only, fields, on('plan', false));
    expect(other.groups).toEqual([]);
    expect(other.flat).toBe(true);
    // Still global: `due` belongs to the spec section, so it is not loose here.
    expect(other.rest.map((d) => d.name)).toEqual(['status', 'team', 'budget']);
  });

  it('never mutates its inputs when filtering by tab', () => {
    const config: LayoutConfig = {
      heading: [],
      groups: [
        { id: 'g-spec', name: 'Spec', fields: ['due'], tab: 'spec' },
        { id: 'g-loose', name: 'Loose', fields: ['team'] },
      ],
    };
    Object.freeze(config);
    Object.freeze(config.heading);
    Object.freeze(config.groups);
    for (const g of config.groups) {
      Object.freeze(g);
      Object.freeze(g.fields);
    }
    resolveLayout(config, fields, on('spec', true));
    expect(config.groups.map((g) => g.id)).toEqual(['g-spec', 'g-loose']);
  });

  it('answers the roster questions through layoutTabScope, dead pointer included', () => {
    // End to end at the seam: the CALLER (typeCatalog, which owns the roster)
    // reports id/isDefault/liveness; the ENGINE owns the fallback rule. Nobody
    // in between gets to decide a section is invisible.
    const tabs: TabDef[] = [
      { id: 'spec', name: 'Spec', icon: null, content: 'sections' },
      { id: 'details', name: 'Details', icon: null, content: 'properties' },
    ];
    const orphan: LayoutConfig = {
      heading: [],
      groups: [
        { id: 'g-orphan', name: 'Orphan', fields: ['due'], tab: 'deleted-tab' },
        { id: 'g-spec', name: 'On spec', fields: ['team'], tab: 'spec' },
      ],
    };
    // `details` is the default: the first PROPERTY-BEARING tab, not the first.
    expect(
      resolveLayout(orphan, fields, layoutTabScope(tabs, 'details')).groups.map((g) => g.id),
    ).toEqual(['g-orphan']);
    expect(
      resolveLayout(orphan, fields, layoutTabScope(tabs, 'spec')).groups.map((g) => g.id),
    ).toEqual(['g-spec']);
  });
});
