import { applyEntryPatch } from './entryPatch';
import { resolveLayout } from './layout';
import { statusFieldOf } from './pageCard';
import { kindMeta, validatePatch } from './properties';
import type { Entry, FieldDef, Schema } from './types';
import { slugify } from '@/lib/slug';

/** A transient record has the scanner's field shape, but no file or hash. */
export function draftEntry(type: string, values: Record<string, unknown>, title = ''): Entry {
  return applyEntryPatch(
    {
      path: '(draft)',
      filename: '(draft)',
      folder: '',
      project: null,
      title,
      type,
      properties: {},
      relationships: {},
      outgoingLinks: [],
      snippet: '',
      createdAt: '',
      modifiedAt: '',
      parseError: null,
      hash: null,
    },
    values,
  );
}

export function composerFields(type: string, schema: Schema): FieldDef[] {
  const definition = schema.types.get(type);
  if (definition === undefined) return [];
  const editable = (field: FieldDef) =>
    !kindMeta(field.kind).computed && field.from === undefined && field.kind !== 'files';
  const heading = resolveLayout(definition.layout, definition.fields).heading.filter(editable);
  if (heading.length > 0) return heading;
  const status = statusFieldOf(draftEntry(type, {}), schema);
  const deadline = definition.fields.find((field) => field.name === definition.deadline);
  return [status, deadline].filter((field): field is FieldDef => field != null && editable(field));
}

/** Start in the first active status, or the first declared status when that
 * database has no active group. No status capability means no invented key. */
export function initialStatus(type: string, schema: Schema): string | null {
  const entry = draftEntry(type, {});
  if (statusFieldOf(entry, schema) === null) return null;
  const statuses = schema.statusSetFor(entry);
  return (statuses.find((status) => status.group === 'active') ?? statuses[0])?.id ?? null;
}

export function initialValues(type: string, schema: Schema): Record<string, unknown> {
  const status = statusFieldOf(draftEntry(type, {}), schema);
  const value = initialStatus(type, schema);
  return status === null || value === null ? {} : { [status.name]: value };
}

export function recordSlug(title: string, fallback: string): string {
  const slug = slugify(title);
  if (slug === '') return fallback;
  if (slug.length <= 80) return slug;
  const shortened = slug.slice(0, 80);
  const boundary = shortened.lastIndexOf('-');
  return boundary > 0 ? shortened.slice(0, boundary).replace(/-+$/, '') : fallback;
}

export function draftFrontmatter(
  target: Record<string, unknown>,
  values: Record<string, unknown>,
  type: string,
  schema: Schema,
): { frontmatter: Record<string, unknown>; problems: string[] } {
  const kept = Object.fromEntries(
    Object.entries(values).filter(
      ([, value]) => value != null && value !== '' && (!Array.isArray(value) || value.length > 0),
    ),
  );
  return {
    frontmatter: { ...target, ...kept },
    problems: validatePatch(schema, draftEntry(type, {}), kept),
  };
}

/** Search ranking stays with the search service. Widened matches are advice
 * for another query and must not suggest that this record already exists. */
export function pickSimilar(
  result: { widened: boolean; hits: readonly { path: string }[] },
  type: string,
  entries: readonly Entry[],
): Entry[] {
  if (result.widened) return [];
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const hit of result.hits) {
    const entry = byPath.get(hit.path);
    if (entry?.type !== type || seen.has(entry.path)) continue;
    out.push(entry);
    seen.add(entry.path);
    if (out.length === 2) break;
  }
  return out;
}
