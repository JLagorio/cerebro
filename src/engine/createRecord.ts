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
    /** Group value to preset, from the band the affordance sits in. */
    groupBy?: string | null;
    groupValue?: string | null;
  },
): CreateTarget {
  const { project, entries, groupBy, groupValue } = options;
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
  if (
    groupBy != null &&
    groupBy !== '' &&
    groupValue != null &&
    groupValue !== '' &&
    groupValue !== '__none__'
  ) {
    frontmatter[groupBy] = groupValue;
  }

  const folder =
    project !== null
      ? `${project.path.replace(/\/project\.md$/, '')}/items`
      : (declaredFolder(typeName, entries) ?? recordsFolder(typeName));

  return { folder, frontmatter };
}

/** `folder:` on the Type doc pins where its records land (M12.2). */
function declaredFolder(typeName: string, entries: Entry[]): string | null {
  const doc = entries.find((e) => e.type === 'Type' && e.title === typeName);
  const folder = doc?.properties.folder;
  if (typeof folder !== 'string' || folder.trim() === '') return null;
  return folder.trim().replace(/^\/+|\/+$/g, '');
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
export function childTypeOf(spec: ChildrenSpec, parentType: string | null, schema: Schema): string | null {
  if (spec.direction === 'reverse') return spec.type;
  const def = parentType === null ? undefined : schema.types.get(parentType);
  return def?.fields.find((f) => f.name === spec.field)?.target ?? null;
}
