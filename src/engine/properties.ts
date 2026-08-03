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
import { resolveTarget } from './wikilink';
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
  /** Values bucket meaningfully, so a view can group by this field. */
  groupable: boolean;
  /** Values have a total order, so a view can sort by this field. */
  orderable: boolean;
  /** Values are file references, so a card layout can draw one as a cover
   * (M16.22). Required, not optional, for the same reason `groupable` is: a
   * kind that forgets to answer would silently never be offered. */
  media: boolean;
  /**
   * Values are numbers, so they can be summed and averaged (M16.27). A rollup
   * counts because its own calc decides — a `show` rollup aggregates to
   * nothing numeric and `aggregateNumbers` reports that honestly rather than
   * being prevented from trying.
   */
  numeric: boolean;
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
  text: {
    label: 'Text',
    icon: 'type',
    computed: false,
    seed: '',
    groupable: false,
    orderable: true,
    media: false,
    numeric: false,
  },
  number: {
    label: 'Number',
    icon: 'hash',
    computed: false,
    seed: '',
    groupable: false,
    orderable: true,
    media: false,
    numeric: true,
  },
  select: {
    label: 'Select',
    icon: 'circle-chevron-down',
    computed: false,
    seed: '',
    groupable: true,
    orderable: true,
    media: false,
    numeric: false,
  },
  multiselect: {
    label: 'Multi-select',
    icon: 'list-checks',
    computed: false,
    seed: '',
    multi: true,
    groupable: true,
    orderable: false,
    media: false,
    numeric: false,
  },
  status: {
    label: 'Status',
    icon: 'loader',
    computed: false,
    seed: '',
    groupable: true,
    orderable: true,
    media: false,
    numeric: false,
  },
  date: {
    label: 'Date',
    icon: 'calendar',
    computed: false,
    seed: '',
    groupable: false,
    orderable: true,
    media: false,
    numeric: false,
  },
  daterange: {
    label: 'Date range',
    icon: 'calendar-range',
    computed: false,
    seed: '',
    legacy: true,
    groupable: false,
    orderable: true,
    media: false,
    numeric: false,
  },
  person: {
    label: 'Person',
    icon: 'circle-user',
    computed: false,
    seed: '',
    multi: true,
    groupable: true,
    orderable: false,
    media: false,
    numeric: false,
  },
  files: {
    label: 'Files & media',
    icon: 'paperclip',
    computed: false,
    seed: '',
    multi: true,
    groupable: false,
    orderable: false,
    media: true,
    numeric: false,
  },
  checkbox: {
    label: 'Checkbox',
    icon: 'square-check',
    computed: false,
    seed: false,
    groupable: true,
    orderable: true,
    media: false,
    numeric: false,
  },
  url: {
    label: 'URL',
    icon: 'link',
    computed: false,
    seed: '',
    groupable: false,
    orderable: true,
    media: false,
    numeric: false,
  },
  email: {
    label: 'Email',
    icon: 'mail',
    computed: false,
    seed: '',
    groupable: false,
    orderable: true,
    media: false,
    numeric: false,
  },
  phone: {
    label: 'Phone',
    icon: 'phone',
    computed: false,
    seed: '',
    groupable: false,
    orderable: true,
    media: false,
    numeric: false,
  },
  relation: {
    label: 'Relation',
    icon: 'arrow-up-right',
    computed: false,
    seed: '',
    multi: true,
    groupable: true,
    orderable: false,
    media: false,
    numeric: false,
  },
  rollup: {
    label: 'Rollup',
    icon: 'sigma',
    computed: true,
    seed: null,
    groupable: false,
    orderable: true,
    media: false,
    numeric: true,
  },
  created_time: {
    label: 'Created time',
    icon: 'clock',
    computed: true,
    seed: null,
    groupable: false,
    orderable: true,
    media: false,
    numeric: false,
  },
  last_edited_time: {
    label: 'Last edited time',
    icon: 'history',
    computed: true,
    seed: null,
    groupable: false,
    orderable: true,
    media: false,
    numeric: false,
  },
} satisfies Record<FieldKind, Omit<PropertyKindMeta, 'kind'>>;

export const PROPERTY_KINDS: PropertyKindMeta[] = (Object.keys(KIND_META) as FieldKind[]).map(
  (kind) => ({ kind, ...KIND_META[kind] }),
);

/** The kinds offered in "+ Add property" — legacy kinds stay resolvable but
 * are no longer creatable. */
export const CREATABLE_PROPERTY_KINDS = PROPERTY_KINDS.filter((k) => k.legacy !== true);

export const kindMeta = (kind: FieldKind): PropertyKindMeta =>
  PROPERTY_KINDS.find((k) => k.kind === kind) ?? PROPERTY_KINDS[0];

/**
 * Which kinds a view may group and sort by (M16.13).
 *
 * These were two hand-maintained `Set<string>` pairs — `ViewToolbar` exported
 * one and `ViewSettingsPanel` kept a verbatim copy — so adding a kind meant
 * remembering both, deleting from one produced no compile error and no
 * failing test, and the settings panel could offer a sort on a kind the
 * toolbar did not. They are flags on KIND_META now, which `satisfies
 * Record<FieldKind, …>` forces every new kind to answer.
 */
export const GROUPABLE_KINDS: ReadonlySet<FieldKind> = new Set(
  PROPERTY_KINDS.filter((k) => k.groupable).map((k) => k.kind),
);
export const ORDERABLE_KINDS: ReadonlySet<FieldKind> = new Set(
  PROPERTY_KINDS.filter((k) => k.orderable).map((k) => k.kind),
);
/** Which kinds can supply a gallery card's cover (M16.22). */
export const MEDIA_KINDS: ReadonlySet<FieldKind> = new Set(
  PROPERTY_KINDS.filter((k) => k.media).map((k) => k.kind),
);
/** Which kinds a chart can sum or average (M16.27). */
export const NUMERIC_KINDS: ReadonlySet<FieldKind> = new Set(
  PROPERTY_KINDS.filter((k) => k.numeric).map((k) => k.kind),
);

// --- Relation and person targets (M16.13b) ---------------------------------

/**
 * The majority type among a set of raw wikilink targets — the type a field is
 * evidently pointing at, when nobody declared one.
 *
 * Lived in `engine/adopt.ts`, where only the adoption doctor could reach it.
 * It answers exactly the question a person field asks about the values it
 * already holds, so it moved here rather than being written a second time.
 */
export function inferTarget(rawTargets: string[], entries: Entry[]): string | null {
  const counts = new Map<string, number>();
  for (const raw of rawTargets) {
    const resolved = resolveTarget(raw, entries);
    if (resolved === null || resolved.type === null || resolved.type === '') continue;
    counts.set(resolved.type, (counts.get(resolved.type) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [type, count] of counts) {
    if (count > bestCount) {
      best = type;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Which type a relation-family field points at, or null for "any record".
 *
 * A `person` field IS a relation with an avatar renderer, so it answers the
 * same question the same way — except that three call sites answered it with
 * the literal string `'Person'` instead (M16.13b). AGENTS.md forbids exactly
 * that: behaviour is capability-gated, never routed on a type NAME. A vault
 * whose people are `Teammate`s got an empty picker, an empty rollup target,
 * and no control anywhere that could fix either.
 *
 * Inference from held values is deliberately restricted to `person`. On a
 * relation an absent target is the user's explicit "Any record (unenforced)"
 * choice — `RelationConfigEditor` writes null for it — and narrowing that to
 * whatever the field happens to hold today would silently re-enforce a
 * constraint they had turned off.
 */
export function relationTargetFor(
  def: FieldDef,
  entries: Entry[],
  /** Restricts value inference to records of the declaring type; a field name
   * is not unique across types. */
  ownerType?: string | null,
): string | null {
  // The derived side of a two-way pair: the data lives on `from.type`.
  if (def.from !== undefined) return def.from.type;
  if (def.target !== undefined && def.target !== '') return def.target;
  if (def.kind !== 'person') return null;
  const owned =
    ownerType === undefined || ownerType === null
      ? entries
      : entries.filter((e) => e.type === ownerType);
  return inferTarget(
    owned.flatMap((e) => e.relationships[def.name] ?? []),
    entries,
  );
}

/**
 * The types this vault treats as people: every type a `person` field targets.
 *
 * Derived rather than declared, because the surfaces that need it most — the
 * editor's `@` menu, a person field with no target yet — have no FieldDef to
 * read a target off. The type named "Person" is a last-resort CONVENTION, not
 * a rule: it keeps a vault that has people but has declared no person field
 * working, without making the name load-bearing anywhere else.
 *
 * An empty set means this vault has no notion of people, which is a real
 * answer — surfaces should drop their People section, not list everything.
 */
export function peopleTypes(schema: Schema, entries: Entry[]): ReadonlySet<string> {
  const found = new Set<string>();
  for (const [typeName, def] of schema.types) {
    for (const field of def.fields) {
      if (field.kind !== 'person') continue;
      const target = relationTargetFor(field, entries, typeName);
      if (target !== null) found.add(target);
    }
  }
  if (found.size === 0 && schema.types.has('Person')) found.add('Person');
  return found;
}

/**
 * The records a person field may pick from.
 *
 * Most specific answer first: the field's declared target, then the majority
 * type of the people it already holds (both via `relationTargetFor`), then
 * the vault's people types, and finally every record — an over-long picker
 * is merely long, while the empty one this used to produce was a dead end.
 */
export function personCandidates(
  def: FieldDef,
  schema: Schema,
  entries: Entry[],
  ownerType?: string | null,
): Entry[] {
  const target = relationTargetFor(def, entries, ownerType);
  if (target !== null) return entries.filter((e) => e.type === target);
  const people = peopleTypes(schema, entries);
  // Type docs are schema, never candidates — the same exclusion RelationPicker
  // applies to an unenforced relation.
  const records = entries.filter((e) => e.type !== 'Type');
  return people.size === 0 ? records : records.filter((e) => people.has(e.type ?? ''));
}

// --- Option identity and order (M16.12) ------------------------------------

/**
 * The id a new option's label slugs to.
 *
 * It lived in `detail/OptionListEditor.tsx`, which is why `FieldPopover`'s
 * create row could not see it and compared LABELS instead — see
 * `findOptionByLabel`.
 */
export const optionId = (label: string): string => label.trim().replace(/\s+/g, '-').toLowerCase();

/**
 * The option a label would collide with, by SLUG rather than by label.
 *
 * "In-Progress" and "In Progress" are different labels and the same id. The
 * inline-create row compared labels, so it offered to create the second one;
 * nothing overwrote anything, because the write APPENDS — the type doc ended
 * holding two entries with id `in-progress`, and every lookup in the app is a
 * `.find` on id, so the FIRST won. The new label was invisible forever, the
 * record kept rendering the old one, and the write reported success.
 */
export function findOptionByLabel<T extends { id: string; label: string }>(
  list: T[],
  label: string,
): T | undefined {
  const id = optionId(label);
  const lower = label.trim().toLowerCase();
  return list.find((o) => o.id === id || o.label.trim().toLowerCase() === lower);
}

/** Move one item to a new index, returning a new array. */
export function moveOption<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length || to < 0 || to >= list.length) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

// --- Per-property visibility (M16.10) --------------------------------------

/**
 * Whether a property counts as absent for `hide_when_empty`.
 *
 * A checkbox is never empty: `false` is an answer, not a blank, and hiding
 * every unticked box would make the state unreachable from the panel.
 */
export function isEmptyForVisibility(def: FieldDef, display: string): boolean {
  return def.kind !== 'checkbox' && display === '';
}

/**
 * Split declared fields into what a record panel shows and what it folds away
 * behind the "N hidden properties" expander (M16.10).
 *
 * Per-property, on the type. `ColumnSpec.hidden` answers a different question
 * — "does THIS view show this column" — and a record panel has no view to
 * read it from.
 */
export function splitByVisibility(
  fields: FieldDef[],
  isEmpty: (def: FieldDef) => boolean,
): { shown: FieldDef[]; hidden: FieldDef[] } {
  const shown: FieldDef[] = [];
  const hidden: FieldDef[] = [];
  for (const f of fields) {
    const v = f.visibility ?? 'show';
    if (v === 'hide' || (v === 'hide_when_empty' && isEmpty(f))) hidden.push(f);
    else shown.push(f);
  }
  return { shown, hidden };
}

/**
 * The `moveFieldOnType` delta for dropping `id` into slot `toShownIndex` of a
 * list that is only PART of the declared order (M16.10).
 *
 * Dragging over a panel with hidden properties would otherwise write the
 * visible index straight into the full mapping and scatter the hidden ones.
 * The row lands immediately before whichever visible row will occupy that
 * slot, so the hidden properties around it keep their relative places.
 */
export function visibilityDelta(
  all: string[],
  shown: string[],
  id: string,
  toShownIndex: number,
): number {
  const from = all.indexOf(id);
  if (from === -1) return 0;
  const rest = all.filter((n) => n !== id);
  const shownRest = shown.filter((n) => n !== id);
  const anchor = shownRest[toShownIndex];
  const at =
    anchor !== undefined
      ? rest.indexOf(anchor)
      : shownRest.length === 0
        ? rest.length
        : rest.indexOf(shownRest[shownRest.length - 1]) + 1;
  return at - from;
}

/**
 * A stored date endpoint: the ISO day, optionally followed by a 24h time
 * (M16.14). Validation had only `ISO_DATE`, so the first date given a time of
 * day was rejected by the very write that set it.
 */
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}(?:[ T](?:[01]\d|2[0-3]):[0-5]\d)?$/;
/**
 * One stored endpoint out of arbitrary text, normalized to `YYYY-MM-DD` or
 * `YYYY-MM-DD HH:MM`.
 *
 * The time is kept only when the WHOLE value is one of those two shapes.
 * `2026-07-30T10:00:00Z` is a UTC instant, and lifting `10:00` out of it and
 * storing it as a local wall-clock time would shift the value by the user's
 * offset — the exact mistake schedule.ts is written to avoid ("a task due the
 * 3rd is due the 3rd in the user's timezone"). Those degrade to the date.
 */
function readEndpoint(text: string): string | null {
  const v = text.trim();
  if (ISO_DATETIME.test(v)) return v.replace('T', ' ');
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  return m === null ? null : m[1];
}
const URL_SHAPE = /^(https?:\/\/|mailto:|www\.)/i;
/** Only for INFERRING a kind from a loose value — never for validation. */
const EMAIL_SHAPE = /^(mailto:)?[^\s@]+@[^\s@]+\.[^\s@]+$/i;

/**
 * The kind an UNDECLARED frontmatter value looks like (M16.6).
 *
 * Every property row leads with its kind's icon, and a loose key has no
 * declared kind — an empty slot there reads as a rendering fault rather than
 * as "this key is not on the type". The stored shape is the only evidence
 * available, and it is the same evidence `coerceValueToKind` reads in the
 * other direction.
 *
 * This describes what the value IS. It never writes anything, and it is not
 * a suggestion the schema should adopt: promoting a loose key to a declared
 * field stays an explicit act.
 */
export function inferKindFromValue(value: unknown): FieldKind {
  if (typeof value === 'boolean') return 'checkbox';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value)) return 'multiselect';
  if (typeof value === 'string') {
    if (ISO_DATETIME.test(value)) return 'date';
    // Before the url check: `mailto:` matches URL_SHAPE too, and an address
    // is more specific than "some link".
    if (EMAIL_SHAPE.test(value)) return 'email';
    if (URL_SHAPE.test(value)) return 'url';
    return 'text';
  }
  // A leftover from a field dropped off its type: the daterange mapping
  // outlives the declaration that gave it meaning.
  if (typeof value === 'object' && value !== null) {
    const r = value as Record<string, unknown>;
    return 'start' in r || 'end' in r ? 'daterange' : 'text';
  }
  return 'text';
}

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
      return isScalarString(value) && ISO_DATETIME.test(value)
        ? null
        : `${label} must be a date (YYYY-MM-DD, optionally HH:MM)`;
    case 'daterange': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return `${label} must be a start/end range`;
      }
      const r = value as { start?: unknown; end?: unknown };
      for (const part of [r.start, r.end]) {
        if (
          part !== null &&
          part !== undefined &&
          !(isScalarString(part) && ISO_DATETIME.test(part))
        ) {
          return `${label} dates must be YYYY-MM-DD (optionally HH:MM)`;
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
    case 'email':
    case 'phone':
      // Shape only, no pattern. This module's contract (see the header) is
      // that SHAPE is strict and semantics stay advisory, Notion does not
      // validate either, and refusing a frontmatter write is a far worse
      // failure than an address that will not linkify. The value these kinds
      // add is a mailto:/tel: link and the right keyboard, not rejection.
      return isScalarString(value) ? null : `${label} must be text`;
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
 * A `{start, end}` daterange as its non-empty endpoints, or null when the
 * value is not one. The only reader of a daterange's shape outside the date
 * engine, and the reason a conversion out of one no longer sees
 * "[object Object]".
 */
function rangeParts(raw: unknown): string[] | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as { start?: unknown; end?: unknown };
  if (!('start' in r) && !('end' in r)) return null;
  return [r.start, r.end]
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .map((v) => v.trim());
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
  // A daterange is a {start, end} MAPPING, and `String(…)` on it produced the
  // literal "[object Object]" (M16.14). Every conversion out of a daterange
  // was therefore either that string or a null — a date range converted to
  // text wrote garbage into every record of the type, and converted to a date
  // it silently cleared them.
  const range = rangeParts(raw);
  const list =
    range !== null ? range : (Array.isArray(raw) ? raw : [raw]).map(String).filter((v) => v !== '');
  const first = list[0] ?? '';
  switch (kind) {
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
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
      // Keeps the time when there is one: a `daterange` collapsing to a
      // `date` loses its end, which is unavoidable, but losing 14:30 as well
      // is not.
      return readEndpoint(first);
    }
    case 'daterange': {
      // Splitting the text too, so a range that went out through `text`
      // ("2026-08-02, 2026-08-09") comes back as a range rather than as its
      // start date with the end quietly dropped.
      const parts = list
        .flatMap((v) => v.split(/\s*(?:→|->|,|\.\.)\s*/))
        .map(readEndpoint)
        .filter((v): v is string => v !== null);
      if (parts.length === 0) return null;
      return { start: parts[0], end: parts[1] ?? null };
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
    default: {
      // The return type is `unknown`, and `undefined` is assignable to it —
      // so a kind added to the union and forgotten HERE compiled clean, and
      // `changeFieldKind` then pushed the undefined through
      // `patchFrontmatter`, which spells undefined as "delete". Converting to
      // a forgotten kind wiped the value on every record of the type, in
      // silence. This is the M16.4 guard the one `unknown` return escaped.
      const exhaustive: never = kind;
      return exhaustive;
    }
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

/** The calcs that reduce a list of values to one number. */
export type NumericCalc = Extract<RollupCalc, 'sum' | 'avg' | 'min' | 'max'>;

/**
 * Reduce raw property values to one number, or null when none of them is one
 * (M16.27).
 *
 * Extracted from `computeRollup` rather than written a second time for the
 * chart. A chart that summed its own way would disagree with the rollup column
 * beside it the first time a value arrived as the string "3" — which is what
 * frontmatter does with a quoted number — and the two answers would both look
 * plausible.
 *
 * `count` is deliberately absent: it counts RECORDS, not values, and only the
 * caller knows how many records a bucket holds.
 */
export function aggregateNumbers(values: unknown[], calc: NumericCalc): number | null {
  const nums = asNumbers(values);
  if (nums.length === 0) return null;
  switch (calc) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'avg':
      return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
    case 'min':
      return Math.min(...nums);
    case 'max':
      return Math.max(...nums);
  }
}

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
    // Sum of nothing-numeric has always reported 0 where the other three
    // report ''. Preserved verbatim through the extraction rather than
    // quietly changed — that is a decision about what a rollup says, not a
    // side effect of sharing the arithmetic with a chart (M16.27).
    case 'sum':
      return String(aggregateNumbers(values, 'sum') ?? 0);
    case 'avg':
    case 'min':
    case 'max': {
      const n = aggregateNumbers(values, calc);
      return n === null ? '' : String(n);
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
