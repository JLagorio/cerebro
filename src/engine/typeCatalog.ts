/**
 * Type catalog (M3, rewritten M12.2): the single source for "what types
 * exist".
 *
 * M12 removed the Salesforce-style standard objects. Project and Work item
 * are ordinary types now — declare them, rename them, delete them, or never
 * have them at all; nothing in the app depends on their names. The one
 * system type left is `Type` itself: the metamodel is the single name the
 * app must know, because `type: Type` docs ARE the schema.
 */

import { isTemplate } from '@/lib/templates';
import { DEFAULT_TIME_FORMAT } from './dates';
import type { LayoutTab } from './layout';
import { isLibraryEntry, isLibraryType } from './library';
import { isConcept, isKnowledgePath } from './okf';
import { humanize } from './schema';
import type {
  Entry,
  FieldDef,
  FieldOption,
  Presentation,
  Schema,
  TabDef,
  ViewDefinition,
} from './types';
import { defaultColumnsFor, hasStatusField } from './columns';
import { DEFAULT_PRESENTATION } from './views';

export interface SystemTypeSpec {
  name: string;
  /** Built-in field names the app relies on; locked against edit/delete. */
  lockedFields: string[];
  /** Icon/color used when the vault has no Type doc for this type yet. */
  fallbackIcon: string;
  fallbackColor: string | null;
}

export const SYSTEM_TYPES: SystemTypeSpec[] = [
  {
    // The meta-type: `type: Type` docs ARE the schema. Fully locked — its
    // reserved frontmatter keys are the schema format itself.
    name: 'Type',
    lockedFields: [
      'fields',
      'statuses',
      'icon',
      'color',
      'folder',
      'views',
      'display',
      'tabs',
      'layout',
    ],
    fallbackIcon: 'shapes',
    fallbackColor: '#8B7CF6',
  },
];

export function systemTypeSpec(name: string): SystemTypeSpec | null {
  return SYSTEM_TYPES.find((t) => t.name === name) ?? null;
}

export function isSystemType(name: string): boolean {
  return systemTypeSpec(name) !== null;
}

/** True when the field is a built-in of a system type (rename/delete locked). */
export function isLockedField(typeName: string, field: string): boolean {
  const spec = systemTypeSpec(typeName);
  return spec !== null && spec.lockedFields.includes(field);
}

export interface TypeListing {
  name: string;
  icon: string;
  color: string | null;
  /** Records carrying `type: <name>` in the vault. */
  count: number;
  system: boolean;
  /** Path of the `type: Type` doc declaring it, or null (system types work
   * without one; ghost types are names only records reference). */
  docPath: string | null;
}

const FALLBACK_ICON = 'file-text';

/**
 * Every type the vault knows about: system types (always present), declared
 * types (a `type: Type` doc exists), and ghost types (records reference a
 * name nobody declared). Sorted by name.
 */
export function listTypes(entries: Entry[], schema: Schema): TypeListing[] {
  const names = new Set<string>();
  for (const spec of SYSTEM_TYPES) names.add(spec.name);
  for (const name of schema.types.keys()) names.add(name);
  for (const e of entries) {
    if (e.type !== null && e.type !== '' && !isTemplate(e) && !isConcept(e)) names.add(e.type);
  }
  // M18: Skill and Agent are the library's, not the schema's. Filtered by NAME
  // rather than only by entry so that a vault carrying a leftover
  // `types/skill.md` from an older build stops showing the row immediately —
  // the Type doc is harmless, and demanding the user delete a file to fix
  // their sidebar would be the app blaming them for its own migration.
  for (const name of names) if (isLibraryType(name)) names.delete(name);

  // Templates carry a `type:` so pages created from them inherit it — they
  // are scaffolding, never records, and must not inflate counts (M3.1: the
  // Meeting type showed "1 record" that was really templates/meeting.md).
  // Knowledge concepts (M5) carry free-form OKF types — `Metric`, `Playbook`,
  // `BigQuery Table` — which are the agent's vocabulary, not the vault's
  // schema; listing them would fill the Types sidebar with ghost types.
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (e.type === null || e.type === '' || isTemplate(e) || isConcept(e)) continue;
    counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  }

  return [...names]
    .map((name) => {
      const def = schema.types.get(name);
      const spec = systemTypeSpec(name);
      const doc = entries.find((e) => e.type === 'Type' && e.title === name);
      return {
        name,
        icon: def?.icon ?? spec?.fallbackIcon ?? FALLBACK_ICON,
        color: def?.color ?? spec?.fallbackColor ?? null,
        count: counts.get(name) ?? 0,
        system: spec !== null,
        docPath: doc?.path ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * True when this entry belongs in the Docs file tree (M12.1: docs are docs).
 *
 * The rule is absolute now: a doc is an UNTYPED note, full stop. A typed
 * entry is a record and lives on its type's screens and in Lists — never in
 * Docs. The old `display: doc` escape hatch let a type opt its records back
 * into the Docs tree, which gave "is this a doc?" three answers; M12 removes
 * it so the two worlds cannot blend.
 */
export function isDocEntry(entry: Entry): boolean {
  // The whole knowledge bundle (M5) has its own read-only surface and is
  // never yours to edit. Keyed on the PATH, not on isConcept: `index.md`
  // and `log.md` are not concepts but are still bundle files, and being
  // untyped they would otherwise sail through the next branch into Docs.
  if (isKnowledgePath(entry.path)) return false;
  return entry.type === null || entry.type === '';
}

/**
 * True when this entry is a RECORD: a typed note that lives on its type's
 * screens, in views, and in Lists (M12.1/M12.2). The complement of
 * isDocEntry over content — templates are stationery, Type docs are the
 * schema, and the knowledge bundle is its own corpus, so none of them are
 * records even though they carry a `type:`.
 */
export function isRecordEntry(entry: Entry): boolean {
  return (
    entry.type !== null &&
    entry.type !== '' &&
    entry.type !== 'Type' &&
    // M18: skills and agents are how the vault works, not what it is about.
    // They keep their file and lose the record surfaces — see engine/library.
    !isLibraryEntry(entry) &&
    !isTemplate(entry) &&
    !isKnowledgePath(entry.path)
  );
}

/**
 * A record whose type declares a status field is a commitment — a task in
 * the My-Tasks sense (M12.2: capability-based, since no type name is
 * special). Its body checklists are its own subtasks, not the vault's.
 */
export function isTaskRecord(entry: Entry, schema: Schema): boolean {
  if (!isRecordEntry(entry)) return false;
  const def = entry.type === null ? undefined : schema.types.get(entry.type);
  return def !== undefined && def.fields.some((f) => f.kind === 'status');
}

/** Icon + color for an entry's type, with the same fallbacks as listTypes —
 * the single lookup every surface uses so customizations propagate. */
export function typeStyle(
  typeName: string | null,
  schema: Schema,
): { icon: string; color: string | null } {
  if (typeName === null || typeName === '') return { icon: FALLBACK_ICON, color: null };
  const def = schema.types.get(typeName);
  const spec = systemTypeSpec(typeName);
  return {
    icon: def?.icon ?? spec?.fallbackIcon ?? FALLBACK_ICON,
    color: def?.color ?? spec?.fallbackColor ?? null,
  };
}

/** FieldOption[] → the `options:` list shape on a Type doc field spec. */
export function serializeOptions(options: FieldOption[]): unknown[] {
  return options.map(optionToSpec);
}

function optionToSpec(o: FieldOption): unknown {
  const spec: Record<string, unknown> = { id: o.id };
  if (o.label !== humanize(o.id)) spec.label = o.label;
  if (o.color !== null) spec.color = o.color;
  if (o.hollow === true) spec.hollow = true;
  // A bare id round-trips as a plain string (parseOption accepts both).
  return Object.keys(spec).length === 1 ? o.id : spec;
}

function fieldToSpec(def: FieldDef): unknown {
  const spec: Record<string, unknown> = { kind: def.kind };
  if (def.options !== undefined && def.options.length > 0) {
    spec.options = def.options.map(optionToSpec);
  }
  if (def.target !== undefined) spec.target = def.target;
  if (def.limit !== undefined) spec.limit = def.limit;
  if (def.relation !== undefined) spec.relation = def.relation;
  if (def.from !== undefined) spec.from = def.from;
  if (def.property !== undefined) spec.property = def.property;
  if (def.calculate !== undefined) spec.calculate = def.calculate;
  if (def.format !== undefined && def.format !== 'plain') spec.format = def.format;
  if (def.precision !== undefined) spec.precision = def.precision;
  // Deviations only, like parseFieldDef's defaults: absent visibility = show,
  // absent formats = 'short' / '12'. Dropping a set NON-default here loses
  // data on every round-trip (M45.1: applyTypeLayout serializes ADDED fields
  // with this) — but an explicit default normalizes to NO key, same rule as
  // `format !== 'plain'` above: a Type doc should not carry the absence of
  // an opinion.
  if (def.dateFormat !== undefined && def.dateFormat !== 'short') spec.dateFormat = def.dateFormat;
  if (def.timeFormat !== undefined && def.timeFormat !== DEFAULT_TIME_FORMAT) {
    spec.timeFormat = def.timeFormat;
  }
  if (def.visibility !== undefined && def.visibility !== 'show') spec.visibility = def.visibility;
  return spec;
}

/**
 * FieldDef[] → the `fields:` frontmatter mapping on a Type doc. Inverse of
 * schema.ts parseFields; the write-side of applyTypeLayout's ADDED path
 * (M45.1) — existing declarations are merged raw, never round-tripped
 * through here, so a hand-edited vault's unmodeled keys survive.
 */
export function serializeFields(fields: FieldDef[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((f) => [f.name, fieldToSpec(f)]));
}

/**
 * Presentation for a type's record list: a table, grouped by status only when
 * the type declares one, with the type's own fields as columns.
 *
 * M10: this defaulted to the `split` browser, which no longer exists — the
 * open-in-place detail panel gives every view the doc-beside-properties reading
 * that split was added for, so the type screen opens on the grid instead.
 *
 * M19.1: a type that declares NOTHING gets no columns, rather than borrowing
 * `DEFAULT_PRESENTATION`'s. That fallback dated from when every type was
 * work-tracking, and it made a fresh type open on a grid of Key, Status,
 * Priority, Assignee, Due and Estimate — six columns for properties that did
 * not exist, on records whose own detail panel correctly showed none of them.
 * A table must not invent a schema the vault does not have; Notion opens a new
 * database on Name and an Add-property button, and so does this.
 */
export function typePresentation(typeName: string, schema: Schema): Presentation {
  const def = schema.types.get(typeName);
  const fields = def?.fields ?? [];
  return {
    type: 'table',
    group: hasStatusField(fields) ? [{ field: 'status' }] : [],
    sort: DEFAULT_PRESENTATION.sort.map((s) => ({ ...s })),
    columns: defaultColumnsFor(fields),
  };
}

/**
 * The saved views of a type's screen (M12.3) — the same contract a List's
 * tabs have. A type that saved none renders a default table, but nothing is
 * written to its Type doc until the user makes a view their own.
 */
export function typeViews(typeName: string, schema: Schema): ViewDefinition[] {
  const saved = schema.types.get(typeName)?.views ?? [];
  if (saved.length > 0) return saved;
  return [
    {
      id: 'all',
      name: 'Table',
      icon: null,
      filters: null,
      presentation: typePresentation(typeName, schema),
    },
  ];
}

/**
 * The record page's tabs for a type (M44.5) — same contract as `typeViews`:
 * a type that saved none gets the Overview default, and nothing is written
 * to its Type doc until the user makes the tabs their own.
 */
export function typeTabs(typeName: string, schema: Schema): TabDef[] {
  const saved = schema.types.get(typeName)?.tabs ?? [];
  if (saved.length > 0) return saved;
  return [{ id: 'overview', name: 'Overview', icon: null, content: 'overview' }];
}

/**
 * Does this tab render the property stack at all (M45.6)? `sections` and
 * `view` tabs ARE their content — free text, an embedded database — and the
 * record surfaces already skip the stack on both, so a section assigned to
 * one would be invisible. The layout editor's "Move to tab…" offers exactly
 * the tabs this answers true for.
 */
export function tabBearsProperties(tab: TabDef): boolean {
  return tab.content === 'overview' || tab.content === 'properties';
}

/**
 * The `LayoutTab` seam `resolveLayout` takes (M45.6) — built HERE because
 * this module owns the tab roster and `layout.ts` deliberately does not.
 * Two facts, one place:
 *
 * - **default** = the first PROPERTY-BEARING tab. Untabbed sections — every
 *   section in every vault written before M45.6 — call it home.
 * - **canHoldSections** = the type still declares that tab id AND that tab
 *   still bears properties. Both conditions fold in here, on the roster
 *   side, so `resolveLayout` gets one decision about one id. Deleting a tab
 *   and re-kinding it to `sections`/`view` strand a section identically —
 *   the surfaces render no property stack on either — so they must fall back
 *   identically. Liveness alone would miss the re-kind, which no
 *   group-editor refusal can cover: the content kind changes AFTER the
 *   assignment.
 *
 * Both failure modes fail VISIBLE: a roster with no property-bearing tab
 * falls back to the first tab, and an `activeId` no tab wears (a stale
 * selection the caller did not resolve) counts as the default. Untabbed
 * sections always have exactly one home, because a section with none is a
 * section the user cannot recover.
 */
export function layoutTabScope(tabs: TabDef[], activeId: string): LayoutTab {
  const fallback = tabs.find(tabBearsProperties) ?? tabs[0];
  return {
    id: activeId,
    isDefault:
      fallback === undefined || !tabs.some((t) => t.id === activeId)
        ? true
        : activeId === fallback.id,
    canHoldSections: (tabId) => tabs.some((t) => t.id === tabId && tabBearsProperties(t)),
  };
}
