import type { FieldDef, LayoutConfig } from './types';

/** A `layout:` config resolved against a type's field roster (M45.1): names
 * become defs, dead FIELD pointers render as nothing. Purely a read — the
 * config is never mutated or pruned here; pointer hygiene happens on the
 * editor's next Apply (spec §4), the same contract favorites keep.
 *
 * A resolution is GLOBAL to the record (M46.1): every container it reports
 * renders above the tab strip, on every tab, so this module knows nothing
 * about tabs and no caller may narrow it by one. */
export interface ResolvedLayout {
  heading: FieldDef[];
  groups: { id: string; name: string; fields: FieldDef[] }[];
  /** Declared fields no container claimed, declaration order. Renders after
   * the named groups so a freshly added field lands visibly. */
  rest: FieldDef[];
  /** Nothing anywhere in the config resolved to a placement — render the
   * pre-M45 flat stack. The consumers' flat branch ignores `groups` and
   * `rest` and stacks the WHOLE declared roster
   * (RecordProperties/DocProperties). */
  flat: boolean;
}

/** Empty groups survive — the renderer skips them, the layout editor shows
 * them as drop targets. Parse guarantees a field name appears at most once
 * across `heading` + all `groups` (later claims drop at parse), so nothing
 * here dedups: `claimed` exists only to compute `rest`. */
export function resolveLayout(layout: LayoutConfig, fields: FieldDef[]): ResolvedLayout {
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
  const groups = layout.groups.map((g) => ({ id: g.id, name: g.name, fields: resolve(g.fields) }));
  const rest = fields.filter((d) => !claimed.has(d.name));
  // A layout whose every pointer is dead keeps today's flat stack (and its
  // reorder grip), not an empty shell.
  const flat = heading.length === 0 && groups.every((g) => g.fields.length === 0);
  return { heading, groups, rest, flat };
}

/**
 * Every field this resolution puts in front of a reader — the union of its
 * containers, in render order.
 *
 * It lives here, beside the invariant it depends on, because it is a
 * derivation of `ResolvedLayout` rather than of any one stack: the property
 * surfaces use it for the pooled hidden count, which promises rows the
 * expander must be able to produce. Two hand-rolled unions in two components
 * would both have to be found and edited the day a FOURTH container joins
 * heading/groups/rest — and the one that was missed would go on quietly
 * miscounting.
 *
 * Two facts make it exact rather than approximate:
 *
 * - Nothing is double-counted. Parse guarantees a field name appears at most
 *   once across `heading` and all `groups`, and `rest` is the complement of
 *   what those claimed.
 * - Nothing is missed. The containers PARTITION the roster — `rest` is
 *   exactly the fields no container claimed — so this returns the same
 *   members as the declared `fields` list.
 *
 * `flat` needs no special case. A flat resolution claimed nothing, so `rest`
 * IS the whole roster and the union comes out the same either way.
 */
export function revealableFields(layout: ResolvedLayout): FieldDef[] {
  return [...layout.heading, ...layout.groups.flatMap((g) => g.fields), ...layout.rest];
}
