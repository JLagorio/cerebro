/**
 * Type schema write-side (M3): every mutation of a Type doc's `fields:`
 * mapping goes through here so the sidebar, the type screen, and the doc
 * panels share one hardened code path. Guards that used to fail silently:
 *
 *   - the Type doc is matched case-insensitively (title drift), and created
 *     under types/ when the type has no doc yet (system + ghost types);
 *   - a Type doc with YAML errors refuses edits instead of clobbering its
 *     whole `fields:` mapping with `{}`;
 *   - duplicate names are checked case-insensitively.
 */

import { kindMeta } from '@/engine/properties';
import { isLockedField, serializeOptions } from '@/engine/typeCatalog';
import type { Entry, FieldKind, FieldOption } from '@/engine/types';
import { slugify } from '@/lib/slug';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/** Frontmatter keys with schema meaning on a Type doc — never field names. */
const RESERVED = new Set(['type', 'icon', 'color', 'fields', 'statuses']);

export function normalizeFieldName(raw: string): string {
  return raw.trim().replace(/\s+/g, '_').toLowerCase();
}

/** The `type: Type` doc declaring a type; exact title match first, then
 * case-insensitive so a drifted H1 still resolves. */
export function findTypeDoc(entries: Entry[], typeName: string): Entry | null {
  return (
    entries.find((e) => e.type === 'Type' && e.title === typeName) ??
    entries.find(
      (e) => e.type === 'Type' && e.title.toLowerCase() === typeName.toLowerCase(),
    ) ??
    null
  );
}

/** Create the Type doc for a type that exists without one (system and ghost
 * types), so styling/fields have somewhere to live. */
export async function ensureTypeDoc(
  listing: { name: string; docPath: string | null },
  frontmatter: Record<string, unknown> = {},
): Promise<string> {
  if (listing.docPath !== null) return listing.docPath;
  const { createItem } = useVaultStore.getState();
  return createItem({
    folder: 'types',
    slug: slugify(listing.name) || 'type',
    frontmatter: { type: 'Type', ...frontmatter },
    body: `# ${listing.name}\n`,
  });
}

function rawFieldsOf(doc: Entry): Record<string, unknown> {
  const raw = (doc.properties as Record<string, unknown>).fields;
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : {};
}

/** Refuse `fields:` edits when the doc can't be trusted: a parse error means
 * our in-memory copy may be empty and a write would clobber the mapping. */
function guardEditable(doc: Entry | null, typeName: string): boolean {
  if (doc === null || doc.parseError === null) return true;
  useUiStore.getState().toast(`Can't edit "${typeName}" — its type doc has YAML errors`);
  return false;
}

/**
 * Declare a new field on a type. Creates the Type doc when missing. Returns
 * true when the write went through (failures toast).
 */
export async function addFieldToType(
  typeName: string,
  rawName: string,
  kind: FieldKind,
): Promise<boolean> {
  const { entries, patchFrontmatter } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  const name = normalizeFieldName(rawName);
  if (name === '') return false;
  if (RESERVED.has(name)) {
    toast(`"${name}" is a reserved key and can't be a property`);
    return false;
  }
  const doc = findTypeDoc(entries, typeName);
  if (!guardEditable(doc, typeName)) return false;
  const fields = doc !== null ? rawFieldsOf(doc) : {};
  if (Object.keys(fields).some((k) => k.toLowerCase() === name)) {
    toast('Property already exists');
    return false;
  }
  fields[name] = kind === 'text' ? 'text' : { kind };
  try {
    if (doc === null) {
      await ensureTypeDoc({ name: typeName, docPath: null }, { fields });
    } else {
      await patchFrontmatter(doc.path, { fields });
    }
  } catch {
    toast(`Couldn't add "${name}" to ${typeName}`);
    return false;
  }
  return true;
}

/** Remove a custom field from a type. System-locked fields refuse. */
export async function removeFieldFromType(typeName: string, fieldName: string): Promise<boolean> {
  const { entries, patchFrontmatter } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  if (isLockedField(typeName, fieldName)) {
    toast(`"${fieldName}" is a built-in property of ${typeName} and can't be removed`);
    return false;
  }
  const doc = findTypeDoc(entries, typeName);
  if (doc === null) return false;
  if (!guardEditable(doc, typeName)) return false;
  const fields = rawFieldsOf(doc);
  const actual = Object.keys(fields).find((k) => k.toLowerCase() === fieldName.toLowerCase());
  if (actual === undefined) return false;
  delete fields[actual];
  try {
    await patchFrontmatter(doc.path, { fields });
  } catch {
    toast(`Couldn't remove "${fieldName}"`);
    return false;
  }
  return true;
}

/** Replace a field's option set (select / multiselect / status configs). */
export async function setFieldOptions(
  typeName: string,
  fieldName: string,
  options: FieldOption[],
): Promise<boolean> {
  const { entries, patchFrontmatter } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  if (isLockedField(typeName, fieldName)) {
    toast(`"${fieldName}" is a built-in property of ${typeName} and can't be changed`);
    return false;
  }
  const doc = findTypeDoc(entries, typeName);
  if (doc === null) return false;
  if (!guardEditable(doc, typeName)) return false;
  const fields = rawFieldsOf(doc);
  const actual = Object.keys(fields).find((k) => k.toLowerCase() === fieldName.toLowerCase());
  if (actual === undefined) return false;
  const raw = fields[actual];
  const spec: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : { kind: typeof raw === 'string' ? raw : 'select' };
  spec.options = serializeOptions(options);
  fields[actual] = spec;
  try {
    await patchFrontmatter(doc.path, { fields });
  } catch {
    toast(`Couldn't update "${fieldName}" options`);
    return false;
  }
  return true;
}

/**
 * Shared "+ Add property" behavior: a TYPED doc extends its type's schema
 * (creating the Type doc when missing — previously this silently wrote a
 * loose key); an untyped doc gets plain frontmatter seeded by kind.
 */
export async function addPropertyToEntry(
  entry: Entry,
  rawName: string,
  kind: FieldKind,
): Promise<boolean> {
  const { patchFrontmatter } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  const name = normalizeFieldName(rawName);
  if (name === '') return false;
  const existing = new Set(
    [...Object.keys(entry.properties), ...Object.keys(entry.relationships)].map((k) =>
      k.toLowerCase(),
    ),
  );
  if (name === 'type' || existing.has(name)) {
    toast('Property already exists');
    return false;
  }
  if (entry.type !== null) {
    return addFieldToType(entry.type, name, kind);
  }
  if (kindMeta(kind).computed) {
    toast('Computed properties need a Type — assign one first');
    return false;
  }
  try {
    await patchFrontmatter(entry.path, { [name]: kindMeta(kind).seed });
  } catch {
    toast(`Couldn't add "${name}"`);
    return false;
  }
  return true;
}
