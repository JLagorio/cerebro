import { IMPORT_KEYS } from './importSources';
/**
 * Properties engine (M2.x): the write-side of the YAML schema. Type notes
 * declare fields (`fields:` frontmatter on `type: Type` docs).
 *
 * The facts about each kind and the shapes a value may take are data since
 * M60.3: shared/schema/field-kinds.v1.json (read through fieldKindTable.ts),
 * which Rust's vault/schema.rs reads too, and dates by
 * shared/calendar/dates.v1.json. This module keeps the UI half (each kind's
 * label, icon and seed, in "+ Add property" catalog order), interprets the
 * table in `validateValue`, and computes the computed kinds (created and
 * last-edited time, rollups and formulas).
 *
 * Enforcement philosophy: SHAPE is strict (a number field never stores
 * "abc"), option membership stays advisory — unknown select values render
 * as ghosts rather than being rejected (locked M1 decision).
 */

import { parseRepeat } from './recurrence';
import { DATE_GRAMMAR, dateRangeFault, isDateText, parseDateText } from './dateGrammar';
import {
  kindFacts,
  ROLLUP_RESULTS,
  URL_PREFIXES,
  type Atom,
  type MessageKey,
} from './fieldKindTable';
import { isLibraryType } from './library';
import { isPageChromeKey } from './pageChrome';
import { childrenOf, rollupSpec, type RelationIndex } from './relations';
import { resolveTarget } from './wikilink';
import type {
  Entry,
  FieldDef,
  FieldFormat,
  FieldKind,
  FilterFamily,
  RollupCalc,
  Schema,
  StatusDef,
} from './types';

// --- System properties (M4) -------------------------------------------------

/**
 * App-managed frontmatter keys: the `_`-prefixed workflow keys (Tolaria's
 * convention: `_organized`, `_pinned`), and the page chrome keys `icon` and
 * `cover` (M55.11), which the page draws above its title rather than as rows.
 * They are real YAML — visible to any editor and to agents — but the property
 * surfaces, the columns and adoption skip them, so what the app maintains
 * never reads as user data the user is expected to curate.
 *
 * Hidden, not stripped: writes preserve unknown keys, so a `_`-key set by
 * another tool survives a round-trip through cerebro untouched.
 */
export function isSystemProperty(name: string): boolean {
  return (
    name.startsWith('_') ||
    isPageChromeKey(name) ||
    (name !== 'source_url' && IMPORT_KEYS.includes(name))
  );
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
  /** Numeric aggregation; percent_done counts status and checkbox outcomes. */
  numeric: boolean;
  /** The result is a number a view compares and sums as one (M60.1); the
   * others yield text (a date string, or a list of values). The table's
   * `rollup_calcs[].result` says which. */
  yieldsNumber: boolean;
}

const rollupCalc = (
  calc: RollupCalc,
  label: string,
  needsProperty: boolean,
  numeric: boolean,
): RollupCalcMeta => ({
  calc,
  label,
  needsProperty,
  numeric,
  yieldsNumber: ROLLUP_RESULTS.get(calc) === 'number',
});

/** Every aggregation the engine can compute, with what it needs configured,
 * in the table's menu order. */
export const ROLLUP_CALCS: RollupCalcMeta[] = [
  rollupCalc('count', 'Count', false, false),
  rollupCalc('sum', 'Sum', true, true),
  rollupCalc('avg', 'Average', true, true),
  rollupCalc('min', 'Min', true, true),
  rollupCalc('max', 'Max', true, true),
  rollupCalc('percent_done', 'Percent done', true, true),
  rollupCalc('earliest', 'Earliest', true, false),
  rollupCalc('latest', 'Latest', true, false),
  rollupCalc('show', 'Show values', true, false),
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

/**
 * 0–100 clamp for progress bars; null when the value isn't numeric.
 *
 * A BLANK value is not zero (M20.1). `Number('')` is `0` and `0` is finite, so
 * every record with no value under a progress-formatted column drew a full
 * empty track — which reads as "0% done" rather than as "nothing recorded",
 * and contradicted the em-dash the neighbouring read-only kinds show for the
 * same absence.
 */
export function progressRatio(display: string): number | null {
  const text = String(display).replace(/[%$,]/g, '').trim();
  if (text === '') return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

/** One kind as the UI reads it: its facts (field-kinds.v1.json's `kinds`,
 * through `kindFacts`) merged with its label, icon and seed (`KIND_UI`). */
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
   * Values are numbers, so they can be summed and averaged — the table's
   * calculation footer (M16.15) and the chart's aggregation (M16.27), which
   * arrived on separate branches and independently asked for this same flag
   * rather than each keeping a `Set<FieldKind>`.
   *
   * A rollup counts because its own calc decides: a `show` rollup aggregates
   * to nothing numeric, and the aggregators report that honestly rather than
   * being prevented from trying.
   */
  numeric: boolean;
  /** Which comparisons a filter may offer on this field (M16.25). See
   * `FilterFamily` in types.ts, and `filterOpsFor` in viewFilters.ts. */
  filters: FilterFamily;
  /**
   * This kind's option set lives on the TYPE (`statuses:`), not on the field
   * (`options:`) — so a `FieldDef` alone cannot say what the choices are, and
   * a surface holding one has to resolve them (M16.29).
   *
   * True for exactly one kind, and optional for the same reason `multi` and
   * `legacy` are: a kind that says nothing is saying the ordinary thing. It
   * is a flag here rather than a `kind === 'status'` test at the two call
   * sites, which is how the filter surface came to have no answer at all.
   */
  statusSet?: boolean;
}

/** A kind's UI half: what the catalog and every property row draw. */
interface KindUi {
  label: string;
  icon: string;
  /** Initial frontmatter value seeded when the property is added untyped. */
  seed: unknown;
}

/**
 * Every kind's label, icon and seed, in "+ Add property" catalog order
 * (M16.4). The facts (computed, groupable, numeric, the filter family, …)
 * are field-kinds.v1.json's, merged in below; only what a screen draws lives
 * here, because Rust never draws anything.
 *
 * `satisfies Record<FieldKind, …>` keeps every kind drawn: this was a bare
 * array once, and a kind added to the union but forgotten here fell through
 * `kindMeta`'s `?? PROPERTY_KINDS[0]` and silently rendered as Text — with a
 * Text icon, in every surface, forever. Declaration order is catalog order,
 * because object key order is insertion order for string keys.
 */
const KIND_UI = {
  text: { label: 'Text', icon: 'type', seed: '' },
  number: { label: 'Number', icon: 'hash', seed: '' },
  select: { label: 'Select', icon: 'circle-chevron-down', seed: '' },
  multiselect: { label: 'Multi-select', icon: 'list-checks', seed: '' },
  status: { label: 'Status', icon: 'loader', seed: '' },
  date: { label: 'Date', icon: 'calendar', seed: '' },
  daterange: { label: 'Date range', icon: 'calendar-range', seed: '' },
  repeat: { label: 'Repeat', icon: 'repeat', seed: '' },
  person: { label: 'Person', icon: 'circle-user', seed: '' },
  files: { label: 'Files & media', icon: 'paperclip', seed: '' },
  checkbox: { label: 'Checkbox', icon: 'square-check', seed: false },
  url: { label: 'URL', icon: 'link', seed: '' },
  email: { label: 'Email', icon: 'mail', seed: '' },
  phone: { label: 'Phone', icon: 'phone', seed: '' },
  relation: { label: 'Relation', icon: 'arrow-up-right', seed: '' },
  rollup: { label: 'Rollup', icon: 'sigma', seed: null },
  formula: { label: 'Formula', icon: 'square-function', seed: null },
  created_time: { label: 'Created time', icon: 'clock', seed: null },
  last_edited_time: { label: 'Last edited time', icon: 'history', seed: null },
} satisfies Record<FieldKind, KindUi>;

export const PROPERTY_KINDS: PropertyKindMeta[] = (Object.keys(KIND_UI) as FieldKind[]).map(
  (kind) => {
    const facts = kindFacts(kind);
    const meta: PropertyKindMeta = {
      kind,
      ...KIND_UI[kind],
      computed: facts.computed,
      groupable: facts.groupable,
      orderable: facts.orderable,
      media: facts.media,
      numeric: facts.numeric,
      filters: facts.filters,
    };
    if (facts.legacy) meta.legacy = true;
    if (facts.multi) meta.multi = true;
    if (facts.status_set) meta.statusSet = true;
    return meta;
  },
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
 * toolbar did not. They are facts in field-kinds.v1.json now, whose loader
 * refuses a table that leaves a kind out.
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
 * evidently pointing at, when nobody declared one. A library type is reached
 * only by a declared target.
 *
 * Lived in `engine/adopt.ts`, where only the adoption doctor could reach it.
 * It answers exactly the question a person field asks about the values it
 * already holds, so it moved here rather than being written a second time.
 */
export function inferTarget(rawTargets: string[], entries: Entry[]): string | null {
  const counts = new Map<string, number>();
  for (const raw of rawTargets) {
    const resolved = resolveTarget(raw, entries);
    if (
      resolved === null ||
      resolved.type === null ||
      resolved.type === '' ||
      isLibraryType(resolved.type)
    )
      continue;
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
 * A library type is reached only by a declared target.
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
 * The types this vault treats as people: every non-library type a `person` field
 * targets. A library type is reached only by a declared relation target.
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
      if (target !== null && !isLibraryType(target)) found.add(target);
    }
  }
  if (found.size === 0 && schema.types.has('Person')) found.add('Person');
  return found;
}

/**
 * The records a person field may pick from.
 *
 * Most specific answer first: the field's declared target, then the majority
 * type of the people it already holds (both via `relationTargetFor`), then the
 * vault's people types. There is no fourth answer (M20.1).
 *
 * It used to end in "…and finally every record", on the reasoning that an
 * over-long picker is merely long while an empty one is a dead end. It is not
 * merely long: it is a one-click way to retype the vault. `relationTargetFor`
 * INFERS a person field's target from the values it already holds, so picking
 * a Project into an untargeted `Lead` makes that field decide it points at
 * Project — permanently, with no control anywhere that says so. `peopleTypes`
 * then collects those inferred targets, so Project becomes one of the vault's
 * people types and leaks into every other untargeted person field and the
 * editor's `@` menu. One mis-click, and the vault's notion of "person" is
 * whatever was nearest to hand.
 *
 * `peopleTypes`' own rule is the right one and this was the function that did
 * not obey it: an empty set is a real answer. The dead end it was avoiding is
 * closed properly instead — the picker can now CREATE a person (M20.1), and
 * creating the first one is what establishes what a person is here.
 *
 * `owner` is the record being edited: its type narrows the inference (a field
 * name is not unique across types), and it is excluded from its own picker for
 * the same reason `type: 'Type'` is — a record is not its own owner.
 */
export function personCandidates(
  def: FieldDef,
  schema: Schema,
  entries: Entry[],
  owner?: Entry | null,
): Entry[] {
  const target = relationTargetFor(def, entries, owner?.type);
  // A hand-written person target cannot make an agent or skill a person.
  if (isLibraryType(target)) return [];
  const notSelf = (e: Entry) => e.path !== owner?.path;
  if (target !== null) return entries.filter((e) => e.type === target && notSelf(e));
  const people = peopleTypes(schema, entries);
  if (people.size === 0) return [];
  // Type docs are schema, never candidates — the same exclusion RelationPicker
  // applies to an unenforced relation. An UNTYPED doc is excluded by the same
  // rule that admits the rest: `people` holds type names, and a doc has none.
  return entries.filter((e) => e.type !== 'Type' && people.has(e.type ?? '') && notSelf(e));
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
 * The ONE fold predicate every property surface hands `splitByVisibility`
 * (M45.3): does this field fold away for being UNSET on `entry`? Formerly a
 * character-identical lambda in RecordProperties, DocProperties, the heading
 * strip, and the layout canvas.
 *
 * `showEmpty` — the type's display bit, or the layout editor's DRAFT — turns
 * folding-for-emptiness off entirely (M44.1): a show-empty surface unfolds
 * only what was hidden for BEING EMPTY, while a field hidden on purpose
 * (`visibility: hide`) stays folded either way — that half is
 * `splitByVisibility`'s call, not this predicate's.
 */
export function foldsWhenUnset(
  entry: Entry,
  schema: Schema,
  showEmpty: boolean,
): (f: FieldDef) => boolean {
  return (f) => !showEmpty && isEmptyForVisibility(f, schema.resolveField(entry, f.name).display);
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
 * One stored endpoint out of arbitrary text, read by the shared grammar
 * (dates.v1.json) and spelled the way a write stores it.
 *
 * A valid instant is kept verbatim. M16.14 degraded `2026-07-30T10:00:00Z` to
 * its UTC date, because lifting `10:00` out of it as a local wall time would
 * shift it by the user's offset; the grammar admits instants now (M60.3), so
 * the value keeps its zone and reads as local time wherever it is shown. A
 * floating time is respelled with the written separator; anything else is
 * not a date and reads as null.
 */
function readEndpoint(text: string): string | null {
  const v = text.trim();
  const read = parseDateText(v);
  if (read === null) return null;
  if (read.instant) return v;
  return read.time === null
    ? read.date
    : `${read.date}${DATE_GRAMMAR.written_separator}${read.time}`;
}

/** The table's `url_prefixes`, matched ignoring ASCII case. */
function hasUrlPrefix(text: string): boolean {
  return URL_PREFIXES.some(
    (p) => text.length >= p.length && text.slice(0, p.length).toLowerCase() === p.toLowerCase(),
  );
}
/** A scheme, per RFC 3986's `scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** Something with a dot in it and no spaces — `example.com`, `a.b.co/x?y`. */
const BARE_HOST = /^[\w-]+(\.[\w-]+)+([/:?#]|$)/;

/**
 * Give a URL the scheme its author left off (M20.3).
 *
 * `example.com` is what people type, and it was refused outright: a toast, the
 * cell reverted, and the text they had typed was gone. The app's own renderer
 * already prepends `https://` to a bare `www.` when it draws the anchor, so
 * the value was being held to a stricter standard on the way IN than on the
 * way out.
 *
 * Deliberately narrow. Prefixing anything at all would turn every rejection
 * into an acceptance and delete the validation entirely — "not a url" has no
 * dot and stays refused, which is the case the message is for.
 */
export function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '' || HAS_SCHEME.test(trimmed)) return trimmed;
  return BARE_HOST.test(trimmed) ? `https://${trimmed}` : trimmed;
}
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
    if (isDateText(value)) return 'date';
    // Before the url check: `mailto:` is a URL prefix too, and an address
    // is more specific than "some link".
    if (EMAIL_SHAPE.test(value)) return 'email';
    if (hasUrlPrefix(value)) return 'url';
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

function atomHolds(atom: Atom, value: unknown): boolean {
  switch (atom) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string_list':
      return Array.isArray(value) && value.every((x) => typeof x === 'string');
    case 'date_text':
      return isDateText(value);
    case 'date_range':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'url_text':
      return typeof value === 'string' && (value === '' || hasUrlPrefix(value));
  }
}

/**
 * Shape-validate one value against its declared kind. Returns an error
 * message, or null when valid.
 *
 * The table decides (field-kinds.v1.json), in the order its README states and
 * Rust's `validate_value` follows: `null` (delete) always passes; a computed
 * kind refuses every write; a derived relation or person (`from`) refuses,
 * because writing the mirror would store what the owning side immediately
 * contradicts (M12.4, M16.13b); the value must be one of the kind's atoms; a
 * range must have a real start, real endpoints and an end that does not come
 * first; and a `limit: 1` link field holds one link (M20.3). Email and phone
 * check shape only: Notion validates neither, and refusing a frontmatter
 * write is a far worse failure than an address that will not linkify.
 */
export function validateValue(def: FieldDef, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const facts = kindFacts(def.kind);
  const say = (key: MessageKey): string =>
    (facts.messages[key] ?? facts.messages.shape).split('{name}').join(def.name);
  if (facts.computed) return say('shape');
  if (facts.links && def.from !== undefined) return say('derived');
  const atom = facts.accepts.find((a) => atomHolds(a, value));
  if (atom === undefined) return say('shape');
  if (atom === 'date_range') {
    const fault = dateRangeFault(value);
    if (fault !== null) return say(fault);
  }
  if (facts.links && def.limit === 1 && Array.isArray(value) && value.length > 1) {
    return say('limit_one');
  }
  return null;
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
 * The adoption wizard's lenient converter (M12.6, engine/adopt.ts): the value
 * a record would store to fit a kind the wizard proposes, or null when the
 * old value has no reading in it, and the wizard then clears that key.
 *
 * Change type does not use it. Since M60.5 a kind change reads values through
 * engine/castRules.ts, which reads numbers strictly, never clears a value, and
 * turns a change some values would not survive into a new property. This
 * converter stays lenient (it strips digits out of '$1,200') until the wizard
 * gets the same treatment.
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
    case 'repeat':
      return typeof raw === 'string' && parseRepeat(raw)?.kind === 'rule' ? raw : null;
    case 'formula':
    case 'rollup':
    case 'created_time':
    case 'last_edited_time':
      // Computed kinds ignore stored values; leave the frontmatter alone.
      return raw;
    default: {
      // The return type is `unknown`, and `undefined` is assignable to it —
      // so a kind added to the union and forgotten HERE compiled clean, and
      // the caller (Change type, until M60.5) pushed the undefined through
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
  values.flatMap((value) => {
    // Number(null), Number(false) and Number([]) are zero; none records a
    // measured number (CV-05). Numeric scalar text remains readable.
    if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return [];
    const number = Number(value);
    return Number.isFinite(number) ? [number] : [];
  });

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
  ctx?: {
    fieldDef: (entry: Entry, property: string) => FieldDef | null;
    statuses: (entry: Entry) => readonly StatusDef[];
  },
): string {
  // M3.5: forward (`relation:`) and reverse (`from:`) sources both resolve
  // here, so a parent can aggregate children that point at it.
  const spec = rollupSpec(def);
  const targets = spec === null ? [] : childrenOf(entry, spec, entries, index);
  const calc: RollupCalc = def.calculate ?? 'count';
  if (calc === 'count') return String(targets.length);
  const prop = def.property ?? '';
  if (calc === 'percent_done') {
    let counted = 0;
    let done = 0;
    for (const target of targets) {
      const kind = ctx?.fieldDef(target, prop)?.kind;
      const raw = target.properties[prop];
      if (kind === 'checkbox') {
        counted += 1;
        if (raw === true) done += 1;
      } else if (kind === 'status') {
        const value = Array.isArray(raw) ? raw[0] : raw;
        const group = ctx?.statuses(target).find((status) => status.id === value)?.group;
        if (group === 'closed') continue;
        counted += 1;
        if (group === 'done') done += 1;
      }
    }
    return counted === 0 ? '' : String(Math.round((done / counted) * 10_000) / 100);
  }
  const values = targets
    .map((t) => t.properties[prop])
    .filter((v) => v !== undefined && v !== null && v !== '');
  if (values.length === 0) return '';
  switch (calc) {
    case 'show':
      return values.map(String).join(', ');
    // A sum over values none of which is a number is blank, like the other
    // three (M60.1, CV-05): a 0 there claims a measured zero nobody recorded.
    case 'sum':
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

/**
 * An instant → this machine's wall time as 'YYYY-MM-DD HH:MM' (display for
 * the created and last-edited cells). Read through the shared grammar
 * (M61.8), so `2026-07-24T09:30:12Z` prints 02:30 in Los Angeles and 19:30 in
 * Sydney; text that is not an instant keeps its first sixteen characters.
 */
export function formatTimestamp(iso: string): string {
  const read = parseDateText(iso);
  if (read !== null && read.instant && read.time !== null) return `${read.date} ${read.time}`;
  return iso.length >= 16 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso;
}
