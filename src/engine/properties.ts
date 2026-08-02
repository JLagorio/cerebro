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

import { childrenOf, rollupSpec, type RelationIndex } from './relations';
import type { Entry, FieldDef, FieldFormat, FieldKind, RollupCalc, Schema } from './types';

// --- System properties (M4) -------------------------------------------------

/**
 * App-managed frontmatter keys are `_`-prefixed (Tolaria's convention:
 * `_organized`, `_pinned`, `_icon`). They are real YAML — visible to any
 * editor and to agents — but the property surfaces hide them and the field
 * pickers refuse to create them, so the workflow state the app maintains
 * never reads as user data the user is expected to curate.
 *
 * Hidden, not stripped: writes preserve unknown keys, so a `_`-key set by
 * another tool survives a round-trip through cerebro untouched.
 */
export function isSystemProperty(name: string): boolean {
  return name.startsWith('_');
}

/** Drop app-managed keys from a list of frontmatter names for display. */
export function visibleProperties(names: string[]): string[] {
  return names.filter((n) => !isSystemProperty(n));
}

// --- Rollup catalog + numeric formatting (M3.4) ----------------------------

export interface RollupCalcMeta {
  calc: RollupCalc;
  label: string;
  /** Reads a property on each target (false = the targets themselves count). */
  needsProperty: boolean;
  /** Only meaningful over numeric properties. */
  numeric: boolean;
}

/** Every aggregation the engine can compute, with what it needs configured. */
export const ROLLUP_CALCS: RollupCalcMeta[] = [
  { calc: 'count', label: 'Count', needsProperty: false, numeric: false },
  { calc: 'sum', label: 'Sum', needsProperty: true, numeric: true },
  { calc: 'avg', label: 'Average', needsProperty: true, numeric: true },
  { calc: 'min', label: 'Min', needsProperty: true, numeric: true },
  { calc: 'max', label: 'Max', needsProperty: true, numeric: true },
  { calc: 'earliest', label: 'Earliest', needsProperty: true, numeric: false },
  { calc: 'latest', label: 'Latest', needsProperty: true, numeric: false },
  { calc: 'show', label: 'Show values', needsProperty: true, numeric: false },
];

export const rollupCalcMeta = (calc: RollupCalc | undefined): RollupCalcMeta =>
  ROLLUP_CALCS.find((c) => c.calc === calc) ?? ROLLUP_CALCS[0];

export const FIELD_FORMATS: { format: FieldFormat; label: string }[] = [
  { format: 'plain', label: 'Plain number' },
  { format: 'percent', label: 'Percent' },
  { format: 'progress', label: 'Progress bar' },
  { format: 'currency', label: 'Currency' },
];

/** Trim trailing zeros so 69.67 stays 69.67 but 3.00 reads 3. */
function trimNumber(n: number, precision: number): string {
  return String(Number(n.toFixed(precision)));
}

/**
 * Display string for a numeric value under its field's format. Formats are
 * presentation only — the frontmatter keeps the bare number, so a percent
 * field still sorts, sums, and round-trips as a number.
 */
export function formatNumber(value: number, def: FieldDef): string {
  const precision = def.precision ?? 2;
  switch (def.format) {
    case 'percent':
    case 'progress':
      return `${trimNumber(value, precision)}%`;
    case 'currency':
      return `$${value.toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: precision,
      })}`;
    default:
      return trimNumber(value, precision);
  }
}

/** Apply a field's format to an already-computed display string when it
 * parses as a number; non-numeric values (e.g. `show` rollups) pass through. */
export function applyFormat(display: string, def: FieldDef): string {
  if (display === '' || def.format === undefined || def.format === 'plain') return display;
  const n = Number(display);
  return Number.isFinite(n) ? formatNumber(n, def) : display;
}

/** 0–100 clamp for progress bars; null when the value isn't numeric. */
export function progressRatio(display: string): number | null {
  const n = Number(String(display).replace(/[%$,]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

export interface PropertyKindMeta {
  kind: FieldKind;
  label: string;
  icon: string;
  /** Computed kinds render read-only and reject writes. */
  computed: boolean;
  /** Initial frontmatter value seeded when the property is added untyped. */
  seed: unknown;
  /** Kept for existing vaults but kept OUT of the "+ Add property" catalog
   * (M3.1: Date covers ranges via its own end toggle). */
  legacy?: boolean;
  /** Holds several values at once — the pickers stay open and toggle. */
  multi?: boolean;
}

/**
 * Every kind's metadata, in "+ Add property" catalog order (M16.4).
 *
 * `satisfies Record<FieldKind, ...>` is the enforcement: this was a bare
 * array, so a kind added to the union but forgotten here fell through
 * `kindMeta`'s `?? PROPERTY_KINDS[0]` and silently rendered as Text — with a
 * Text icon, in every surface, forever. Declaration order is catalog order,
 * because object key order is insertion order for string keys.
 */
const KIND_META = {
  text: { label: 'Text', icon: 'type', computed: false, seed: '' },
  number: { label: 'Number', icon: 'hash', computed: false, seed: '' },
  select: { label: 'Select', icon: 'circle-chevron-down', computed: false, seed: '' },
  multiselect: {
    label: 'Multi-select',
    icon: 'list-checks',
    computed: false,
    seed: '',
    multi: true,
  },
  status: { label: 'Status', icon: 'loader', computed: false, seed: '' },
  date: { label: 'Date', icon: 'calendar', computed: false, seed: '' },
  daterange: {
    label: 'Date range',
    icon: 'calendar-range',
    computed: false,
    seed: '',
    legacy: true,
  },
  person: { label: 'Person', icon: 'circle-user', computed: false, seed: '', multi: true },
  files: { label: 'Files & media', icon: 'paperclip', computed: false, seed: '', multi: true },
  checkbox: { label: 'Checkbox', icon: 'square-check', computed: false, seed: false },
  url: { label: 'URL', icon: 'link', computed: false, seed: '' },
  relation: { label: 'Relation', icon: 'arrow-up-right', computed: false, seed: '', multi: true },
  rollup: { label: 'Rollup', icon: 'sigma', computed: true, seed: null },
  created_time: { label: 'Created time', icon: 'clock', computed: true, seed: null },
  last_edited_time: { label: 'Last edited time', icon: 'history', computed: true, seed: null },
} satisfies Record<FieldKind, Omit<PropertyKindMeta, 'kind'>>;

export const PROPERTY_KINDS: PropertyKindMeta[] = (Object.keys(KIND_META) as FieldKind[]).map(
  (kind) => ({ kind, ...KIND_META[kind] }),
);

/** The kinds offered in "+ Add property" — legacy kinds stay resolvable but
 * are no longer creatable. */
export const CREATABLE_PROPERTY_KINDS = PROPERTY_KINDS.filter((k) => k.legacy !== true);

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
      return isScalarString(value) || typeof value === 'number' ? null : `${label} must be text`;
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
      return isScalarString(value) || isStringArray(value)
        ? null
        : `${label} must reference other pages`;
    case 'relation': {
      // The reciprocal of a two-way pair is derived — writing it here would
      // store a mirror that the owning side immediately contradicts (M12.4).
      if (def.from !== undefined) {
        return `${label} is the other side of a relation — edit it from the linked records`;
      }
      if (!(isScalarString(value) || isStringArray(value))) {
        return `${label} must reference other pages`;
      }
      if (def.limit === 1 && Array.isArray(value) && value.length > 1) {
        return `${label} links a single record`;
      }
      return null;
    }
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
 * Best-effort value conversion when a field changes kind (M12.4b — the
 * header menu's Change type). Returns the value to store, or null when the
 * old value has no honest representation in the new kind (the key is then
 * cleared rather than left holding a shape the schema now rejects).
 *
 * Deliberately lossy in one direction only: a value is kept whenever a
 * reasonable reading exists (Notion's behavior), and dropped otherwise —
 * never mangled into something that looks authored.
 */
export function coerceValueToKind(raw: unknown, kind: FieldKind): unknown {
  if (raw === null || raw === undefined || raw === '') return null;
  const list = (Array.isArray(raw) ? raw : [raw]).map(String).filter((v) => v !== '');
  const first = list[0] ?? '';
  switch (kind) {
    case 'text':
    case 'url':
      return list.join(', ');
    case 'number': {
      const cleaned = String(first).replace(/[^0-9.eE+-]/g, '');
      // Number('') is 0 — prose must clear, not silently become zero.
      if (!/\d/.test(cleaned)) return null;
      const n = Number(cleaned);
      return Number.isFinite(n) ? n : null;
    }
    case 'checkbox': {
      if (typeof raw === 'boolean') return raw;
      const v = first.toLowerCase();
      if (['true', 'yes', 'x', 'on', '1'].includes(v)) return true;
      if (['false', 'no', 'off', '0'].includes(v)) return false;
      return null;
    }
    case 'date': {
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(first);
      return m !== null ? m[1] : null;
    }
    case 'daterange': {
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(first);
      return m !== null ? { start: m[1], end: null } : null;
    }
    case 'select':
    case 'status':
      return first === '' ? null : first;
    case 'multiselect':
    case 'files':
      return list.length > 0 ? list : null;
    case 'person':
    case 'relation':
      // Relation values live in frontmatter as wikilinks; splitting a text
      // like "alpha, beta" gives each name its own link.
      return list.length > 0
        ? list
            .flatMap((v) => v.split(','))
            .map((v) => v.trim().replace(/^\[\[/, '').replace(/\]\]$/, ''))
            .filter((v) => v !== '')
            .map((v) => `[[${v}]]`)
        : null;
    case 'rollup':
    case 'created_time':
    case 'last_edited_time':
      // Computed kinds ignore stored values; leave the frontmatter alone.
      return raw;
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
  values.map((v) => (typeof v === 'number' ? v : Number(v))).filter((n) => Number.isFinite(n));

/**
 * Aggregate `def.property` across the entries referenced by this entry's
 * `def.relation` field. Returns a display string ('' when unresolvable).
 */
export function computeRollup(
  entry: Entry,
  def: FieldDef,
  entries: Entry[],
  index?: RelationIndex,
): string {
  // M3.5: forward (`relation:`) and reverse (`from:`) sources both resolve
  // here, so a parent can aggregate children that point at it.
  const spec = rollupSpec(def);
  const targets = spec === null ? [] : childrenOf(entry, spec, entries, index);
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
