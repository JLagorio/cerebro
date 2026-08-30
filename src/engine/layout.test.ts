import { describe, expect, it } from 'vitest';
import { resolveLayout, revealableFields } from './layout';
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
   * from a real tab roster (proved end to end at the bottom of this block).
   * `holds` is the set of tab ids that can still hold sections. */
  const on = (id: string, isDefault: boolean, holds = ['spec', 'plan']): LayoutTab => ({
    id,
    isDefault,
    canHoldSections: (tabId) => holds.includes(tabId),
  });

  it('resolves EVERY group without the tab argument — the pre-M45.6 behavior, verbatim', () => {
    // The load-bearing backward-compatibility claim: every call site that
    // predates M45.6 keeps its exact result, tabbed groups included. The ONE
    // difference is additive — `tab` rides onto the resolved group (nothing
    // that predates M45.6 reads that key), so the comparison is over the
    // shape those callers actually consume.
    const withTabs = resolveLayout(tabbed, fields);
    const untabbedTwin = resolveLayout(
      {
        heading: ['status'],
        groups: [
          { id: 'g-spec', name: 'Spec', fields: ['due'] },
          { id: 'g-plan', name: 'Plan', fields: ['team'] },
          { id: 'g-loose', name: 'Loose', fields: ['budget'] },
        ],
      },
      fields,
    );
    expect(withTabs.groups.map((g) => ({ id: g.id, name: g.name, fields: g.fields }))).toEqual(
      untabbedTwin.groups,
    );
    expect(withTabs.heading).toEqual(untabbedTwin.heading);
    expect(withTabs.rest).toEqual(untabbedTwin.rest);
    expect(withTabs.flat).toBe(untabbedTwin.flat);
    expect(withTabs.groups.map((g) => g.id)).toEqual(['g-spec', 'g-plan', 'g-loose']);
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

  it('strands nothing on a tab that can no longer HOLD sections — one home, not two', () => {
    // The tab still exists; it just stopped bearing properties (the user
    // re-kinded it to `view`). The surfaces render no property stack there,
    // so the section must fall back like a deleted pointer — and must NOT
    // also claim its own tab, or the same properties render twice.
    const stranded: LayoutConfig = {
      heading: [],
      groups: [{ id: 'g-plan', name: 'Plan', fields: ['due'], tab: 'plan' }],
    };
    const holds = ['spec'];
    expect(
      resolveLayout(stranded, fields, on('spec', true, holds)).groups.map((g) => g.id),
    ).toEqual(['g-plan']);
    expect(resolveLayout(stranded, fields, on('plan', false, holds)).groups).toEqual([]);
  });

  it('keeps flat GLOBAL — a tab holding no section must not re-stack the whole roster', () => {
    // The counterfactual this pins: `flat` off the FILTERED groups would be
    // true here, and the consumers' flat branch ignores `groups` and `rest`
    // and stacks the ENTIRE declared roster — so `due` would render loose on
    // this tab while its section already shows it on `spec`. Editable twice,
    // in two places.
    const only: LayoutConfig = {
      heading: [],
      groups: [{ id: 'g-spec', name: 'Spec', fields: ['due'], tab: 'spec' }],
    };
    expect(resolveLayout(only, fields, on('spec', true)).flat).toBe(false);
    const other = resolveLayout(only, fields, on('plan', false));
    expect(other.groups).toEqual([]);
    expect(other.flat).toBe(false);
    // Still global: `due` belongs to the spec section, so it is not loose here.
    expect(other.rest.map((d) => d.name)).toEqual(['status', 'team', 'budget']);
  });

  it('carries `tab` onto the resolved group, absent staying ABSENT', () => {
    // A consumer rebuilding a config group from a resolved one (the layout
    // editor seeds its draft that way) must not silently drop the
    // assignment — nor mint a `tab: undefined` key the deviations-only
    // serializer would then have to strip.
    const r = resolveLayout(tabbed, fields);
    expect(r.groups.map((g) => g.tab)).toEqual(['spec', 'plan', undefined]);
    expect(Object.keys(r.groups[2])).toEqual(['id', 'name', 'fields']);
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

  it('answers the roster questions through layoutTabScope, both fallbacks included', () => {
    // End to end at the seam: the CALLER (typeCatalog, which owns the roster)
    // reports id/isDefault/can-hold; the ENGINE owns the fallback rule. Nobody
    // in between gets to decide a section is invisible.
    const tabs: TabDef[] = [
      { id: 'spec', name: 'Spec', icon: null, content: 'sections' },
      { id: 'details', name: 'Details', icon: null, content: 'properties' },
      { id: 'plan', name: 'Plan', icon: null, content: 'overview' },
    ];
    const orphan: LayoutConfig = {
      heading: [],
      groups: [
        { id: 'g-gone', name: 'Deleted tab', fields: ['due'], tab: 'deleted-tab' },
        { id: 'g-spec', name: 'On a sections tab', fields: ['team'], tab: 'spec' },
        { id: 'g-plan', name: 'On a real tab', fields: ['budget'], tab: 'plan' },
      ],
    };
    // `details` is the default: the first PROPERTY-BEARING tab, not the first.
    // Both stranded sections land there, and only there.
    expect(
      resolveLayout(orphan, fields, layoutTabScope(tabs, 'details')).groups.map((g) => g.id),
    ).toEqual(['g-gone', 'g-spec']);
    expect(resolveLayout(orphan, fields, layoutTabScope(tabs, 'spec')).groups).toEqual([]);
    expect(
      resolveLayout(orphan, fields, layoutTabScope(tabs, 'plan')).groups.map((g) => g.id),
    ).toEqual(['g-plan']);
  });

  // `revealableFields` is the union of a resolution's containers, and the
  // property stacks count the folds inside it to size their one expander —
  // an expander that promises rows it must be able to produce. The claim
  // that makes the absent-tab count identical to the pre-M45.6 one is pinned
  // HERE, on the derivation, instead of being inferred from two component
  // surfaces.
  it('reveals the whole roster when no tab scopes the resolve', () => {
    // Same MEMBERS as the declared list: the containers partition it, so a
    // count taken over this is the count taken over `fields`.
    const byName = (defs: FieldDef[]) => defs.map((d) => d.name).sort();
    expect(byName(revealableFields(resolveLayout(tabbed, fields)))).toEqual(byName(fields));
    // And the flat case needs no special arm — a resolution that claimed
    // nothing puts the whole roster in `rest`.
    expect(revealableFields(resolveLayout({ heading: ['ghost'], groups: [] }, fields))).toEqual(
      fields,
    );
  });

  it('reveals less by exactly the sections another tab holds', () => {
    // The heading and the loose remainder are global, so the spec tab
    // reveals `status` and `budget` alongside its own `due`. `team` is the
    // plan tab's, and it is revealed THERE — never counted here, where
    // nothing could produce the row.
    expect(revealableFields(resolveLayout(tabbed, fields, on('spec', true)))).toEqual([
      f('status'),
      f('due'),
      f('budget'),
    ]);
  });
});
