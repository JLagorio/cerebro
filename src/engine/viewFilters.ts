import {
  DEFAULT_TIME_FORMAT,
  formatDateValue,
  makeDateValue,
  parseDateProperty,
  parseEndpoint,
  toIsoDate,
} from './dates';
import { kindMeta } from './properties';
import { FILTER_OPS } from './types';
import type {
  Entry,
  FieldDef,
  FieldKind,
  FieldOption,
  FilterFamily,
  FilterGroup,
  FilterOp,
  FilterRule,
  Scalar,
  Schema,
} from './types';

/**
 * How many values an operator takes (M16.25).
 *
 * The builder rendered a bare text `Input` for every operator, so `is_between`
 * had nowhere to put its second bound and `is_empty` showed a box that did
 * nothing. Arity is what the value editor switches on.
 */
export type FilterArity = 'none' | 'one' | 'two' | 'list';

export interface FilterOpMeta {
  label: string;
  arity: FilterArity;
}

/**
 * Every operator's label and arity. `satisfies Record<FilterOp, …>` so an
 * operator added to the union without a label is a build error rather than a
 * blank line in the menu.
 *
 * Labels are Notion's, verbatim where Notion has one.
 */
const OP_META = {
  equals: { label: 'is', arity: 'one' },
  not_equals: { label: 'is not', arity: 'one' },
  contains: { label: 'contains', arity: 'one' },
  does_not_contain: { label: 'does not contain', arity: 'one' },
  starts_with: { label: 'starts with', arity: 'one' },
  ends_with: { label: 'ends with', arity: 'one' },
  any_of: { label: 'is any of', arity: 'list' },
  none_of: { label: 'is none of', arity: 'list' },
  gt: { label: 'is greater than', arity: 'one' },
  gte: { label: 'is at least', arity: 'one' },
  lt: { label: 'is less than', arity: 'one' },
  lte: { label: 'is at most', arity: 'one' },
  before: { label: 'is before', arity: 'one' },
  after: { label: 'is after', arity: 'one' },
  on_or_before: { label: 'is on or before', arity: 'one' },
  on_or_after: { label: 'is on or after', arity: 'one' },
  is_between: { label: 'is between', arity: 'two' },
  is_empty: { label: 'is empty', arity: 'none' },
  is_not_empty: { label: 'is not empty', arity: 'none' },
} satisfies Record<FilterOp, FilterOpMeta>;

export const filterOpMeta = (op: FilterOp): FilterOpMeta => OP_META[op];
export const filterOpLabel = (op: FilterOp): string => OP_META[op].label;
export const filterOpArity = (op: FilterOp): FilterArity => OP_META[op].arity;

/**
 * Every kind offers these two, including `checkbox`.
 *
 * Notion's checkbox filter is is/is-not only, but a frontmatter key can be
 * genuinely ABSENT, which is a state neither of those describes — and every
 * surface that seeds a rule seeds `is_not_empty` on purpose, because it is the
 * one operator that excludes nothing (M15: `equals ''` blanked the canvas the
 * instant "Add filter" was pressed). A kind that cannot express it would need
 * a seed that hides records before the user has chosen anything.
 */
const UNIVERSAL: FilterOp[] = ['is_empty', 'is_not_empty'];

/**
 * Which operators each family offers, in menu order.
 *
 * The family→operators half of the answer; the kind→family half is a flag on
 * `KIND_META` so `satisfies Record<FieldKind, …>` forces every new kind to
 * declare one. Neither half restates the other, and neither is a second copy
 * of the kind list.
 */
const FAMILY_OPS = {
  text: [
    'contains',
    'does_not_contain',
    'equals',
    'not_equals',
    'starts_with',
    'ends_with',
    ...UNIVERSAL,
  ],
  number: ['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 'is_between', ...UNIVERSAL],
  date: ['equals', 'before', 'after', 'on_or_before', 'on_or_after', 'is_between', ...UNIVERSAL],
  choice: ['equals', 'not_equals', 'any_of', 'none_of', ...UNIVERSAL],
  multi: ['contains', 'does_not_contain', 'any_of', 'none_of', ...UNIVERSAL],
  boolean: ['equals', 'not_equals', ...UNIVERSAL],
  // A rollup's values are whatever its `calculate` produces — a count is a
  // number, `earliest` is a date, `show` is prose. The kind alone cannot say,
  // so it offers everything rather than guessing wrong in one direction.
  any: [...FILTER_OPS],
} satisfies Record<FilterFamily, FilterOp[]>;

/** The operators a filter may offer on a field of this kind (M16.25). */
export function filterOpsFor(kind: FieldKind): FilterOp[] {
  return [...FAMILY_OPS[kindMeta(kind).filters]];
}

// --- the options a value editor can offer (M16.29) ---------------------------

/**
 * The status set a filter on this view should offer.
 *
 * The same chain `schema.statusSetFor` walks, minus the per-RECORD project
 * override: a view-level filter has no record to resolve one against, and
 * `statusSetForProject(null)` is exactly the app defaults that chain ends in.
 *
 * A typeless ("Everything") view gets nothing, on purpose — its records may
 * come from several types, and offering one type's statuses as though they
 * were the vault's is the M12.2 mistake that took a milestone to undo.
 */
export function filterStatusSet(
  schema: Schema | undefined,
  sourceType: string | null,
): FieldOption[] {
  if (schema === undefined || sourceType === null) return NO_STATUSES;
  const own = schema.types.get(sourceType)?.statuses ?? NO_STATUSES;
  return own.length > 0 ? own : schema.statusSetForProject(null);
}

/** Shared so a caller can memoize on the result — every branch above returns
 * an array the schema already owns, and this is the empty one. */
const NO_STATUSES: FieldOption[] = [];

/**
 * The field defs a filter surface should offer, each carrying the options its
 * value editor needs (M16.29).
 *
 * A `status` field declares no `options:` — the option set is the TYPE's
 * `statuses:`, which every other surface resolves per record. A filter has no
 * record, so `def.options` was empty and the typed editor fell through to its
 * text-box last resort: to filter by status you had to know the slug and type
 * it, and the rule you had written read back as `progress`.
 *
 * Resolved ONCE, where view context enters the filter bar, so the nested rows
 * and the top-level ones are looking at the same array — which is what makes
 * them behave the same without a second copy of the editor.
 */
export function filterFieldDefs<T extends FieldDef>(
  fields: readonly T[],
  statuses: readonly FieldOption[],
): T[] {
  if (statuses.length === 0) return [...fields];
  return fields.map((f) =>
    // A field that HAS options keeps them: the status set is the fallback for
    // the kind that cannot carry its own, never an override of a declaration.
    kindMeta(f.kind).statusSet === true && (f.options ?? []).length === 0
      ? { ...f, options: [...statuses] }
      : f,
  );
}

/**
 * The kind a filter should treat `field` as.
 *
 * `type` and `title` are filterable — `fieldValue` resolves them off the entry
 * itself — but no `FieldDef` declares them, and neither does an undeclared
 * frontmatter key. All of them are prose, which is also the safest default: a
 * text field offers the operators that read a string, and reading a number as
 * a string still orders it correctly for the digits it holds.
 */
export function filterKindFor(
  field: string,
  fields: readonly { name: string; kind: FieldKind }[],
): FieldKind {
  return fields.find((f) => f.name === field)?.kind ?? 'text';
}

/**
 * Keep a rule coherent when its operator changes.
 *
 * Switching `is any of ["a","b"]` to `is` used to leave the array in place, so
 * the rule read "Status is a, b" and matched nothing; switching away from
 * `is empty` left a dead `value` in the YAML. Reshaping here means the value
 * on disk always has the shape its operator reads.
 */
export function coerceRuleToOp(rule: FilterRule, op: FilterOp): FilterRule {
  const next: FilterRule = { field: rule.field, op };
  const list = valueList(rule.value);
  switch (filterOpArity(op)) {
    case 'none':
      return next;
    case 'list':
      next.value = list;
      return next;
    case 'two':
      next.value = [list[0] ?? '', list[1] ?? ''];
      return next;
    default:
      next.value = list[0] ?? '';
      return next;
  }
}

/** An operator this kind supports, preferring the one already chosen. */
export function coerceOpForKind(op: FilterOp, kind: FieldKind): FilterOp {
  const ops = filterOpsFor(kind);
  return ops.includes(op) ? op : (ops.find((o) => o === 'is_not_empty') ?? ops[0]);
}

/**
 * A starter rule for `field` that hides nothing (M15's invariant, generalised
 * to every kind by M16.25 — three call sites hardcoded `is_not_empty`, which
 * is not an operator every family had to offer until this made it one).
 */
export function seedFilterRule(field: string, kind: FieldKind = 'text'): FilterRule {
  return { field, op: coerceOpForKind('is_not_empty', kind) };
}

function valueList(value: FilterRule['value']): Scalar[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  return value === '' ? [] : [value];
}

/**
 * `0` and `false` are values. Absence is only undefined, null, or the empty
 * string the editors seed — anything looser would make "Weight is 0" and
 * "Done is unchecked" stop filtering.
 */
const isPresent = (v: Scalar | undefined | null): boolean =>
  v !== undefined && v !== null && v !== '';

/**
 * Whether a rule carries the values its operator reads (M16.29).
 *
 * Half of a rule is not a narrower rule, it is an unfinished one. Picking
 * "is before" on `Due` and not yet a date left `compareValues` with an empty
 * target, which is not comparable to anything — so every ordered operator
 * answered false for every record and the grid dropped from 45 rows to
 * "Nothing matches these filters" before the user had said what to match.
 * Same for `is any of` with nothing ticked, and for `is between` with one
 * bound filled.
 *
 * `is_empty`/`is_not_empty` are the asymmetry: they are COMPLETE with no
 * value, and must keep applying the instant they are chosen. Arity already
 * knows the difference, so nothing here restates the operator list.
 */
export function filterRuleIsReady(rule: FilterRule): boolean {
  const arity = filterOpArity(rule.op);
  if (arity === 'none') return true;
  const values = Array.isArray(rule.value) ? rule.value : [rule.value];
  if (arity === 'two') return values.length >= 2 && isPresent(values[0]) && isPresent(values[1]);
  return values.some(isPresent);
}

/**
 * A date bound in the FIELD's persisted format, or null if it is not one
 * (M16.29).
 *
 * `due` carried `dateFormat: dmy` and the grid rendered `18/08/2026`, while
 * every filter surface printed the raw stored `2026-08-03` — three spellings
 * of one date on one screen. A format setting that the column obeys and the
 * filter on that column ignores is not a setting.
 *
 * Gated on the KIND's filter family, so a text field that happens to hold
 * something date-shaped still reads back exactly as it was written. Defaults
 * match M16.14: absent `dateFormat` means short, absent `timeFormat` means
 * a 12-hour clock.
 */
export function filterDateLabel(
  value: Scalar,
  def: FieldDef,
  today: string = toIsoDate(new Date()),
): string | null {
  if (kindMeta(def.kind).filters !== 'date') return null;
  const parsed = parseEndpoint(value);
  if (parsed === null) return null;
  return formatDateValue(
    {
      ...makeDateValue(parsed.date),
      startTime: parsed.time,
      format: def.dateFormat ?? 'short',
      timeFormat: def.timeFormat ?? DEFAULT_TIME_FORMAT,
    },
    today,
  );
}

/**
 * One value as the chip should say it (M16.29).
 *
 * The chip is the one place that states a rule IN WORDS, and it was stating
 * it in slugs — "Status is progress" for an option whose label is "In
 * progress" — and in storage spellings, for dates. The def is optional so a
 * caller with no schema context still gets the raw value rather than nothing.
 */
function describeFilterValue(value: Scalar, def: FieldDef | undefined): string {
  if (def === undefined) return String(value);
  const option = def.options?.find((o) => o.id === String(value));
  return option?.label ?? filterDateLabel(value, def) ?? String(value);
}

/** One rule as a chip reads it: "Due is before 2026-08-01". */
export function describeFilterRule(rule: FilterRule, label: string, def?: FieldDef): string {
  const op = filterOpLabel(rule.op);
  if (filterOpArity(rule.op) === 'none') return `${label} ${op}`;
  const list = valueList(rule.value).map((v) => describeFilterValue(v, def));
  if (list.length === 0) return `${label} ${op}…`;
  if (filterOpArity(rule.op) === 'two') return `${label} ${op} ${list[0]} and ${list[1]}`;
  return `${label} ${op} ${list.join(', ')}`;
}

// --- evaluation -------------------------------------------------------------

function fieldValue(entry: Entry, field: string): unknown {
  if (field in entry.relationships) return entry.relationships[field];
  if (field in entry.properties) return entry.properties[field];
  if (field === 'type') return entry.type;
  if (field === 'title') return entry.title;
  return undefined;
}

function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v];
}

/** Scalar equality, or membership when the field value is an array. */
function matchesEquals(v: unknown, target: unknown): boolean {
  return asList(v).some((x) => x !== undefined && x !== null && x === target);
}

/** Case-insensitive text predicate applied to any element of the value. */
function matchesText(
  v: unknown,
  target: unknown,
  test: (haystack: string, needle: string) => boolean,
): boolean {
  if (target === undefined || target === null || target === '') return false;
  const needle = String(target).toLowerCase();
  return asList(v).some(
    (x) => x !== undefined && x !== null && test(String(x).toLowerCase(), needle),
  );
}

/** Set intersection between the field value(s) and the rule value(s). */
function matchesAnyOf(v: unknown, target: unknown): boolean {
  const targets = Array.isArray(target) ? target : [target];
  return asList(v).some((x) => x !== undefined && x !== null && targets.includes(x as Scalar));
}

function firstScalar(v: unknown): unknown {
  return Array.isArray(v) ? (v.length > 0 ? v[0] : undefined) : v;
}

const asNumber = (v: unknown): number | null => {
  if (typeof v === 'boolean' || v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The comparable form of a date, at the rule's granularity (M16.14).
 *
 * A `date` property may store `YYYY-MM-DD HH:MM`, and the ordered operators
 * compared raw strings — so "due is after 2026-08-01" matched a record due
 * `2026-08-01 14:30`, because that string sorts after the bare day. A rule
 * that names no time means the DAY, and only a rule that names one compares
 * times. `parseDateProperty` reads a `{start, end}` range too, and takes its
 * start: "before" a range means before it begins.
 */
function dateKey(raw: unknown, withTime: boolean): string | null {
  const value = parseDateProperty(raw);
  if (value === null) return null;
  return withTime ? `${value.start} ${value.startTime ?? '00:00'}` : value.start;
}

/**
 * Order two values, or null when they are not comparable.
 *
 * One comparator behind every ordered operator, chosen from the VALUES rather
 * than from the field's declared kind: a rollup has no static type, and an
 * undeclared frontmatter key has no declaration at all.
 */
function compareValues(raw: unknown, target: unknown): number | null {
  const a = firstScalar(raw);
  if (a === undefined || a === null || a === '') return null;
  if (target === undefined || target === null || target === '') return null;

  const an = asNumber(a);
  const bn = asNumber(target);
  if (an !== null && bn !== null) return an === bn ? 0 : an < bn ? -1 : 1;

  const bounds = parseEndpoint(target);
  if (bounds !== null) {
    const ak = dateKey(a, bounds.time !== null);
    if (ak === null) return null;
    const bk = bounds.time === null ? bounds.date : `${bounds.date} ${bounds.time}`;
    return ak === bk ? 0 : ak < bk ? -1 : 1;
  }

  const as = String(a);
  const bs = String(target);
  return as === bs ? 0 : as < bs ? -1 : 1;
}

const ordered = (raw: unknown, target: unknown, keep: (cmp: number) => boolean): boolean => {
  const cmp = compareValues(raw, target);
  return cmp !== null && keep(cmp);
};

/**
 * `is` / `is not`: strict membership first, then the comparator (M16.25).
 *
 * Strict `===` alone was wrong in two ways the new operator set makes
 * unavoidable. A date property may store `2026-08-01 14:30` (M16.14), so
 * "Due is 2026-08-01" never matched the day it named; and every value editor
 * that is a text box hands the engine a STRING, so "Estimate is 5" never
 * matched the number `5` sitting in the frontmatter. The comparator answers
 * both without loosening anything else — it returns null, not 0, for values
 * that are not comparable at all.
 */
function matchesLoose(v: unknown, target: unknown): boolean {
  if (matchesEquals(v, target)) return true;
  return asList(v).some((x) => compareValues(x, target) === 0);
}

function evalRule(entry: Entry, rule: FilterRule): boolean {
  const v = fieldValue(entry, rule.field);
  const bounds = Array.isArray(rule.value) ? rule.value : [rule.value];
  switch (rule.op) {
    case 'is_empty':
      return isEmptyValue(v);
    case 'is_not_empty':
      return !isEmptyValue(v);
    case 'equals':
      return matchesLoose(v, rule.value);
    case 'not_equals':
      return !matchesLoose(v, rule.value);
    case 'contains':
      return matchesText(v, rule.value, (h, n) => h.includes(n));
    case 'does_not_contain':
      // A record with no value does not contain the needle, so it PASSES.
      // Notion agrees, and the alternative — an exclusion that also drops
      // every blank — is the surprise that makes people distrust filters.
      return !matchesText(v, rule.value, (h, n) => h.includes(n));
    case 'starts_with':
      return matchesText(v, rule.value, (h, n) => h.startsWith(n));
    case 'ends_with':
      return matchesText(v, rule.value, (h, n) => h.endsWith(n));
    case 'any_of':
      return matchesAnyOf(v, rule.value);
    case 'none_of':
      return !matchesAnyOf(v, rule.value);
    case 'gt':
    case 'after':
      return ordered(v, rule.value, (c) => c > 0);
    case 'gte':
    case 'on_or_after':
      return ordered(v, rule.value, (c) => c >= 0);
    case 'lt':
    case 'before':
      return ordered(v, rule.value, (c) => c < 0);
    case 'lte':
    case 'on_or_before':
      return ordered(v, rule.value, (c) => c <= 0);
    case 'is_between':
      // Inclusive at both ends. An exclusive range cannot express "this week"
      // without naming a day outside it, which is how off-by-one bugs get
      // authored into saved views.
      return ordered(v, bounds[0], (c) => c >= 0) && ordered(v, bounds[1], (c) => c <= 0);
  }
}

function isGroup(node: FilterRule | FilterGroup): node is FilterGroup {
  return 'all' in node || 'any' in node;
}

export function evaluateFilters(entry: Entry, group: FilterGroup, schema: Schema): boolean {
  const evalNode = (node: FilterRule | FilterGroup): boolean =>
    isGroup(node) ? evaluateFilters(entry, node, schema) : evalRule(entry, node);

  // A half-built rule is SKIPPED, not answered (M16.29). Answering it false
  // empties the view mid-edit; answering it true would make a Match-any group
  // holding it match every record. Dropping it out of the list is the only
  // reading of "this condition does not filter yet" that composes both ways.
  const nodes = 'all' in group ? group.all : group.any;
  const live = nodes.filter((node) => isGroup(node) || filterRuleIsReady(node));

  if ('all' in group) return live.every(evalNode);
  // `[].some()` is false, which is right for an AUTHORED empty group — the
  // builder warns in those words — and wrong for a group whose every
  // condition is still being written.
  if (live.length === 0 && nodes.length > 0) return true;
  return live.some(evalNode);
}

// --- search and limit (M16.26) ----------------------------------------------

/**
 * Free-text search WITHIN a view (M16.26).
 *
 * Deliberately not a filter rule: a filter is part of what the saved view IS
 * and persists to YAML, while search is where you are looking right now. It is
 * ephemeral state on the surface, cleared when the tab changes.
 *
 * Every term must match somewhere — title, type, any property value, any
 * relationship target, or the path. Terms are ANDed because a two-word query
 * that ORs its terms returns more rows than either word alone, which reads as
 * the search being broken.
 */
export function searchEntries(entries: Entry[], query: string): Entry[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return entries;
  return entries.filter((e) => {
    const haystack = [
      e.title,
      e.type ?? '',
      e.path,
      ...Object.values(e.properties).flatMap((v) => (Array.isArray(v) ? v : [v])),
      ...Object.values(e.relationships).flat(),
    ]
      .filter((v) => v !== null && v !== undefined)
      .join(' ')
      .toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

/**
 * The first `limit` records, or all of them (M16.26).
 *
 * A zero or negative limit means "no limit" rather than "show nothing": the
 * only way to reach one is a hand-edited YAML, and honouring it literally
 * would render an empty canvas with no control on screen able to explain it.
 */
export function limitEntries<T>(entries: T[], limit: number | undefined): T[] {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return entries;
  return entries.slice(0, Math.floor(limit));
}
