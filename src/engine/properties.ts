/**
 * Properties engine (M2.x): the write-side of the YAML schema. Type notes
 * declare fields (`fields:` frontmatter on `type: Type` docs); this module
 * is the single source for
 *
 *   - the property-kind catalog the UI offers (Notion's set),
 *   - shape validation enforced before any frontmatter write,
 *   - computed kinds (created/last-edited time, rollups).
 *
 * Enforcement philosophy: SHAPE is strict (a number field never stores
 * "abc"), option membership stays advisory — unknown select values render
 * as ghosts rather than being rejected (locked M1 decision).
 */

import type { Entry, FieldDef, FieldKind, RollupCalc, Schema } from './types';
import { resolveTarget } from './wikilink';

export interface PropertyKindMeta {
  kind: FieldKind;
  label: string;
  icon: string;
  /** Computed kinds render read-only and reject writes. */
  computed: boolean;
  /** Initial frontmatter value seeded when the property is added untyped. */
  seed: unknown;
}

export const PROPERTY_KINDS: PropertyKindMeta[] = [
  { kind: 'text',             label: 'Text',             icon: 'type',           computed: false, seed: '' },
  { kind: 'number',           label: 'Number',           icon: 'hash',           computed: false, seed: '' },
  { kind: 'select',           label: 'Select',           icon: 'circle-chevron-down', computed: false, seed: '' },
  { kind: 'multiselect',      label: 'Multi-select',     icon: 'list-checks',    computed: false, seed: '' },
  { kind: 'status',           label: 'Status',           icon: 'loader',         computed: false, seed: '' },
  { kind: 'date',             label: 'Date',             icon: 'calendar',       computed: false, seed: '' },
  { kind: 'daterange',        label: 'Date range',       icon: 'calendar-range', computed: false, seed: '' },
  { kind: 'person',           label: 'Person',           icon: 'circle-user',    computed: false, seed: '' },
  { kind: 'files',            label: 'Files & media',    icon: 'paperclip',      computed: false, seed: '' },
  { kind: 'checkbox',         label: 'Checkbox',         icon: 'square-check',   computed: false, seed: false },
  { kind: 'url',              label: 'URL',              icon: 'link',           computed: false, seed: '' },
  { kind: 'relation',         label: 'Relation',         icon: 'arrow-up-right', computed: false, seed: '' },
  { kind: 'rollup',           label: 'Rollup',           icon: 'sigma',          computed: true,  seed: null },
  { kind: 'created_time',     label: 'Created time',     icon: 'clock',          computed: true,  seed: null },
  { kind: 'last_edited_time', label: 'Last edited time', icon: 'history',        computed: true,  seed: null },
];

export const kindMeta = (kind: FieldKind): PropertyKindMeta =>
  PROPERTY_KINDS.find((k) => k.kind === kind) ?? PROPERTY_KINDS[0];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const URL_SHAPE = /^(https?:\/\/|mailto:|www\.)/i;

const isScalarString = (v: unknown): v is string => typeof v === 'string';
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Shape-validate one value against its declared kind. `null` (delete) is
 * always allowed. Returns an error message, or null when valid.
 */
export function validateValue(def: FieldDef, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const label = def.name;
  switch (def.kind) {
    case 'text':
      return isScalarString(value) || typeof value === 'number'
        ? null
        : `${label} must be text`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : `${label} must be a number`;
    case 'checkbox':
      return typeof value === 'boolean' ? null : `${label} must be on or off`;
    case 'date':
      return isScalarString(value) && ISO_DATE.test(value)
        ? null
        : `${label} must be a date (YYYY-MM-DD)`;
    case 'daterange': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return `${label} must be a start/end range`;
      }
      const r = value as { start?: unknown; end?: unknown };
      for (const part of [r.start, r.end]) {
        if (part !== null && part !== undefined && !(isScalarString(part) && ISO_DATE.test(part))) {
          return `${label} dates must be YYYY-MM-DD`;
        }
      }
      return null;
    }
    case 'select':
    case 'status':
      return isScalarString(value) ? null : `${label} must be a single option`;
    case 'multiselect':
      return isScalarString(value) || isStringArray(value)
        ? null
        : `${label} must be a list of options`;
    case 'person':
    case 'relation':
      return isScalarString(value) || isStringArray(value)
        ? null
        : `${label} must reference other pages`;
    case 'url':
      return isScalarString(value) && (value === '' || URL_SHAPE.test(value))
        ? null
        : `${label} must be a URL (https://…)`;
    case 'files':
      return isScalarString(value) || isStringArray(value)
        ? null
        : `${label} must be a list of files`;
    case 'rollup':
    case 'created_time':
    case 'last_edited_time':
      return `${label} is computed and can't be edited`;
  }
}

/**
 * Validate a frontmatter patch against the entry's declared schema.
 * Undeclared keys pass (advisory schema); declared keys must match shape.
 */
export function validatePatch(
  schema: Schema,
  entry: Entry,
  patch: Record<string, unknown>,
): string[] {
  const typeDef = entry.type !== null ? schema.types.get(entry.type) : undefined;
  if (typeDef === undefined) return [];
  const errors: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const def = typeDef.fields.find((f) => f.name === key);
    if (def === undefined) continue;
    const error = validateValue(def, value);
    if (error !== null) errors.push(error);
  }
  return errors;
}

// --- Rollups ---------------------------------------------------------------

const asNumbers = (values: unknown[]): number[] =>
  values
    .map((v) => (typeof v === 'number' ? v : Number(v)))
    .filter((n) => Number.isFinite(n));

/**
 * Aggregate `def.property` across the entries referenced by this entry's
 * `def.relation` field. Returns a display string ('' when unresolvable).
 */
export function computeRollup(entry: Entry, def: FieldDef, entries: Entry[]): string {
  const relation = def.relation ?? '';
  const targets = (entry.relationships[relation] ?? [])
    .map((t) => resolveTarget(t, entries))
    .filter((e): e is Entry => e !== null);
  const calc: RollupCalc = def.calculate ?? 'count';
  if (calc === 'count') return String(targets.length);
  const prop = def.property ?? '';
  const values = targets
    .map((t) => t.properties[prop])
    .filter((v) => v !== undefined && v !== null && v !== '');
  if (values.length === 0) return '';
  switch (calc) {
    case 'show':
      return values.map(String).join(', ');
    case 'sum':
      return String(asNumbers(values).reduce((a, b) => a + b, 0));
    case 'avg': {
      const nums = asNumbers(values);
      if (nums.length === 0) return '';
      return String(Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100);
    }
    case 'min': {
      const nums = asNumbers(values);
      return nums.length === 0 ? '' : String(Math.min(...nums));
    }
    case 'max': {
      const nums = asNumbers(values);
      return nums.length === 0 ? '' : String(Math.max(...nums));
    }
    case 'earliest':
      return values.map(String).sort()[0] ?? '';
    case 'latest':
      return values.map(String).sort().at(-1) ?? '';
    default:
      return '';
  }
}

/** 'YYYY-MM-DDTHH:MM:SSZ…' → 'YYYY-MM-DD HH:MM' (display for computed times). */
export function formatTimestamp(iso: string): string {
  return iso.length >= 16 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso;
}
