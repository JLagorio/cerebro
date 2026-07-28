/**
 * Type catalog (M3): the single source for "what types exist" and which of
 * them are system-owned.
 *
 * System types mirror the Salesforce standard-object model: the app depends
 * on their names and built-in fields (routing in useOpenPath, item keys,
 * the status chain), so users may not rename or delete them — nor remove
 * their built-in fields — but they MAY add custom properties and restyle
 * the icon/color. Custom types (any other `type: Type` doc) are fully
 * editable.
 */

import { humanize } from './schema';
import type { Entry, FieldDef, FieldOption, Presentation, Schema } from './types';
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
    name: 'Project',
    lockedFields: ['key', 'state'],
    fallbackIcon: 'folder-kanban',
    fallbackColor: '#14B8A6',
  },
  {
    name: 'Work item',
    lockedFields: ['status', 'priority', 'assignee', 'due', 'estimate'],
    fallbackIcon: 'check-square',
    fallbackColor: '#3D8BE8',
  },
  {
    // The meta-type: `type: Type` docs ARE the schema. Fully locked — its
    // reserved frontmatter keys are the schema format itself.
    name: 'Type',
    lockedFields: ['fields', 'statuses', 'icon', 'color'],
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
    if (e.type !== null && e.type !== '') names.add(e.type);
  }

  const counts = new Map<string, number>();
  for (const e of entries) {
    if (e.type === null || e.type === '') continue;
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
  if (def.relation !== undefined) spec.relation = def.relation;
  if (def.property !== undefined) spec.property = def.property;
  if (def.calculate !== undefined) spec.calculate = def.calculate;
  return spec;
}

/**
 * FieldDef[] → the `fields:` frontmatter mapping on a Type doc. Inverse of
 * schema.ts parseFields; the write-side used by property configuration.
 */
export function serializeFields(fields: FieldDef[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((f) => [f.name, fieldToSpec(f)]));
}

/**
 * Presentation for a type's record list: group by status only when the type
 * declares one, and show the type's own declared fields as columns.
 */
export function typePresentation(typeName: string, schema: Schema): Presentation {
  const def = schema.types.get(typeName);
  const fields = def?.fields ?? [];
  const hasStatus = fields.some((f) => f.kind === 'status');
  return {
    type: 'list',
    groupBy: hasStatus ? 'status' : null,
    orderBy: { ...DEFAULT_PRESENTATION.orderBy },
    visibleFields:
      fields.length > 0
        ? fields.map((f) => f.name).slice(0, 6)
        : [...DEFAULT_PRESENTATION.visibleFields],
  };
}
