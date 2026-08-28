import type { FieldDef, LayoutConfig } from './types';

/** A `layout:` config resolved against a type's field roster (M45.1): names
 * become defs, dead pointers render as nothing. Purely a read — the config
 * is never mutated or pruned here; pointer hygiene happens on the editor's
 * next Apply (spec §4), the same contract favorites keep. */
export interface ResolvedLayout {
  heading: FieldDef[];
  groups: { id: string; name: string; fields: FieldDef[] }[];
  /** Declared fields no container claimed, declaration order. Renders after
   * the named groups so a freshly added field lands visibly. */
  rest: FieldDef[];
  /** Nothing resolved to a placement — render the pre-M45 flat stack. */
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
  // Flat describes the RESOLVED shape: a layout whose every pointer is dead
  // must keep today's flat stack (and its reorder grip), not an empty shell.
  const flat = heading.length === 0 && groups.every((g) => g.fields.length === 0);
  return { heading, groups, rest, flat };
}
