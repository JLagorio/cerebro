import { bandKind, bandValueFor, NO_VALUE_KEY } from './grouping';
import { nextItemKey } from './itemKeys';
import type { ChildrenSpec, Entry, Schema } from './types';

/**
 * Where a new record of a given type lands (M9.6).
 *
 * Every create affordance used to decide this for itself — the quick-add row
 * knew about `<project>/items/`, and nothing else could create at all. One
 * rule here means the table's `+ New`, the board column's `+`, the hierarchy
 * row's "Add child", and the type screen all agree.
 */

export interface CreateTarget {
  folder: string;
  frontmatter: Record<string, unknown>;
}

export function createTarget(
  typeName: string,
  options: {
    /** The project.md path when creating inside a project. */
    project: Entry | null;
    entries: Entry[];
    /** Required so a band's key can be coerced into what the field stores —
     * see the `groupBy` branch below. */
    schema: Schema;
    /** Group value to preset, from the band the affordance sits in. */
    groupBy?: string | null;
    groupValue?: string | null;
  },
): CreateTarget {
  const { project, entries, schema, groupBy, groupValue } = options;
  const frontmatter: Record<string, unknown> = { type: typeName };

  // M12.2: containment is a property of the CONTEXT, not of the type. Any
  // record created inside a project lands in the project and takes a key
  // from its prefix; the same type created from its type screen lands in
  // its records folder. No type name is special.
  if (project !== null) {
    const prefix = typeof project.properties.key === 'string' ? project.properties.key : null;
    if (prefix !== null && prefix !== '') frontmatter.key = nextItemKey(prefix, entries);
  }

  // The band's value, unless it is the synthetic no-value or all-items group
  // — presetting `field: ''` there would write a property nobody asked for.
  //
  // Coerced through `bandValueFor` (M20.1), because a band KEY is not a stored
  // VALUE: the key is what `groupEntries` bucketed on, which for a relation or
  // person is the wikilink stem and for a checkbox is `String(true)`. Writing
  // it verbatim produced `epic: Bonsai` — filed under `properties` rather than
  // `relationships`, so the link did not exist and the record did not come back
  // to the band it was created in. `undefined` means the band cannot be
  // expressed as one write (multi-select), so nothing is seeded.
  if (
    groupBy != null &&
    groupBy !== '' &&
    groupValue != null &&
    groupValue !== '' &&
    groupValue !== NO_VALUE_KEY
  ) {
    const value = bandValueFor(groupValue, bandKind(entries, groupBy, schema));
    if (value !== undefined && value !== null) frontmatter[groupBy] = value;
  }

  // `folder:` on the Type doc pins where its records land (M12.2), and it is
  // read STRAIGHT OFF THE SCHEMA (M47.1). This used to re-find the Type doc in
  // `entries` and re-normalise the key itself, so the same `folder:` had two
  // readers with two copies of the trim-and-strip rule — and `TypeDef.folder`,
  // which `buildSchema` has always parsed, had no consumer at all. Safe
  // because every call site passes a schema built from the `entries` it also
  // passes (`useSchema` caches on that identity), so the two could never have
  // disagreed. M47 makes this key load-bearing, which is the wrong time to
  // keep a twin of it.
  const folder =
    project !== null
      ? `${project.path.replace(/\/project\.md$/, '')}/items`
      : (schema.types.get(typeName)?.folder ?? recordsFolder(typeName));

  return { folder, frontmatter };
}

/**
 * `records/<plural-slug>/` — the convention M3.3 made concrete in the demo
 * vault, used when the Type doc pins nothing with `folder:`.
 */
export function recordsFolder(typeName: string): string {
  const slug = typeName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `records/${pluralize(slug)}`;
}

function pluralize(slug: string): string {
  if (slug === '') return 'records';
  if (/(s|x|z|ch|sh)$/.test(slug)) return `${slug}es`;
  if (/[^aeiou]y$/.test(slug)) return `${slug.slice(0, -1)}ies`;
  return `${slug}s`;
}

/**
 * Frontmatter that links a new child back into a hierarchy (M9.6).
 *
 * A reverse descent means the CHILD holds the link, so the new record gets
 * it. A forward descent means the PARENT holds it — the child cannot express
 * the relationship at all, so this returns null and the caller must patch
 * the parent instead.
 */
export function childLink(
  parent: Entry,
  spec: ChildrenSpec,
): { frontmatter: Record<string, unknown> } | null {
  if (spec.direction === 'reverse') {
    return { frontmatter: { [spec.field]: `[[${parent.title}]]` } };
  }
  return null;
}

/** The type a hierarchy level produces, for labelling "Add <type>". */
export function childTypeOf(
  spec: ChildrenSpec,
  parentType: string | null,
  schema: Schema,
): string | null {
  if (spec.direction === 'reverse') return spec.type;
  const def = parentType === null ? undefined : schema.types.get(parentType);
  return def?.fields.find((f) => f.name === spec.field)?.target ?? null;
}
