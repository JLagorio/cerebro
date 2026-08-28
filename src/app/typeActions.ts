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
import { humanize, serializeDisplayConfig } from '@/engine/schema';
import { coerceValueToKind } from '@/engine/properties';
import { isLockedField, serializeOptions } from '@/engine/typeCatalog';
import { serializeViewList } from '@/engine/views';
import type {
  DisplayConfig,
  Entry,
  FieldKind,
  FieldOption,
  StatusDef,
  ViewDefinition,
} from '@/engine/types';
import { slugify } from '@/lib/slug';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/** Frontmatter keys with schema meaning on a Type doc — never field names. */
const RESERVED = new Set([
  'type',
  'icon',
  'color',
  'fields',
  'statuses',
  'folder',
  'views',
  'display',
  'tabs',
]);

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
    entries.find((e) => e.type === 'Type' && e.title.toLowerCase() === typeName.toLowerCase()) ??
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
  /** Extra spec keys written with the field (M12.4: a relation's `target`,
   * `limit`, or derived-reciprocal `from`). */
  config: Record<string, unknown> = {},
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
  const extras = Object.fromEntries(
    Object.entries(config).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  );
  fields[name] = kind === 'text' && Object.keys(extras).length === 0 ? 'text' : { kind, ...extras };
  try {
    if (doc === null) {
      await ensureTypeDoc({ name: typeName, docPath: null }, { fields });
    } else {
      if (!(await patchFrontmatter(doc.path, { fields }))) return false;
    }
  } catch {
    toast(`Couldn't add "${name}" to ${typeName}`);
    return false;
  }
  return true;
}

/**
 * Declare a relation property, optionally with its reciprocal (M12.4).
 *
 * The forward side owns the data: `target` constrains the picker and `limit`
 * the cardinality. When `reciprocalName` is given, the TARGET type gets a
 * derived relation back — `from: { type, field }` — which stores nothing and
 * reads the reverse index, so two files never disagree about one link.
 *
 * `person` takes the same route (M16.13b) — it is a relation that renders
 * avatars, and it needs a target for the very same reason. The reciprocal is
 * always a plain `relation`: the reverse of "assignee" is "their tasks", not
 * "their people".
 */
export async function addRelationProperty(
  typeName: string,
  rawName: string,
  config: { target: string; limit?: 1; reciprocalName?: string },
  kind: 'relation' | 'person' = 'relation',
): Promise<boolean> {
  const name = normalizeFieldName(rawName);
  const added = await addFieldToType(typeName, rawName, kind, {
    target: config.target,
    ...(config.limit === 1 ? { limit: 1 } : {}),
  });
  if (!added) return false;
  const reciprocal = config.reciprocalName?.trim() ?? '';
  if (reciprocal === '') return true;
  return addFieldToType(config.target, reciprocal, 'relation', {
    from: { type: typeName, field: name },
  });
}

/** Spec keys that only make sense for certain kinds — dropped on conversion. */
const KIND_KEYS: Record<string, string[]> = {
  select: ['options'],
  multiselect: ['options'],
  status: ['options'],
  relation: ['target', 'limit', 'from'],
  // A person field is a relation with an avatar renderer (M16.13b), so its
  // wiring survives a relation ⇄ person conversion instead of being silently
  // dropped and leaving the picker pointing at nothing.
  person: ['target', 'limit', 'from'],
  rollup: ['relation', 'property', 'calculate', 'from', 'format', 'precision'],
  number: ['format', 'precision'],
  date: ['dateFormat', 'timeFormat'],
  daterange: ['dateFormat', 'timeFormat'],
};

/**
 * Change a declared field's kind, coercing every record's stored value into
 * the new shape (M12.4b — the header menu's Change type). Values with no
 * honest reading in the new kind are cleared, never mangled; converting to a
 * select-family kind seeds the option set from the values that survive.
 */
export async function changeFieldKind(
  typeName: string,
  fieldName: string,
  kind: FieldKind,
): Promise<boolean> {
  const { entries, patchFrontmatter } = useVaultStore.getState();
  const doc = findTypeDoc(entries, typeName);
  if (doc === null) return false;
  if (!guardEditable(doc, typeName)) return false;
  const fields = rawFieldsOf(doc);
  const actual = Object.keys(fields).find((k) => k.toLowerCase() === fieldName.toLowerCase());
  if (actual === undefined) return false;

  const raw = fields[actual];
  const oldSpec: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  const oldKind =
    typeof oldSpec.kind === 'string' ? oldSpec.kind : typeof raw === 'string' ? raw : 'text';
  if (oldKind === kind) return true;

  // Coerce first, so the option seed below sees the final values.
  const records = entries.filter((e) => e.type === typeName && e.path !== doc.path);
  const conversions: { path: string; value: unknown }[] = [];
  for (const record of records) {
    const stored =
      record.relationships[actual] !== undefined
        ? record.relationships[actual]
        : record.properties[actual];
    if (stored === undefined || stored === null || stored === '') continue;
    const next = coerceValueToKind(stored, kind);
    conversions.push({ path: record.path, value: next });
  }

  /**
   * The new spec keeps only what the new kind understands.
   *
   * `KIND_KEYS` says exactly that, and only its `options` row was ever read
   * (M20.3) — every other entry in the table was dead. So a relation converted
   * to a person lost `target`, `limit` and `from` and came back pointing at
   * nothing; a rollup lost its `relation`/`property`/`calculate` wiring and
   * computed nothing; a number lost its `format` and `precision`; a date lost
   * its display formats. Each of those is silent, and none of them is
   * recoverable from the value data — the declaration is where it lived.
   *
   * Copied from the OLD spec, so a key the previous kind never had cannot
   * appear: the table is an allowlist of what the new kind can read, not a
   * promise that it holds any of it.
   */
  const keep = KIND_KEYS[kind] ?? [];
  const spec: Record<string, unknown> = { kind };
  for (const key of keep) {
    if (oldSpec[key] !== undefined) spec[key] = oldSpec[key];
  }
  if ((kind === 'select' || kind === 'multiselect') && !Array.isArray(spec.options)) {
    const distinct = [
      ...new Set(
        conversions
          .flatMap((c) => (Array.isArray(c.value) ? c.value : [c.value]))
          .filter((v): v is string => typeof v === 'string' && v !== ''),
      ),
    ];
    if (distinct.length > 0) spec.options = distinct;
  }
  fields[actual] = spec;

  // Schema first: patchFrontmatter validates records against the CURRENT
  // schema, and the optimistic update makes the new kind visible before the
  // value writes run — so a schema write that didn't land must stop the
  // conversions rather than run them against a schema that never changed.
  if (!(await patchFrontmatter(doc.path, { fields }))) return false;
  // Accepted asymmetry: the schema change is what this function's return
  // value answers for. Each conversion's own patchFrontmatter call already
  // self-toasts on failure (vaultStore's contract), so an individual record
  // keeping its old value doesn't turn a landed kind change into a `false`.
  for (const c of conversions) {
    await patchFrontmatter(c.path, { [actual]: c.value });
  }
  return true;
}

/**
 * Duplicate a declared field: same spec under a fresh name, values copied on
 * every record (M12.4b — the header menu's Duplicate property).
 */
export async function duplicateFieldOnType(
  typeName: string,
  fieldName: string,
): Promise<string | null> {
  const { entries, patchFrontmatter } = useVaultStore.getState();
  const doc = findTypeDoc(entries, typeName);
  if (doc === null) return null;
  if (!guardEditable(doc, typeName)) return null;
  const fields = rawFieldsOf(doc);
  const actual = Object.keys(fields).find((k) => k.toLowerCase() === fieldName.toLowerCase());
  if (actual === undefined) return null;

  let copy = `${actual}_copy`;
  for (let n = 2; Object.keys(fields).some((k) => k.toLowerCase() === copy); n += 1) {
    copy = `${actual}_copy_${n}`;
  }
  const rebuilt: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(fields)) {
    rebuilt[key] = spec;
    if (key === actual) {
      rebuilt[copy] = typeof spec === 'object' && spec !== null ? { ...(spec as object) } : spec;
    }
  }
  if (!(await patchFrontmatter(doc.path, { fields: rebuilt }))) return null;
  // Accepted asymmetry: the schema declaration is what this function's
  // return value answers for. Each copy's own patchFrontmatter call already
  // self-toasts on failure (vaultStore's contract), so a record that doesn't
  // get the copied value doesn't turn a landed duplicate into a `null`.
  for (const record of entries) {
    if (record.type !== typeName || record.path === doc.path) continue;
    const stored =
      record.relationships[actual] !== undefined
        ? // Relationships come back bracket-stripped; re-wrap for disk.
          record.relationships[actual].map((v) => `[[${v}]]`)
        : record.properties[actual];
    if (stored === undefined || stored === null || stored === '') continue;
    await patchFrontmatter(record.path, { [copy]: stored });
  }
  return copy;
}

/**
 * Declare a new text field positioned beside an existing one (M12.4b — the
 * header menu's Insert left/right). Returns the new field's name.
 */
export async function insertFieldOnType(
  typeName: string,
  anchor: string,
  side: 'left' | 'right',
): Promise<string | null> {
  const { entries, patchFrontmatter } = useVaultStore.getState();
  const doc = findTypeDoc(entries, typeName);
  if (doc === null) return null;
  if (!guardEditable(doc, typeName)) return null;
  const fields = rawFieldsOf(doc);
  let name = 'property';
  for (
    let n = 2;
    Object.keys(fields).some((k) => k.toLowerCase() === name) || RESERVED.has(name);
    n += 1
  ) {
    name = `property_${n}`;
  }
  const rebuilt: Record<string, unknown> = {};
  let placed = false;
  for (const [key, spec] of Object.entries(fields)) {
    if (key === anchor && side === 'left') {
      rebuilt[name] = 'text';
      placed = true;
    }
    rebuilt[key] = spec;
    if (key === anchor && side === 'right') {
      rebuilt[name] = 'text';
      placed = true;
    }
  }
  if (!placed) rebuilt[name] = 'text';
  if (!(await patchFrontmatter(doc.path, { fields: rebuilt }))) return null;
  return name;
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
  if (!(await patchFrontmatter(doc.path, { fields }))) return false;
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
  if (!(await patchFrontmatter(doc.path, { fields: renamed }))) return false;
  // Move stored values on every record of this type. patchFrontmatter never
  // throws — a record whose write fails reports it by returning false, not
  // by rejecting — so failure is counted from that boolean. A record that
  // fails keeps its old key: the schema rename already landed, so the value
  // still resolves as an undeclared property rather than vanishing.
  const records = entries.filter(
    (e) => e.type === typeName && (actual in e.properties || actual in e.relationships),
  );
  let failed = 0;
  for (const record of records) {
    const targets = record.relationships[actual];
    const value =
      targets !== undefined ? targets.map((t) => `[[${t}]]`) : record.properties[actual];
    if (!(await patchFrontmatter(record.path, { [next]: value, [actual]: null }))) failed += 1;
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
  if (!(await patchFrontmatter(doc.path, { fields }))) return false;
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
  config: Partial<
    Record<
      | 'relation'
      | 'property'
      | 'calculate'
      | 'format'
      | 'precision'
      | 'target'
      | 'limit'
      | 'from'
      // M16.14. A date's display format is a PROPERTY setting, not a per-value
      // one — the picker's format menu used to be discarded when the popover
      // closed. `dateFormat`, never `format`: numbers own that key.
      | 'dateFormat'
      | 'timeFormat'
      // M16.10. Pass null for the default ('show') so the key is deleted
      // rather than written — a Type doc should not carry the absence of an
      // opinion.
      | 'visibility',
      unknown
    >
  >,
): Promise<boolean> {
  const { entries, patchFrontmatter } = useVaultStore.getState();
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
  if (!(await patchFrontmatter(doc.path, { fields }))) return false;
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
      if (!(await patchFrontmatter(doc.path, { statuses: serialized }))) return false;
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
      if (!(await patchFrontmatter(doc.path, { views: serialized }))) return false;
    }
  } catch {
    toast(`Couldn't update ${listing.name} views`);
    return false;
  }
  return true;
}

/**
 * Persist the record panel's per-type display config onto its Type doc
 * (M44.1). Deviations only — a type left at the defaults carries no
 * `display:` key at all.
 */
export async function setTypeDisplay(
  listing: { name: string; docPath: string | null },
  display: DisplayConfig,
): Promise<boolean> {
  const { entries, patchFrontmatter } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  const doc = findTypeDoc(entries, listing.name);
  if (!guardEditable(doc, listing.name)) return false;
  const serialized = serializeDisplayConfig(display);
  try {
    if (doc === null) {
      if (serialized === null) return true; // nothing to write and nowhere to write it
      await ensureTypeDoc({ name: listing.name, docPath: null }, { display: serialized });
    } else {
      if (!(await patchFrontmatter(doc.path, { display: serialized }))) return false;
    }
  } catch {
    toast(`Couldn't update ${listing.name} display`);
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
  relation?: { target: string; limit?: 1; reciprocalName?: string },
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
    // `person` too, not just `relation` (M16.13b): the add-property panel
    // collects a target for both, and gating on 'relation' alone silently
    // DISCARDED the one the user had just picked for a person field.
    if ((kind === 'relation' || kind === 'person') && relation !== undefined) {
      return addRelationProperty(entry.type, name, relation, kind);
    }
    return addFieldToType(entry.type, name, kind);
  }
  if (kindMeta(kind).computed) {
    toast('Computed properties need a Type — assign one first');
    return false;
  }
  if (!(await patchFrontmatter(entry.path, { [name]: kindMeta(kind).seed }))) return false;
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

  if (!(await patchFrontmatter(doc.path, { fields: next }))) return false;
  return true;
}
