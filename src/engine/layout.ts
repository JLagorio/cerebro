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
  groups: { id: string; name: string; fields: FieldDef[] }[];
  /** Declared fields no container claimed, declaration order. Renders after
   * the named groups so a freshly added field lands visibly. Global by
   * decision (M45.6): rest is the remainder of the ROSTER, so a field a
   * section on another tab claims is not also loose here. */
  rest: FieldDef[];
  /** Nothing resolved to a placement — render the pre-M45 flat stack. */
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
 * only reports a fact it can see (`isLive`: does the type still declare this
 * tab id?); `resolveLayout` alone decides what that fact means — a section
 * whose tab died shows on the default tab. That is why `isLive` is REQUIRED
 * rather than optional with a permissive default: an omitted predicate would
 * read as "every tab is live", and a section pointing at a deleted tab would
 * silently vanish, the one outcome the doctrine forbids.
 */
export interface LayoutTab {
  /** The tab being rendered. */
  id: string;
  /** Is this the tab untabbed sections call home? Exactly one tab of a
   * roster answers true. */
  isDefault: boolean;
  /** Does the type still declare `tabId`? Liveness only — no ordering, no
   * content kind, nothing this module could mistake for a roster. */
  isLive: (tabId: string) => boolean;
}

/** Does this section render on that tab? Untabbed means the default tab
 * (which is what every group did before M45.6). A section pointing at a tab
 * that no longer exists lands on the default tab too, and there ONLY — never
 * nowhere, and never on every tab at once. */
function showsOn(group: LayoutGroup, tab: LayoutTab): boolean {
  const owner = typeof group.tab === 'string' && group.tab !== '' ? group.tab : null;
  if (owner === null) return tab.isDefault;
  if (owner === tab.id) return true;
  return tab.isDefault && !tab.isLive(owner);
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
  const resolved = layout.groups.map((g) => ({
    id: g.id,
    name: g.name,
    fields: resolve(g.fields),
  }));
  const groups =
    tab === undefined ? resolved : resolved.filter((_, i) => showsOn(layout.groups[i], tab));
  const rest = fields.filter((d) => !claimed.has(d.name));
  // Flat describes the RESOLVED shape: a layout whose every pointer is dead
  // must keep today's flat stack (and its reorder grip), not an empty shell.
  // With a tab, "resolved" means resolved HERE — a tab whose sections all
  // live elsewhere shows the remainder flat, which is what that tab looked
  // like before any section named it.
  const flat = heading.length === 0 && groups.every((g) => g.fields.length === 0);
  return { heading, groups, rest, flat };
}
