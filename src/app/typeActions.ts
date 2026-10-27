import { saveBeforeAction } from '@/app/leaveGuard';
import { followTypeRename } from './pointers';
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

import {
  dryRunKindChange,
  stripMisfitTests,
  type KindChangeCtx,
  type KindChangePreview,
} from '@/engine/castRules';
import type { BatchOp } from '@/engine/batch';
import { homeFolderFor } from '@/engine/createRecord';
import { checkFormula } from '@/engine/formula';
import {
  deleteBlockedWords,
  deleteBlockers,
  formulaUses,
  groupingUses,
  planDatabaseRename,
  planFieldRename,
  renameFlagWords,
  renameRefusalWords,
} from '@/engine/fieldRefs';
import { isKnowledgePath } from '@/engine/okf';
import { kindMeta } from '@/engine/properties';
import { humanize, serializeDisplayConfig, serializeLayoutConfig } from '@/engine/schema';
import {
  isLockedField,
  isReservedTypeName,
  isSystemType,
  listTypes,
  serializeFields,
  serializeOptions,
  type TypeListing,
} from '@/engine/typeCatalog';
import {
  addedFromLabel,
  copiedLabel,
  deletedPropertyLabel,
  kindChangedLabel,
  renamedLabel,
} from '@/engine/undoPlan';
import { parseListYaml, serializeTabList, serializeViewList } from '@/engine/views';
import type {
  DisplayConfig,
  Entry,
  FieldDef,
  FieldKind,
  FieldOption,
  FieldVisibility,
  LayoutConfig,
  ListFile,
  StatusDef,
  TabDef,
  ViewDefinition,
} from '@/engine/types';
import { slugify } from '@/lib/slug';
import { listViews, readNoteSource, scanVault } from '@/lib/ipc';
import { heldOpenPages } from '@/editor/openPages';
import { useUiStore } from '@/stores/uiStore';
import { getSchema, refusedAcrossVaults, useVaultStore } from '@/stores/vaultStore';

/** Frontmatter keys with schema meaning on a Type doc, and the page chrome
 * keys every page may carry (`icon`, `cover`: M55.11, engine/pageChrome) —
 * never field names, since a page draws them above its title, not as rows.
 * Exported for the layout editor's staging guard (M45.3), which must refuse
 * with `applyTypeLayout`'s reasons BEFORE staging — inline, form-style —
 * instead of letting Apply toast the same refusal later. */
export const RESERVED = new Set([
  'type',
  'icon',
  'cover',
  'color',
  'email_domain',
  'fields',
  'statuses',
  'folder',
  'views',
  'display',
  'tabs',
  'layout',
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

/** Rename a database and its schema references as one human batch (M60.11). */
export async function renameDatabase(listing: TypeListing, rawNext: string): Promise<boolean> {
  const next = rawNext.trim();
  const state = useVaultStore.getState();
  const vault = state.vaultPath;
  const { toast } = useUiStore.getState();
  if (vault === null || refusedAcrossVaults(state)) return false;
  if (next === '' || next === listing.name) return false;
  if (isReservedTypeName(next) || isSystemType(listing.name) || listing.system) {
    toast('System and library database names cannot be renamed.');
    return false;
  }
  if (/[*`\r\n]|\[\[|\]\]/.test(next)) {
    toast('Choose a database name without markdown formatting or line breaks.');
    return false;
  }
  const conflicts = (entries = useVaultStore.getState().entries) =>
    listTypes(entries, getSchema(entries)).some(
      (type) =>
        type.name.toLowerCase() === next.toLowerCase() &&
        type.name.toLowerCase() !== listing.name.toLowerCase(),
    );
  if (conflicts()) {
    toast(`A database named “${next}” already exists.`);
    return false;
  }
  const sameVault = () => useVaultStore.getState().vaultPath === vault;
  try {
    await ensureTypeDoc({ name: listing.name, docPath: listing.docPath ?? null });
    if (!sameVault()) return false;
    if (!(await saveBeforeAction('all', 'caller'))) return false;
    if (!sameVault()) return false;
    if (heldOpenPages().length > 0) {
      toast('Some pages have changes waiting on you. Settle them before renaming the database.');
      return false;
    }
    // A store rescan deliberately keeps its old snapshot on failure. Planning
    // a schema rename needs a successful read of every current reference.
    const [entries, rawLists] = await Promise.all([scanVault(vault), listViews(vault)]);
    if (!sameVault()) return false;
    if (conflicts(entries)) {
      toast(`A database named “${next}” already exists.`);
      return false;
    }
    const lists = rawLists.map((list) =>
      parseListYaml(list.id, list.yaml, {
        project: list.project,
        collection: list.collection,
        path: list.path,
      }),
    );
    const reads = new Map<string, Awaited<ReturnType<typeof readNoteSource>>>();
    const pages = entries.filter((entry) => entry.path.endsWith('.md'));
    for (let offset = 0; offset < pages.length; offset += 8) {
      await Promise.all(
        pages.slice(offset, offset + 8).map(async (entry) => {
          try {
            reads.set(entry.path, await readNoteSource(vault, entry.path));
          } catch {
            // The planner names each unavailable page; it cannot invent bytes.
          }
        }),
      );
      if (!sameVault()) return false;
    }
    const planned = planDatabaseRename(
      { from: listing.name, to: next },
      {
        entries,
        schema: getSchema(entries),
        lists,
        reads,
      },
    );
    if (!planned.ok) {
      toast(
        planned.refusal.code === 'sourceInvalid'
          ? `The database page for “${listing.name}” has invalid metadata, so nothing was renamed.`
          : `The database page for “${listing.name}” could not be read unchanged. Try again.`,
      );
      return false;
    }
    const { records, schemaReferences, pointers } = planned.counts;
    const label = `Renamed “${listing.name}” to “${next}”: ${records} records, ${schemaReferences} schema references, ${pointers} page blocks`;
    if (heldOpenPages().length > 0) {
      toast('Some pages have changes waiting on you. Settle them before renaming the database.');
      return false;
    }
    const applied = await useVaultStore.getState().applyBatch(planned.ops, { undo: label });
    if (applied === null) return false;
    followTypeRename(vault, listing.name, next);
    if (planned.flagged.length > 0) {
      toast(
        `Not changed: ${planned.flagged.map((flag) => flag.path).join(', ')}. Check their references to ${listing.name}.`,
      );
    }
    return true;
  } catch (error) {
    if (sameVault())
      toast(
        `Couldn't rename “${listing.name}”: ${error instanceof Error ? error.message : String(error)}`,
      );
    return false;
  }
}

function rawFieldsOf(doc: Entry): Record<string, unknown> {
  const raw = (doc.properties as Record<string, unknown>).fields;
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : {};
}

/** Refuse `fields:` edits when the doc can't be trusted: a parse error means
 * our in-memory copy may be empty and a write would clobber the mapping. */
export function guardEditable(doc: Entry | null, typeName: string): boolean {
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
  rollup: ['source', 'relation', 'property', 'calculate', 'from', 'format', 'precision'],
  formula: ['formula', 'format', 'precision'],
  number: ['format', 'precision'],
  date: ['dateFormat', 'timeFormat', 'remind'],
  daterange: ['dateFormat', 'timeFormat', 'remind'],
};

/** A field's declared kind, read from its raw spec (`field: text` or
 * `{kind: …}`), as `rawFieldsOf` hands it back. */
function rawKindOf(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const kind = (raw as Record<string, unknown>).kind;
    if (typeof kind === 'string') return kind;
  }
  return 'text';
}

/**
 * What Change type's dry run reads for one field (M60.5): the type's records,
 * its views, the List files over it and the keys a property may never take.
 * Null when the type has no Type doc or does not declare the field.
 */
export function kindChangeContext(
  entries: Entry[],
  lists: ListFile[],
  typeName: string,
  fieldName: string,
): KindChangeCtx | null {
  const doc = findTypeDoc(entries, typeName);
  if (doc === null) return null;
  const fields = rawFieldsOf(doc);
  const field = Object.keys(fields).find((k) => k.toLowerCase() === fieldName.toLowerCase());
  if (field === undefined) return null;
  const schema = getSchema(entries);
  const typeDef = schema.types.get(typeName) ?? schema.types.get(doc.title);
  const declared = typeDef?.fields.find((f) => f.name === field);
  const def: FieldDef = declared ?? { name: field, kind: rawKindOf(fields[field]) as FieldKind };
  return { typeName, field, def, entries, schema, lists, reserved: RESERVED };
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * A patch op on `entry` for a database-wide change (M60.6), carrying the
 * hash of the bytes its values were read from when the scan knows it, so a
 * page edited since refuses the whole change (D2 (c)).
 */
function patchOp(entry: Entry, set: Record<string, unknown>): BatchOp {
  return entry.hash === null
    ? { op: 'patch', path: entry.path, set }
    : { op: 'patch', path: entry.path, set, expectHash: entry.hash };
}

/** The ops' records by path, for a patch op on each. */
const byPath = (entries: Entry[]) => new Map(entries.map((e) => [e.path, e]));

/** How many pages a change's ops touch: the count its undo label names. */
const pagesIn = (ops: BatchOp[]) =>
  new Set(ops.map((op) => (op.op === 'rename' ? op.to : op.path))).size;

/**
 * Change a declared field's kind in place (M60.5), only when every value
 * converts. The dry run runs again against the vault as it is now, so values
 * edited since the preview are checked too: a refusal, or any value that no
 * longer converts, writes nothing and toasts why.
 *
 * One batch (M60.6), the Type doc first: its new spec (the keys the new kind
 * understands, plus seeded options) and, when its views held filter rules
 * the new kind cannot express, those views with the rules stripped; then
 * each record whose value changes. All of it lands, or none of it does.
 */
export async function changeFieldKind(
  typeName: string,
  fieldName: string,
  kind: FieldKind,
): Promise<boolean> {
  const { entries, views: lists, applyBatch } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
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
  if (rawKindOf(raw) === kind) return true;

  const ctx = kindChangeContext(entries, lists, typeName, actual);
  if (ctx === null) return false;
  const preview = dryRunKindChange(ctx, kind);
  const kindLabel = kindMeta(kind).label;
  if (preview.cast === 'never') {
    toast(preview.reason ?? `Can't change "${humanize(actual)}" to ${kindLabel}`);
    return false;
  }
  if (preview.failures > 0) {
    const n = preview.failures;
    toast(
      `${n} ${plural(n, 'value no longer converts', 'values no longer convert')} to ${kindLabel}; nothing was changed`,
    );
    return false;
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
  if (preview.options !== null && !Array.isArray(spec.options)) spec.options = preview.options;
  fields[actual] = spec;

  const patch: Record<string, unknown> = { fields };
  if (
    ctx.schema.types.get(typeName)?.deadline === actual &&
    kind !== 'date' &&
    kind !== 'daterange'
  )
    patch.deadline = null;
  if (ctx.schema.types.get(typeName)?.emailDomain === actual && kind !== 'text' && kind !== 'url')
    patch.email_domain = null;
  if (preview.stripped > 0) {
    const typeViews = ctx.schema.types.get(typeName)?.views ?? [];
    patch.views = serializeViewList(stripMisfitTests(typeViews, actual, kind).views);
  }
  const records = byPath(entries);
  const ops: BatchOp[] = [patchOp(doc, patch)];
  for (const w of preview.writes) {
    const record = records.get(w.path);
    if (record !== undefined) ops.push(patchOp(record, { [actual]: w.value }));
  }
  const label = kindChangedLabel(humanize(actual), kindLabel, pagesIn(ops));
  return (await applyBatch(ops, { undo: label })) !== null;
}

/**
 * Convert a field into a NEW property of another kind (M60.5): the way out
 * when some values would not survive an in-place change. The new key
 * (`newPropertyName`, `<field>_<kind>`) is declared right after the old one
 * on the Type doc and written only on the records whose value converts, in
 * one batch (M60.6). The old property, its values and the views are never
 * touched. Returns the new key, or null when nothing was written (failures
 * toast).
 */
export async function convertFieldToNewProperty(
  typeName: string,
  fieldName: string,
  kind: FieldKind,
): Promise<string | null> {
  const { entries, views: lists, applyBatch } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  const doc = findTypeDoc(entries, typeName);
  if (doc === null) return null;
  if (!guardEditable(doc, typeName)) return null;
  const ctx = kindChangeContext(entries, lists, typeName, fieldName);
  if (ctx === null) return null;
  const preview: KindChangePreview = dryRunKindChange(ctx, kind);
  if (preview.converts === 0) {
    toast(
      preview.reason ??
        `None of ${humanize(ctx.field)}'s values can be read as ${kindMeta(kind).label}`,
    );
    return null;
  }
  const fields = rawFieldsOf(doc);
  const spec: Record<string, unknown> = { kind };
  if (preview.options !== null) spec.options = preview.options;
  const rebuilt: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    rebuilt[key] = value;
    if (key === ctx.field) rebuilt[preview.newName] = spec;
  }
  const records = byPath(entries);
  const ops: BatchOp[] = [patchOp(doc, { fields: rebuilt })];
  for (const w of preview.writes) {
    const record = records.get(w.path);
    if (record !== undefined) ops.push(patchOp(record, { [preview.newName]: w.value }));
  }
  const label = addedFromLabel(humanize(preview.newName), humanize(ctx.field), pagesIn(ops));
  return (await applyBatch(ops, { undo: label })) === null ? null : preview.newName;
}

/**
 * Duplicate a declared field: same spec under a fresh name, values copied on
 * every record (M12.4b — the header menu's Duplicate property), the Type doc
 * and the records in one batch (M60.6).
 */
export async function duplicateFieldOnType(
  typeName: string,
  fieldName: string,
): Promise<string | null> {
  const { entries, applyBatch } = useVaultStore.getState();
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
  const ops: BatchOp[] = [patchOp(doc, { fields: rebuilt })];
  for (const record of entries) {
    if (record.type !== typeName || record.path === doc.path) continue;
    const stored =
      record.relationships[actual] !== undefined
        ? // Relationships come back bracket-stripped; re-wrap for disk.
          record.relationships[actual].map((v) => `[[${v}]]`)
        : record.properties[actual];
    if (stored === undefined || stored === null || stored === '') continue;
    ops.push(patchOp(record, { [copy]: stored }));
  }
  const label = copiedLabel(humanize(actual), pagesIn(ops));
  return (await applyBatch(ops, { undo: label })) === null ? null : copy;
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

/**
 * Remove a custom field from a type. System-locked fields refuse, and so
 * does a field a board or chart still groups by (M60.2): the view would draw
 * one band of everything, so the toast names the view to regroup first.
 * One labelled batch (M60.7), so the removal is undoable; a Type doc under
 * knowledge/ keeps patchFrontmatter and is never undoable.
 */
export async function removeFieldFromType(typeName: string, fieldName: string): Promise<boolean> {
  const { entries, views: lists, patchFrontmatter, applyBatch } = useVaultStore.getState();
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
  const blockers = deleteBlockers(
    groupingUses(entries, lists, typeName, actual, getSchema(entries)),
  );
  const formulas = formulaUses(entries, typeName, actual);
  if (formulas.length > 0) {
    const more = formulas.length - 1;
    toast(
      `Can't delete “${humanize(actual)}”: the formula “${humanize(formulas[0].field)}”${more > 0 ? ` and ${more} more read it. Change those formulas first.` : ' reads it. Change that formula first.'}`,
    );
    return false;
  }
  if (blockers.length > 0) {
    toast(deleteBlockedWords(humanize(actual), blockers));
    return false;
  }
  delete fields[actual];
  const patch: Record<string, unknown> = { fields };
  if (getSchema(entries).types.get(typeName)?.deadline === actual) patch.deadline = null;
  if (getSchema(entries).types.get(typeName)?.emailDomain === actual) patch.email_domain = null;
  if (isKnowledgePath(doc.path)) return patchFrontmatter(doc.path, patch);
  const label = deletedPropertyLabel(humanize(actual));
  return (await applyBatch([patchOp(doc, patch)], { undo: label })) !== null;
}

/** A database may declare one stored date field as its work deadline. */
export async function setTypeDeadline(
  typeName: string,
  fieldName: string | null,
): Promise<boolean> {
  const { entries, patchFrontmatter } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  try {
    const doc = findTypeDoc(entries, typeName);
    if (doc === null || !guardEditable(doc, typeName)) return false;
    const name = fieldName?.trim() ?? null;
    if (name !== null) {
      const def = getSchema(entries)
        .types.get(typeName)
        ?.fields.find((field) => field.name === name);
      if (def === undefined || (def.kind !== 'date' && def.kind !== 'daterange')) {
        toast('Choose a stored date or date range for the deadline.');
        return false;
      }
    }
    return await patchFrontmatter(doc.path, { deadline: name });
  } catch {
    toast(`Couldn't change the deadline for “${typeName}”.`);
    return false;
  }
}

/**
 * Rename a declared field and every stored reference to it (M60.2), as ONE
 * labelled batch (M60.6, M60.7): the key in place on the Type doc, the
 * type's layout, every saved view and rollup that names it on any Type doc,
 * and the value on every record and template of the type (M3.1: renaming
 * the schema without moving the data would orphan every stored value).
 * `planFieldRename` builds the ops: all of them land, or none do.
 *
 * A record that already holds the new key refuses the whole rename. What
 * the plan leaves alone (List files, agent triggers, knowledge/ pages, …)
 * is named in one toast after the batch lands.
 */
export async function renameFieldOnType(
  typeName: string,
  fieldName: string,
  rawNext: string,
): Promise<boolean> {
  const { entries, views: lists, applyBatch } = useVaultStore.getState();
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
  const plan = planFieldRename(
    { type: typeName, from: actual, to: next },
    { entries, schema: getSchema(entries), lists },
  );
  if (!plan.ok) {
    toast(renameRefusalWords(plan.refusal.holders, next));
    return false;
  }
  const label = renamedLabel(humanize(actual), humanize(next), pagesIn(plan.ops));
  if ((await applyBatch(plan.ops, { undo: label })) === null) return false;
  const flags = renameFlagWords(plan.flagged, actual);
  if (flags !== null) toast(flags);
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
      | 'formula'
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
      | 'remind'
      // M16.10. Pass null for the default ('show') so the key is deleted
      // rather than written — a Type doc should not carry the absence of an
      // opinion.
      | 'visibility',
      unknown
    >
  >,
): Promise<boolean> {
  try {
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
    if (config.formula !== undefined && config.formula !== null) {
      const checked =
        typeof config.formula === 'string' && rawKindOf(raw) === 'formula'
          ? checkFormula(config.formula, getSchema(entries).types.get(typeName)?.fields ?? [], {
              typeName,
              ownName: actual,
            })
          : {
              ok: false as const,
              error: "Write a formula over this database's number and date properties.",
            };
      if (!checked.ok) {
        useUiStore.getState().toast(checked.error);
        return false;
      }
      config = { ...config, formula: checked.canonical };
    }
    for (const [key, value] of Object.entries(config)) {
      if (value === null || value === undefined || value === '') delete spec[key];
      else spec[key] = value;
    }
    fields[actual] = spec;
    if (!(await patchFrontmatter(doc.path, { fields }))) return false;
    return true;
  } catch {
    useUiStore.getState().toast(`Couldn't save ${humanize(fieldName)} settings.`);
    return false;
  }
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
 * Persist a type's record-page tabs onto its Type doc (M44.5). The whole
 * array is written each time, same contract as `setTypeViews`; an empty
 * list deletes the key so the synthesized Overview default returns.
 */
export async function setTypeTabs(
  listing: { name: string; docPath: string | null },
  tabs: TabDef[],
): Promise<boolean> {
  const { entries, patchFrontmatter } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  const doc = findTypeDoc(entries, listing.name);
  if (!guardEditable(doc, listing.name)) return false;
  const serialized = tabs.length === 0 ? null : serializeTabList(tabs);
  try {
    if (doc === null) {
      if (serialized === null) return true;
      await ensureTypeDoc({ name: listing.name, docPath: null }, { tabs: serialized });
    } else if (!(await patchFrontmatter(doc.path, { tabs: serialized }))) {
      // patchFrontmatter toasts and reverts itself — read its answer, add nothing.
      return false;
    }
  } catch {
    toast(`Couldn't update ${listing.name} tabs`);
    return false;
  }
  return true;
}

/** One staged edit of a type's whole record-page presentation (M45.1) — the
 * layout editor's Apply. `display`/`layout`/`tabs` are written whole;
 * `visibility` and `added` are DELTAS merged onto the raw `fields:` mapping,
 * so declaration order and keys we don't model survive untouched. */
export interface TypeLayoutDraft {
  display: DisplayConfig;
  layout: LayoutConfig;
  tabs: TabDef[];
  /** Staged per-field visibility; null clears back to show (key deleted). */
  visibility: Record<string, FieldVisibility | null>;
  /** Staged new fields, appended in order.
   *
   * `config` here is FieldDef-SHAPED extras: it is spread into a FieldDef and
   * serialized through `serializeFields`/`fieldToSpec`, which emits only the
   * keys it models (unmodeled keys are DROPPED) and expects `options` to be
   * FieldOption[] (`{id, label, color, hollow}`), not raw spec values. That
   * is the OPPOSITE contract from `addFieldToType`'s `config`, which writes
   * raw spec keys into the mapping verbatim — two contracts, one name, so
   * M45.3's AddPropertyPanel wiring must build FieldDef shapes for this door. */
  added: { name: string; kind: FieldKind; config?: Record<string, unknown> }[];
}

/**
 * Persist a layout editor draft onto the Type doc in ONE write (M45.1). A
 * partially applied layout is worse than none, so apply is atomic: every
 * refusal happens BEFORE anything — the Type doc included — is written, and
 * a landed patch carries the whole draft: `display`, `layout`, `tabs`
 * (deviations only; null at defaults, because reset IS the write) plus,
 * only when the draft stages field deltas, the merged `fields:` mapping.
 */
export async function applyTypeLayout(
  listing: { name: string; docPath: string | null },
  draft: TypeLayoutDraft,
): Promise<boolean> {
  const { entries, patchFrontmatter } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  const doc = findTypeDoc(entries, listing.name);
  if (!guardEditable(doc, listing.name)) return false;

  const fields = doc !== null ? rawFieldsOf(doc) : {};

  // Vet every added name first — atomic means no partial, so a refusal must
  // land before any write. Same guards as addFieldToType, plus staged-vs-
  // staged collisions the one-at-a-time door never sees.
  const staged: [string, unknown][] = [];
  for (const add of draft.added) {
    const name = normalizeFieldName(add.name);
    if (name === '') {
      toast('A property needs a name');
      return false;
    }
    if (RESERVED.has(name)) {
      toast(`"${name}" is a reserved key and can't be a property`);
      return false;
    }
    if (
      Object.keys(fields).some((k) => k.toLowerCase() === name) ||
      staged.some(([k]) => k === name)
    ) {
      toast('Property already exists');
      return false;
    }
    const def = { ...add.config, name, kind: add.kind } as FieldDef;
    staged.push([name, serializeFields([def])[name]]);
  }

  // The staged additions merge in BEFORE the visibility walk (M45.3): the
  // walk only sees fields the mapping declares, so merging after it silently
  // dropped a staged eye on a staged-added field — the canvas previewed it
  // folded while the vault wrote it visible. Appends land last, so the
  // declaration-order pin below survives the reorder.
  let touched = false;
  for (const [name, spec] of staged) {
    fields[name] = spec;
    touched = true;
  }

  // Merge visibility deltas onto the RAW mapping (the setFieldConfig idiom):
  // never rebuilt from FieldDef, so a hand-edited vault's unmodeled keys
  // survive byte-for-byte. A delta for a field neither the doc nor the draft
  // declares is dropped — placing a visibility must never DECLARE a field.
  for (const [rawName, vis] of Object.entries(draft.visibility)) {
    const actual = Object.keys(fields).find((k) => k.toLowerCase() === rawName.toLowerCase());
    if (actual === undefined) continue;
    const raw = fields[actual];
    const isMapping = typeof raw === 'object' && raw !== null && !Array.isArray(raw);
    if (vis === null) {
      // Clearing back to show deletes the key — a Type doc should not carry
      // the absence of an opinion. A shorthand has no key to delete.
      if (!isMapping || (raw as Record<string, unknown>).visibility === undefined) continue;
      const spec = { ...(raw as Record<string, unknown>) };
      delete spec.visibility;
      fields[actual] = spec;
    } else {
      // A bare `field: text` shorthand has to grow into a mapping to hold it.
      const spec: Record<string, unknown> = isMapping
        ? { ...(raw as Record<string, unknown>) }
        : { kind: typeof raw === 'string' ? raw : 'text' };
      spec.visibility = vis;
      fields[actual] = spec;
    }
    touched = true;
  }

  const display = serializeDisplayConfig(draft.display);
  const layout = serializeLayoutConfig(draft.layout);
  const tabs = draft.tabs.length === 0 ? null : serializeTabList(draft.tabs);
  const allDefault = display === null && layout === null && tabs === null && !touched;

  try {
    if (doc === null) {
      if (allDefault) return true; // nothing to write and nowhere to write it
      await ensureTypeDoc(
        { name: listing.name, docPath: null },
        {
          ...(touched ? { fields } : {}),
          ...(display !== null ? { display } : {}),
          ...(layout !== null ? { layout } : {}),
          ...(tabs !== null ? { tabs } : {}),
        },
      );
      return true;
    }
    // An all-defaults draft against a doc that never carried the keys would
    // patch three deletions of nothing — a whole-file disk round-trip that
    // changes no byte — so the cheaper honest behavior is to skip the write.
    // The moment any of the three IS on disk, reset is a real write.
    const props = doc.properties as Record<string, unknown>;
    const carries = ['display', 'layout', 'tabs'].some((k) => props[k] !== undefined);
    if (allDefault && !carries) return true;
    const patch: Record<string, unknown> = { display, layout, tabs };
    if (touched) patch.fields = fields;
    if (!(await patchFrontmatter(doc.path, patch))) {
      // patchFrontmatter toasts and reverts itself — read its answer, add nothing.
      return false;
    }
  } catch {
    toast(`Couldn't update ${listing.name} layout`);
    return false;
  }
  return true;
}

/**
 * Shared "Add property" behavior: a TYPED doc extends its type's schema
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

/**
 * The status vocabulary a database is born with (M47.4).
 *
 * Three states, not the Work item's six: a brand-new database should be
 * immediately usable and immediately editable, and six rows of someone else's
 * process is more to delete than to keep. The ids and colours are the vault's
 * own — the same `todo` / `progress` / `done` spelling and the same swatches
 * `types/work-item.md` uses — so a database created here and one written by
 * hand agree, rather than growing a second vocabulary for one idea.
 */
const STARTER_STATUSES = [
  { id: 'todo', group: 'active', color: '#7E8699' },
  { id: 'progress', group: 'active', color: '#DE8F0A' },
  { id: 'done', group: 'done', color: '#1F9D61' },
];

/**
 * Create a database from wherever you are (M47.4) — Door 2 of the M47 spec.
 *
 * The first writer of `folder:`. It has been RESERVED since M12.2 and parsed
 * into `TypeDef.folder` ever since, but no action has ever set it: it was
 * hand-edit-only, which is exactly why "where do my new records go" had no
 * answer you could give from inside the app. A database created here declares
 * its own home, so `createTarget` puts its rows there and logging a thing
 * stops being a question about folders.
 *
 * Returns the name on success and null on failure — a human-UI action, so it
 * toasts rather than throwing (the store-layer error invariant). Its caller
 * decides whether to open the new database or stay on the current page.
 */
export async function createDatabase(rawName: string): Promise<string | null> {
  const name = rawName.trim();
  const toast = useUiStore.getState().toast;
  if (name === '') return null;

  const { entries, createItem } = useVaultStore.getState();
  if (findTypeDoc(entries, name) !== null) {
    toast(`A database named "${name}" already exists`);
    return null;
  }
  // The names the app itself means something by (`isReservedTypeName`) — the
  // same rule the sidebar's New database dialog asks.
  if (isReservedTypeName(name)) {
    toast(`"${name}" is a name Cerebro reserves — choose another`);
    return null;
  }

  try {
    await createItem({
      folder: 'types',
      slug: slugify(name) || 'database',
      frontmatter: {
        type: 'Type',
        icon: 'table-2',
        // `records/<plural>` is what `recordsFolder` would have picked anyway
        // (M3.3's convention), unless another database already lives there
        // (`homeFolderFor`). Writing it DOWN rather than leaving it implied
        // is the difference between a home you can see in the file and one
        // only the code knows — and it is the line a user edits when they want
        // their reading list to live in `reading/` instead.
        folder: homeFolderFor(name, getSchema(entries), entries),
        statuses: STARTER_STATUSES,
        fields: { status: { kind: 'status' } },
      },
      body: `# ${name}\n`,
    });
  } catch {
    toast(`Couldn't create the database "${name}"`);
    return null;
  }
  return name;
}
