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
import { humanize } from '@/engine/schema';
import { isLockedField, serializeOptions } from '@/engine/typeCatalog';
import { serializeViewList } from '@/engine/views';
import type { Entry, FieldKind, FieldOption, StatusDef, ViewDefinition } from '@/engine/types';
import { slugify } from '@/lib/slug';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/** Frontmatter keys with schema meaning on a Type doc — never field names. */
const RESERVED = new Set(['type', 'icon', 'color', 'fields', 'statuses', 'folder', 'views']);

/** Leading underscores are stripped: `_`-prefixed keys are the app-managed
 * namespace (M4, see engine/properties.isSystemProperty) and a user-declared
 * field must never land in it — the property surfaces would hide it. */
export function normalizeFieldName(raw: string): string {
  return raw.trim().replace(/\s+/g, '_').toLowerCase().replace(/^_+/, '');
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

/**
 * Rename a declared field, keeping its position in the `fields:` mapping and
 * migrating every record that carries the old key (M3.1: renaming the schema
 * without moving the data would orphan every stored value).
 */
export async function renameFieldOnType(
  typeName: string,
  fieldName: string,
  rawNext: string,
): Promise<boolean> {
  const { entries, patchFrontmatter } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  const next = normalizeFieldName(rawNext);
  if (next === '' || next === fieldName) return false;
  if (isLockedField(typeName, fieldName)) {
    toast(`"${fieldName}" is a built-in property of ${typeName} and can't be renamed`);
    return false;
  }
  if (RESERVED.has(next)) {
    toast(`"${next}" is a reserved key and can't be a property`);
    return false;
  }
  const doc = findTypeDoc(entries, typeName);
  if (doc === null) return false;
  if (!guardEditable(doc, typeName)) return false;
  const fields = rawFieldsOf(doc);
  const actual = Object.keys(fields).find((k) => k.toLowerCase() === fieldName.toLowerCase());
  if (actual === undefined) return false;
  if (Object.keys(fields).some((k) => k.toLowerCase() === next && k !== actual)) {
    toast('Property already exists');
    return false;
  }
  // Rebuild the mapping so the renamed key keeps its slot in the panel order.
  const renamed = Object.fromEntries(
    Object.entries(fields).map(([k, v]) => (k === actual ? [next, v] : [k, v])),
  );
  try {
    await patchFrontmatter(doc.path, { fields: renamed });
  } catch {
    toast(`Couldn't rename "${fieldName}"`);
    return false;
  }
  // Move stored values on every record of this type. A record whose write
  // fails keeps its old key — the schema rename already landed, so the value
  // still resolves as an undeclared property rather than vanishing.
  const records = entries.filter(
    (e) => e.type === typeName && (actual in e.properties || actual in e.relationships),
  );
  let failed = 0;
  for (const record of records) {
    const targets = record.relationships[actual];
    const value =
      targets !== undefined ? targets.map((t) => `[[${t}]]`) : record.properties[actual];
    try {
      await patchFrontmatter(record.path, { [next]: value, [actual]: null });
    } catch {
      failed += 1;
    }
  }
  if (failed > 0) toast(`Renamed, but ${failed} record(s) kept the old value`);
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
 * Patch a field's spec keys (M3.4): rollup wiring (`relation`, `property`,
 * `calculate`) and display config (`format`, `precision`). Passing null for a
 * key drops it. Kept separate from setFieldOptions so a config change never
 * rewrites the option set.
 */
export async function setFieldConfig(
  typeName: string,
  fieldName: string,
  config: Partial<Record<'relation' | 'property' | 'calculate' | 'format' | 'precision', unknown>>,
): Promise<boolean> {
  const { entries, patchFrontmatter } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  const doc = findTypeDoc(entries, typeName);
  if (doc === null) return false;
  if (!guardEditable(doc, typeName)) return false;
  const fields = rawFieldsOf(doc);
  const actual = Object.keys(fields).find((k) => k.toLowerCase() === fieldName.toLowerCase());
  if (actual === undefined) return false;
  const raw = fields[actual];
  // A bare `field: text` shorthand has to grow into a mapping to hold config.
  const spec: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : { kind: typeof raw === 'string' ? raw : 'text' };
  for (const [key, value] of Object.entries(config)) {
    if (value === null || value === undefined || value === '') delete spec[key];
    else spec[key] = value;
  }
  fields[actual] = spec;
  try {
    await patchFrontmatter(doc.path, { fields });
  } catch {
    toast(`Couldn't update "${fieldName}"`);
    return false;
  }
  return true;
}

/**
 * Replace a type's own `statuses:` list (M3.1). Unlike `fields:`, statuses
 * are a top-level key on the Type doc — including on system types, whose
 * status chain the whole app reads. Editing them is allowed (the LOCK is on
 * the `status` field's existence, not on which statuses a team uses); the
 * list is written whole so reordering and regrouping round-trip.
 */
export async function setTypeStatuses(
  listing: { name: string; docPath: string | null },
  statuses: StatusDef[],
): Promise<boolean> {
  const { entries, patchFrontmatter } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  const doc = findTypeDoc(entries, listing.name);
  if (!guardEditable(doc, listing.name)) return false;
  const serialized = statuses.map((s) => {
    const spec: Record<string, unknown> = { id: s.id, group: s.group };
    if (s.label !== humanize(s.id)) spec.label = s.label;
    if (s.color !== null) spec.color = s.color;
    if (s.hollow === true) spec.hollow = true;
    return spec;
  });
  try {
    if (doc === null) {
      await ensureTypeDoc({ name: listing.name, docPath: null }, { statuses: serialized });
    } else {
      await patchFrontmatter(doc.path, { statuses: serialized });
    }
  } catch {
    toast(`Couldn't update ${listing.name} statuses`);
    return false;
  }
  return true;
}

/**
 * Persist a type screen's saved views onto its Type doc (M12.3). The whole
 * array is written each time — a saved view IS its configuration, same
 * contract as a List's `.list.yml`.
 */
export async function setTypeViews(
  listing: { name: string; docPath: string | null },
  views: ViewDefinition[],
): Promise<boolean> {
  const { entries, patchFrontmatter } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  const doc = findTypeDoc(entries, listing.name);
  if (!guardEditable(doc, listing.name)) return false;
  const serialized = serializeViewList(views);
  try {
    if (doc === null) {
      await ensureTypeDoc({ name: listing.name, docPath: null }, { views: serialized });
    } else {
      await patchFrontmatter(doc.path, { views: serialized });
    }
  } catch {
    toast(`Couldn't update ${listing.name} views`);
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

/**
 * Move a property up or down in the type's `fields:` mapping (M9.6).
 *
 * The declaration order drives default column order everywhere, so this is
 * the schema-level equivalent of dragging a table header — and until now
 * there was no way to change it except editing YAML by hand.
 *
 * Rebuilds the whole mapping rather than patching one key: YAML mappings
 * have no reorder operation, and `patchFrontmatter` merges keys, so a
 * partial write would leave the original order intact.
 */
export async function moveFieldOnType(
  typeName: string,
  fieldName: string,
  delta: number,
): Promise<boolean> {
  const { entries, patchFrontmatter } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  const doc = findTypeDoc(entries, typeName);
  if (doc === null) return false;
  if (!guardEditable(doc, typeName)) return false;

  const fields = rawFieldsOf(doc);
  const names = Object.keys(fields);
  const from = names.findIndex((k) => k.toLowerCase() === fieldName.toLowerCase());
  const to = from + delta;
  if (from === -1 || to < 0 || to >= names.length) return false;

  const reordered = [...names];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved);

  const next: Record<string, unknown> = {};
  for (const name of reordered) next[name] = fields[name];

  try {
    await patchFrontmatter(doc.path, { fields: next });
  } catch {
    toast(`Couldn't reorder "${fieldName}"`);
    return false;
  }
  return true;
}
