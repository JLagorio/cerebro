import { formatWikilink, linkTargetOf } from './wikilink';
import { bandDef, bandSeedFor, NO_VALUE_KEY } from './grouping';
import { keyPrefixOf, nextItemKey } from './itemKeys';
import type { ChildrenSpec, Entry, Schema } from './types';

/** A related tab files new records under its host through this stored field. */
export interface FiledUnder {
  host: Entry;
  field: string;
}

/** Every create affordance uses the database's home and the same filing rules. */
export interface CreateTarget {
  folder: string;
  frontmatter: Record<string, unknown>;
}

export function createTarget(
  typeName: string,
  options: {
    host?: FiledUnder | null;
    entries: Entry[];
    /** Required so a band's key can be coerced into what the field stores —
     * see the `groupBy` branch below. */
    schema: Schema;
    /** Group value to preset, from the band the affordance sits in. */
    groupBy?: string | null;
    groupValue?: string | null;
  },
): CreateTarget {
  const { host = null, entries, schema, groupBy, groupValue } = options;
  const frontmatter: Record<string, unknown> = { type: typeName };

  const prefix = host === null ? null : keyPrefixOf(host.host);
  if (
    prefix !== null &&
    schema.types.get(typeName)?.fields.some((field) => field.kind === 'status')
  ) {
    frontmatter.key = nextItemKey(prefix, entries);
  }

  // The band's value, unless it is the synthetic no-value or all-items group
  // — presetting `field: ''` there would write a property nobody asked for.
  //
  // A band key is not its stored value: bandSeedFor wraps links and keeps
  // multi-value fields as lists. Multi-day date bands, computed and derived
  // fields seed nothing. A dated create requires one particular day.
  if (
    groupBy != null &&
    groupBy !== '' &&
    groupValue != null &&
    groupValue !== '' &&
    groupValue !== NO_VALUE_KEY
  ) {
    const def =
      schema.types.get(typeName)?.fields.find((field) => field.name === groupBy) ??
      bandDef(entries, groupBy, schema);
    const value = bandSeedFor(groupValue, def);
    if (value !== undefined && value !== null) frontmatter[groupBy] = value;
  }

  // Filing belongs to the tab's host, even when its view groups by this field.
  if (host !== null) frontmatter[host.field] = formatWikilink(linkTargetOf(host.host));
  const folder = schema.types.get(typeName)?.folder ?? recordsFolder(typeName);

  return { folder, frontmatter };
}

/**
 * `records/<plural-slug>/` — the convention M3.3 made concrete in the demo
 * vault, used when the Type doc pins nothing with `folder:`.
 */
export function recordsFolder(typeName: string): string {
  return `records/${pluralize(typeSlug(typeName))}`;
}

const typeSlug = (typeName: string): string =>
  typeName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * The home a NEW database writes down as its `folder:` — `recordsFolder`,
 * unless another database already lives there.
 *
 * `pluralize` leaves an already-plural name alone, so `Task` and `Tasks` (and
 * `Bet`/`Bets`, `Note`/`Notes`) both come out as `records/tasks`. Harmless
 * while the folder was an implicit fallback; once `createDatabase` writes it
 * down, two databases would share one home — rows interleaved on disk, and
 * one title able to land on another database's file. So the first free one
 * of `records/<plural>`, `records/<slug>`, then `-2`, `-3`… is taken instead.
 * "In use" is any other database's home, declared or implied, and any folder
 * that already holds another type's records.
 */
export function homeFolderFor(name: string, schema: Schema, entries: Entry[]): string {
  const taken = new Set<string>();
  for (const [typeName, def] of schema.types) {
    if (typeName !== name) taken.add(def.folder ?? recordsFolder(typeName));
  }
  const occupied = (folder: string) =>
    taken.has(folder) ||
    entries.some(
      (e) =>
        e.type !== null &&
        e.type !== name &&
        (e.folder === folder || e.folder.startsWith(`${folder}/`)),
    );
  const home = recordsFolder(name);
  for (const candidate of [home, `records/${typeSlug(name) || 'records'}`]) {
    if (!occupied(candidate)) return candidate;
  }
  for (let n = 2; ; n++) {
    if (!occupied(`${home}-${n}`)) return `${home}-${n}`;
  }
}

function pluralize(slug: string): string {
  if (slug === '') return 'records';
  // A name that is ALREADY plural is left alone (M47.4). People name
  // databases in the plural — Tasks, Notes, Books, Groceries — and the
  // sibilant rule below read every one of them as needing `es`, so they
  // became `taskses` and `grocerieses`. That was invisible while
  // `recordsFolder` was only an implicit fallback; `createDatabase` writes
  // the folder DOWN, which would have put the misspelling in the user's own
  // file. `ss` is exempt because it is not a plural ending: Process still
  // pluralizes to processes.
  if (/[^s]s$/.test(slug)) return slug;
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
    return { frontmatter: { [spec.field]: formatWikilink(linkTargetOf(parent)) } };
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
