import type { FieldDef, LayoutConfig, LayoutGroup } from './types';

/** A `layout:` config resolved against a type's field roster (M45.1): names
 * become defs, dead FIELD pointers render as nothing. Purely a read — the
 * config is never mutated or pruned here; pointer hygiene happens on the
 * editor's next Apply (spec §4), the same contract favorites keep.
 *
 * A dead TAB pointer is the opposite case and deliberately so: a field that
 * no longer exists has no value to show, while a section still holds real
 * properties, so it falls back onto the default tab VISIBLE (see
 * `LayoutTab`) rather than rendering as nothing. */
export interface ResolvedLayout {
  heading: FieldDef[];
  /** `tab` rides through unresolved — a tab id is a string this module never
   * interprets beyond `showsOn`, and carrying it is what lets a consumer
   * rebuild a config group from a resolved one without losing the
   * assignment (M45.6). Absent stays ABSENT, never `undefined`: the
   * deviations-only serializer must not learn a `tab:` key from a rebuild. */
  groups: { id: string; name: string; fields: FieldDef[]; tab?: string }[];
  /** Declared fields no container claimed, declaration order. Renders after
   * the named groups so a freshly added field lands visibly. Global by
   * decision (M45.6): rest is the remainder of the ROSTER, so a field a
   * section on another tab claims is not also loose here. */
  rest: FieldDef[];
  /** Nothing anywhere in the config resolved to a placement — render the
   * pre-M45 flat stack. GLOBAL, never per-tab: the consumers' flat branch
   * ignores `groups` and `rest` and stacks the WHOLE declared roster
   * (RecordProperties/DocProperties), so a per-tab `flat` would render a
   * field both inside its section on one tab and loose on another. */
  flat: boolean;
}

/**
 * Which tab a resolve is FOR (M45.6). This module holds NO tab roster and
 * must not learn one: it cannot know which tabs a type declares or which of
 * them is default, so the CALLER — who owns the roster — answers both
 * questions here. `typeCatalog.layoutTabScope(tabs, activeId)` builds this
 * from a type's `tabs:`, so every surface gets ONE answer instead of
 * re-deciding "which tab is default" per call site.
 *
 * The dead-pointer FALLBACK is this module's, not the caller's. The caller
 * only reports a fact it can see (`canHoldSections`); `resolveLayout` alone
 * decides what that fact means — a section whose tab can no longer hold it
 * shows on the default tab. That is why the predicate is REQUIRED rather
 * than optional with a permissive default: an omitted one would read as
 * "every tab can hold sections", and a section pointing at a tab that cannot
 * would silently vanish, the one outcome the doctrine forbids.
 */
export interface LayoutTab {
  /** The tab being rendered. */
  id: string;
  /** Is this the tab untabbed sections call home? Exactly one tab of a
   * roster answers true. */
  isDefault: boolean;
  /** CAN that tab id still hold sections? Deleted is one way to fail; so is
   * surviving as a kind that renders no property stack at all (a `sections`
   * or `view` tab IS its content), and a section stranded on one of those is
   * exactly as unreachable as a section on a tab that no longer exists. The
   * caller folds both in — this module gets a decision about ONE id, never
   * an enumerable roster: no ordering, no counting, no content kind. */
  canHoldSections: (tabId: string) => boolean;
}

/** Does this section render on that tab? Untabbed means the default tab
 * (which is what every group did before M45.6). A section whose tab cannot
 * hold it — deleted, or turned into a kind that renders no properties —
 * lands on the default tab too, and there ONLY: never nowhere, and never on
 * every tab at once. */
function showsOn(group: LayoutGroup, tab: LayoutTab): boolean {
  const owner = typeof group.tab === 'string' && group.tab !== '' ? group.tab : null;
  if (owner === null) return tab.isDefault;
  // Asked BEFORE the id match, so a stranded section has exactly one home
  // rather than two: a tab that cannot hold sections cannot hold its own
  // either, and showing it there AND on the default tab would render the
  // same properties twice.
  if (!tab.canHoldSections(owner)) return tab.isDefault;
  return owner === tab.id;
}

/** Empty groups survive — the renderer skips them, the layout editor shows
 * them as drop targets. Parse guarantees a field name appears at most once
 * across `heading` + all `groups` (later claims drop at parse), so nothing
 * here dedups: `claimed` exists only to compute `rest`.
 *
 * `tab` is OPTIONAL and omitting it is not a degenerate case: every group
 * resolves, which is this function's pre-M45.6 behavior verbatim, and every
 * caller that never learned about tabs keeps its exact result. Passing one
 * narrows the GROUPS to that tab's — the heading strip and `rest` stay
 * global, because the heading renders above the tab strip and rest is the
 * roster's remainder (M45.6 decisions). */
export function resolveLayout(
  layout: LayoutConfig,
  fields: FieldDef[],
  tab?: LayoutTab,
): ResolvedLayout {
  const byName = new Map(fields.map((d) => [d.name, d]));
  const claimed = new Set<string>();
  const resolve = (names: string[]): FieldDef[] => {
    const out: FieldDef[] = [];
    for (const name of names) {
      const def = byName.get(name);
      if (def) {
        out.push(def);
        claimed.add(name);
      }
    }
    return out;
  };
  const heading = resolve(layout.heading);
  // EVERY group resolves before the filter, so `claimed` — and therefore
  // `rest` — counts placements across all tabs. Filtering first would leak a
  // field placed on another tab back into this tab's loose remainder, which
  // is the same property shown twice.
  const resolved = layout.groups.map((g) => {
    const base = { id: g.id, name: g.name, fields: resolve(g.fields) };
    return typeof g.tab === 'string' && g.tab !== '' ? { ...base, tab: g.tab } : base;
  });
  const groups =
    tab === undefined ? resolved : resolved.filter((_, i) => showsOn(layout.groups[i], tab));
  const rest = fields.filter((d) => !claimed.has(d.name));
  // Flat describes the RESOLVED shape of the WHOLE config, before the tab
  // filter — a layout whose every pointer is dead must keep today's flat
  // stack (and its reorder grip), not an empty shell. Deliberately not
  // per-tab: the consumers' flat branch ignores `groups` and `rest` and
  // stacks the entire declared roster, so a tab holding no section of its
  // own would re-render a field that its section already shows on another
  // tab — the double-render the resolve-before-filter ordering above closes.
  // Consequence, and the right one: such a tab takes the NON-flat branch and
  // loses the roster's reorder grip. Once anything is placed anywhere, the
  // config owns the order, not the declaration list.
  const flat = heading.length === 0 && resolved.every((g) => g.fields.length === 0);
  return { heading, groups, rest, flat };
}
