/**
 * What a property's values become when its kind changes (M60.5, DATA-2).
 *
 * Change type used to convert every record's value leniently and CLEAR the
 * ones it could not read, after a confirm that gave only a count. This module
 * replaces that with three answers per pair of kinds, a dry run that counts
 * and shows what would not convert, and a second way out: when some values
 * would not survive, the change becomes "Convert into a new property", which
 * writes the values that do convert under a new key and leaves the old one
 * exactly as it was. Nothing here ever empties a value.
 *
 * `CASTS` is the table: for each source kind, one letter per target kind in
 * `FIELD_KINDS` order. S (safe) converts every value; C (checked) converts
 * value by value and may fail some; N (never) refuses while the field holds a
 * value. It is TypeScript-only behaviour: no Rust reader converts kinds, so it
 * is code, not a shared artifact.
 */

import { isDateText } from './dateGrammar';
import { groupingUses, ruleAt, viewRefs } from './fieldRefs';
import {
  CREATABLE_PROPERTY_KINDS,
  GROUPABLE_KINDS,
  kindMeta,
  normalizeUrl,
  optionId,
  validateValue,
} from './properties';
import { humanize } from './schema';
import { serializeOptions } from './typeCatalog';
import { FIELD_KINDS } from './types';
import type {
  Entry,
  FieldDef,
  FieldKind,
  FieldOption,
  FilterGroup,
  FilterOp,
  FilterRule,
  ListFile,
  Schema,
  ViewDefinition,
} from './types';
import { filterOpsFor } from './viewFilters';
import { resolveLink } from './wikilink';

export type Cast = 'safe' | 'checked' | 'never';

/** A source row that reads its values as text: text, email, phone, and the
 * computed kinds, whose stale stored values are just text. */
const TEXT_ROW = 'SCCCCSSCCCCSSNNNN';

/**
 * The cast table (Appendix C of the M60 plan). Columns in `FIELD_KINDS`
 * order: text number checkbox date daterange select multiselect status
 * person relation url email phone files rollup created_time last_edited_time.
 */
export const CASTS = {
  text: TEXT_ROW,
  number: 'SSNNNSSCNNNNSNNNN',
  checkbox: 'SNSNNNNNNNNNNNNNN',
  date: 'SNNSSNNNNNNNNNNNN',
  daterange: 'SNNCSNNNNNNNNNNNN',
  select: 'SCCCNSSCCCCSSNNNN',
  multiselect: 'SCCCNCSCCCCCCNNNN',
  status: 'SNNNNSSSNNNNNNNNN',
  person: 'NNNNNNNNSSNNNNNNN',
  relation: 'NNNNNNNNSSNNNNNNN',
  url: 'SNNNNSSCNNSSSNNNN',
  email: TEXT_ROW,
  phone: TEXT_ROW,
  files: 'SNNNNNNNNNNNNSNNN',
  rollup: 'SCCCCSSCCCCSSNSNN',
  created_time: 'SCCCCSSCCCCSSNNSN',
  last_edited_time: 'SCCCCSSCCCCSSNNNS',
} satisfies Record<FieldKind, string>;

for (const [kind, row] of Object.entries(CASTS)) {
  if (row.length !== FIELD_KINDS.length || /[^SCN]/.test(row)) {
    throw new Error(`castRules: the ${kind} row must be ${FIELD_KINDS.length} of S, C or N`);
  }
}

const CELL: Record<string, Cast> = { S: 'safe', C: 'checked', N: 'never' };

/**
 * One pair's answer. The same kind is safe; a field holding no value is safe
 * to change into any stored kind and never into a computed one; otherwise
 * the table decides.
 */
export function castRule(from: FieldKind, to: FieldKind, filled: boolean): Cast {
  if (from === to) return 'safe';
  if (!filled) return kindMeta(to).computed ? 'never' : 'safe';
  return CELL[CASTS[from][FIELD_KINDS.indexOf(to)]];
}

/** The kinds Change type offers: creatable and stored. */
function offeredKinds(): FieldKind[] {
  return CREATABLE_PROPERTY_KINDS.filter((k) => !k.computed).map((k) => k.kind);
}

const label = (kind: FieldKind): string => kindMeta(kind).label;

function joinOr(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
}

/** "{From} can become only {targets}.": the row's own words. */
export function neverReason(from: FieldKind): string {
  const targets = offeredKinds().filter(
    (to) => to !== from && castRule(from, to, true) !== 'never',
  );
  return `${label(from)} can become only ${joinOr(targets.map(label))}.`;
}

// --- values -----------------------------------------------------------------

/** Undefined, null, '', [] and a range with no ends hold nothing. */
export function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') {
    const r = value as { start?: unknown; end?: unknown };
    return (r.start ?? '') === '' && (r.end ?? '') === '';
  }
  return false;
}

/** A record's stored value for a field: wikilink targets come back from the
 * scanner bracket-stripped (CV-09), so they are re-wrapped for disk. */
export function storedValue(record: Entry, field: string): unknown {
  const targets = record.relationships[field];
  if (targets !== undefined) return targets.map((t) => `[[${t}]]`);
  return record.properties[field];
}

export interface ConvertCtx {
  /** The kind the value is stored as now. */
  from: FieldKind;
  field: string;
  record: Entry;
  schema: Schema;
  entries: Entry[];
  /** The field's declaration today, for its option labels. */
  def?: FieldDef;
}

export type Converted = { ok: true; value: unknown } | { ok: false };

const FAIL: Converted = { ok: false };
const ok = (value: unknown): Converted => ({ ok: true, value });

/** Plain numbers only: '007', '1,200', '$5', '1e3' and 'v2' are not numbers. */
const STRICT_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const YES = new Set(['yes', 'true', 'x', 'on', '1']);
const NO = new Set(['no', 'false', 'off', '0']);
const RANGE_SPLIT = /\s*(?:→|->|\.\.|,)\s*/;
const URL_SHAPE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;

function rangeOf(raw: unknown): { start: string; end: string | null } | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as { start?: unknown; end?: unknown };
  if (typeof r.start !== 'string' || r.start.trim() === '') return null;
  const end = typeof r.end === 'string' && r.end.trim() !== '' ? r.end.trim() : null;
  return { start: r.start.trim(), end };
}

/** One value: a scalar, or the only item of a list. */
function scalarOf(raw: unknown): string | number | boolean | null {
  const v = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : null) : raw;
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null;
}

/** What the value reads as, the way a cell shows it: option and status
 * labels, Yes or No, a range as "start → end". */
function textOf(raw: unknown, ctx: ConvertCtx): string | null {
  if (ctx.from === 'select' || ctx.from === 'multiselect' || ctx.from === 'status') {
    const shown = ctx.schema.resolveField(ctx.record, ctx.field).display;
    if (shown !== '') return shown;
  }
  if (typeof raw === 'boolean') return raw ? 'Yes' : 'No';
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : null;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map(String).join(', ');
  const range = rangeOf(raw);
  if (range === null) return null;
  return range.end === null || range.end === range.start
    ? range.start
    : `${range.start} → ${range.end}`;
}

function optionLabel(ctx: ConvertCtx, id: string): string | null {
  return ctx.def?.options?.find((o) => o.id === id)?.label ?? null;
}

function toStatus(raw: unknown, ctx: ConvertCtx): Converted {
  const s = scalarOf(raw);
  if (typeof s !== 'string' && typeof s !== 'number') return FAIL;
  const candidates = [String(s)];
  const shown = optionLabel(ctx, String(s));
  if (shown !== null) candidates.push(shown);
  const chain = ctx.schema.statusSetFor(ctx.record);
  for (const c of candidates) {
    const lower = c.trim().toLowerCase();
    const hit =
      chain.find((st) => st.id === c) ??
      chain.find((st) => st.id === optionId(c)) ??
      chain.find((st) => st.label.trim().toLowerCase() === lower);
    if (hit !== undefined) return ok(hit.id);
  }
  return FAIL;
}

function toLinks(raw: unknown, ctx: ConvertCtx): Converted {
  if (ctx.from === 'person' || ctx.from === 'relation') return ok(raw);
  const items = Array.isArray(raw) ? raw.map(String) : [String(scalarOf(raw) ?? '')];
  const names = items
    .flatMap((v) => v.split(','))
    .map((v) => v.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').trim())
    .filter((v) => v !== '');
  if (names.length === 0) return FAIL;
  if (names.some((n) => resolveLink(n, ctx.entries) === null)) return FAIL;
  return ok(names.map((n) => `[[${n}]]`));
}

function convertRaw(raw: unknown, to: FieldKind, ctx: ConvertCtx): Converted {
  switch (to) {
    case 'text': {
      const t = textOf(raw, ctx);
      return t === null ? FAIL : ok(t);
    }
    case 'email':
    case 'phone': {
      if (Array.isArray(raw) && raw.length !== 1) return FAIL;
      const t = textOf(raw, ctx);
      return t === null ? FAIL : ok(t);
    }
    case 'url': {
      const t = textOf(raw, ctx);
      if (t === null) return FAIL;
      const url = normalizeUrl(t);
      return URL_SHAPE.test(url) ? ok(url) : FAIL;
    }
    case 'number': {
      const s = scalarOf(raw);
      if (typeof s === 'number') return Number.isFinite(s) ? ok(s) : FAIL;
      if (typeof s !== 'string') return FAIL;
      const t = s.trim();
      return STRICT_NUMBER.test(t) ? ok(Number(t)) : FAIL;
    }
    case 'checkbox': {
      const s = scalarOf(raw);
      if (typeof s === 'boolean') return ok(s);
      if (s === null) return FAIL;
      const word = String(s).trim().toLowerCase();
      if (YES.has(word)) return ok(true);
      if (NO.has(word)) return ok(false);
      return FAIL;
    }
    case 'date': {
      const range = rangeOf(raw);
      if (range !== null) {
        if (range.end !== null && range.end !== range.start) return FAIL;
        return isDateText(range.start) ? ok(range.start) : FAIL;
      }
      const s = scalarOf(raw);
      if (typeof s !== 'string') return FAIL;
      const t = s.trim();
      return isDateText(t) ? ok(t) : FAIL;
    }
    case 'daterange': {
      const s = scalarOf(raw);
      if (typeof s !== 'string') return FAIL;
      const parts = s.trim().split(RANGE_SPLIT);
      if (parts.length > 2 || !parts.every((p) => isDateText(p))) return FAIL;
      return ok({ start: parts[0], end: parts[1] ?? null });
    }
    case 'select': {
      const s = scalarOf(raw);
      if (typeof s === 'string') return ok(s);
      if (typeof s === 'number') return ok(String(s));
      return FAIL;
    }
    case 'multiselect': {
      if (Array.isArray(raw)) return ok(raw.map(String));
      const s = scalarOf(raw);
      if (typeof s === 'string' || typeof s === 'number') return ok([String(s)]);
      return FAIL;
    }
    case 'status':
      return toStatus(raw, ctx);
    case 'person':
    case 'relation':
      return toLinks(raw, ctx);
    case 'files':
      return ctx.from === 'files' && Array.isArray(raw) ? ok(raw) : FAIL;
    case 'rollup':
    case 'created_time':
    case 'last_edited_time':
      return FAIL;
    default: {
      const exhaustive: never = to;
      return exhaustive;
    }
  }
}

/**
 * One stored value read as `to`, or `{ok: false}` when it has no reading.
 * A value is never coerced into a shape the new kind's validator refuses, so
 * every `ok` value is one a write accepts.
 */
export function convertValue(raw: unknown, to: FieldKind, ctx: ConvertCtx): Converted {
  if (isEmptyValue(raw)) return FAIL;
  const out = convertRaw(raw, to, ctx);
  if (!out.ok) return out;
  return validateValue({ name: ctx.field, kind: to }, out.value) === null ? out : FAIL;
}

// --- view filters -----------------------------------------------------------

function isRule(node: FilterRule | FilterGroup): node is FilterRule {
  return 'field' in node && 'op' in node;
}

function stripGroup(
  group: FilterGroup,
  field: string,
  fits: ReadonlySet<FilterOp>,
): { group: FilterGroup | null; stripped: number } {
  const all = 'all' in group;
  const kids = all ? group.all : group.any;
  let stripped = 0;
  const next: (FilterRule | FilterGroup)[] = [];
  for (const kid of kids) {
    if (isRule(kid)) {
      if (kid.field === field && !fits.has(kid.op)) stripped += 1;
      else next.push(kid);
      continue;
    }
    const inner = stripGroup(kid, field, fits);
    stripped += inner.stripped;
    if (inner.group !== null) next.push(inner.group);
  }
  if (stripped === 0) return { group, stripped: 0 };
  if (next.length === 0) return { group: null, stripped };
  return { group: all ? { all: next } : { any: next }, stripped };
}

/**
 * Drop the filter rules on `field` whose operator `to` cannot offer, in each
 * view's filters, its dashboard's global filter and every widget's own
 * filter. A group the stripping empties goes too; an emptied root is null.
 * A rule whose operator fits keeps its value as written.
 */
export function stripMisfitTests(
  views: ViewDefinition[],
  field: string,
  to: FieldKind,
): { views: ViewDefinition[]; stripped: number } {
  const fits = new Set(filterOpsFor(to));
  let total = 0;
  const strip = (g: FilterGroup | null | undefined) => {
    if (g === null || g === undefined) return { group: g ?? null, stripped: 0 };
    return stripGroup(g, field, fits);
  };
  const next = views.map((view) => {
    let count = 0;
    const filters = strip(view.filters);
    count += filters.stripped;
    let presentation = view.presentation;
    const dash = presentation.dashboard;
    if (dash !== undefined) {
      const global = strip(dash.global);
      count += global.stripped;
      let widgetsChanged = false;
      const rows = dash.rows.map((row) => {
        let rowChanged = false;
        const widgets = row.widgets.map((w) => {
          const own = strip(w.filter);
          if (own.stripped === 0) return w;
          count += own.stripped;
          rowChanged = true;
          const copy = { ...w };
          if (own.group === null) delete copy.filter;
          else copy.filter = own.group;
          return copy;
        });
        if (!rowChanged) return row;
        widgetsChanged = true;
        return { ...row, widgets };
      });
      if (global.stripped > 0 || widgetsChanged) {
        const nextDash = { ...dash, rows };
        if (global.stripped > 0) {
          if (global.group === null) delete nextDash.global;
          else nextDash.global = global.group;
        }
        presentation = { ...presentation, dashboard: nextDash };
      }
    }
    if (count === 0) return view;
    total += count;
    return { ...view, filters: filters.group, presentation };
  });
  return { views: total === 0 ? views : next, stripped: total };
}

/**
 * How many filter rules on `field` in `views` the kind `to` cannot express,
 * counted from `viewRefs` (M60.2): the view filters, the dashboard's global
 * filter and every widget's own. Nothing is rewritten; List files keep them
 * for the view check to name.
 */
function misfitRefs(views: ViewDefinition[], field: string, to: FieldKind): number {
  const fits = new Set(filterOpsFor(to));
  let n = 0;
  for (const view of views) {
    for (const ref of viewRefs(view)) {
      if (ref.name !== field || ref.filterPath === undefined) continue;
      const rule = ruleAt(view, ref);
      if (rule !== null && !fits.has(rule.op)) n += 1;
    }
  }
  return n;
}

// --- the dry run ------------------------------------------------------------

/** What Change type needs to preview a field's kind change. */
export interface KindChangeCtx {
  typeName: string;
  /** The field's key as the Type doc declares it. */
  field: string;
  /** Its declaration today. */
  def: FieldDef;
  entries: Entry[];
  schema: Schema;
  /** Every List file; those over the type are where misfit filters are
   * counted rather than stripped. */
  lists: ListFile[];
  /** Keys a property may never take (a Type doc's own keys). */
  reserved: ReadonlySet<string>;
}

export interface KindChangeWrite {
  path: string;
  value: unknown;
}

export interface KindChangePreview {
  to: FieldKind;
  /** The answer after the dry run: a table N, every value failing and an
   * in-place grouping block are all `never`. */
  cast: Cast;
  /** Why the change is refused; null when it is not. */
  reason: string | null;
  /** Records of the type holding a value. */
  holding: number;
  converts: number;
  failures: number;
  /** Up to three values that do not convert, each cut and in curly quotes. */
  examples: string[];
  /** In place: the records whose value changes. As a new property: every
   * record that converts. */
  writes: KindChangeWrite[];
  /** The option list a select or multi-select gets, seeded from the written
   * values (as `serializeOptions` spells it); null for every other kind. */
  options: unknown[] | null;
  /** Filter rules on the Type doc's views the new kind cannot express. */
  stripped: number;
  /** Such rules in List files over the type, left for the view check. */
  flaggedElsewhere: number;
  /** The key a Convert into a new property declares. */
  newName: string;
  /** Every value converts and nothing blocks an in-place change. */
  lossless: boolean;
}

/** `${field}_${kind}`, then `_2`, `_3`, … until no taken key (ignoring case)
 * holds it. */
export function newPropertyName(field: string, to: FieldKind, taken: Iterable<string>): string {
  const held = new Set([...taken].map((k) => k.toLowerCase()));
  const base = `${field}_${to}`;
  let name = base;
  for (let n = 2; held.has(name.toLowerCase()); n += 1) name = `${base}_${n}`;
  return name;
}

const MAX_EXAMPLES = 3;
const EXAMPLE_CHARS = 40;

function example(text: string): string {
  const cut = text.length > EXAMPLE_CHARS ? `${text.slice(0, EXAMPLE_CHARS - 1)}…` : text;
  return `“${cut}”`;
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function seedOptions(
  ctx: KindChangeCtx,
  converted: { record: Entry; value: unknown }[],
): unknown[] | null {
  const seeded: FieldOption[] = [];
  const seen = new Set<string>();
  for (const { record, value } of converted) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (typeof v !== 'string' || v === '' || seen.has(v)) continue;
      seen.add(v);
      const status =
        ctx.def.kind === 'status'
          ? ctx.schema.statusSetFor(record).find((s) => s.id === v)
          : undefined;
      const option = ctx.def.options?.find((o) => o.id === v);
      const from = status ?? option;
      seeded.push({ id: v, label: from?.label ?? v, color: from?.color ?? null });
    }
  }
  return seeded.length === 0 ? null : serializeOptions(seeded);
}

function recordsOf(ctx: KindChangeCtx): Entry[] {
  return ctx.entries.filter((e) => e.type === ctx.typeName);
}

/** Preview changing the field to `to`: who holds a value, what converts,
 * what would be written, and whether it is refused and why. */
export function dryRunKindChange(ctx: KindChangeCtx, to: FieldKind): KindChangePreview {
  const from = ctx.def.kind;
  const records = recordsOf(ctx);
  const holders = records.filter((r) => !isEmptyValue(storedValue(r, ctx.field)));
  const holding = holders.length;
  const taken = [
    ...(ctx.schema.types.get(ctx.typeName)?.fields.map((f) => f.name) ?? []),
    ctx.field,
    ...ctx.reserved,
    ...records.flatMap((r) => [...Object.keys(r.properties), ...Object.keys(r.relationships)]),
  ];
  const views = ctx.schema.types.get(ctx.typeName)?.views ?? [];
  const elsewhere = ctx.lists
    .filter((l) => l.definition.source.type === ctx.typeName)
    .reduce((n, l) => n + misfitRefs(l.definition.views, ctx.field, to), 0);
  const base: KindChangePreview = {
    to,
    cast: castRule(from, to, holding > 0),
    reason: null,
    holding,
    converts: 0,
    failures: 0,
    examples: [],
    writes: [],
    options: null,
    stripped: stripMisfitTests(views, ctx.field, to).stripped,
    flaggedElsewhere: elsewhere,
    newName: newPropertyName(ctx.field, to, taken),
    lossless: false,
  };
  if (base.cast === 'never') {
    return {
      ...base,
      reason: holding > 0 ? neverReason(from) : `${label(to)} is computed and holds no values.`,
    };
  }

  const converted: { record: Entry; value: unknown; changed: boolean }[] = [];
  const failed: string[] = [];
  for (const record of holders) {
    const raw = storedValue(record, ctx.field);
    const conv: ConvertCtx = {
      from,
      field: ctx.field,
      record,
      schema: ctx.schema,
      entries: ctx.entries,
      def: ctx.def,
    };
    const out = from === to ? ok(raw) : convertValue(raw, to, conv);
    if (out.ok) {
      converted.push({ record, value: out.value, changed: !sameValue(out.value, raw) });
    } else {
      const shown = textOf(raw, conv) ?? String(raw);
      if (failed.length < MAX_EXAMPLES && !failed.includes(example(shown))) {
        failed.push(example(shown));
      }
    }
  }
  const converts = converted.length;
  const failures = holding - converts;
  if (holding > 0 && converts === 0) {
    return {
      ...base,
      cast: 'never',
      failures,
      examples: failed,
      reason: `None of its ${holding} ${holding === 1 ? 'value' : 'values'} can be read as ${label(to)}.`,
    };
  }
  const lossless = failures === 0;
  if (
    lossless &&
    !GROUPABLE_KINDS.has(to) &&
    groupingUses(ctx.entries, ctx.lists, ctx.typeName, ctx.field).length > 0
  ) {
    return {
      ...base,
      cast: 'never',
      converts,
      reason: `A view groups by ${humanize(ctx.field)}; change its grouping first.`,
    };
  }
  const writes = converted
    .filter((c) => !lossless || c.changed)
    .map((c) => ({ path: c.record.path, value: c.value }));
  return {
    ...base,
    converts,
    failures,
    examples: failed,
    writes,
    options: to === 'select' || to === 'multiselect' ? seedOptions(ctx, converted) : null,
    lossless,
  };
}

const MENU_MEMO = new WeakMap<
  Entry[],
  Map<string, { lists: ListFile[]; schema: Schema; previews: KindChangePreview[] }>
>();

/**
 * A preview for every kind Change type offers except the current one,
 * memoized per (entries, field): a menu that opens runs one dry run per kind
 * over every record of the type, and the store replaces `entries` on change.
 */
export function kindChangeMenu(ctx: KindChangeCtx): KindChangePreview[] {
  const key = JSON.stringify([ctx.typeName, ctx.field, ctx.def.kind]);
  let memo = MENU_MEMO.get(ctx.entries);
  if (memo === undefined) {
    memo = new Map();
    MENU_MEMO.set(ctx.entries, memo);
  }
  const hit = memo.get(key);
  if (hit !== undefined && hit.lists === ctx.lists && hit.schema === ctx.schema) {
    return hit.previews;
  }
  const previews = offeredKinds()
    .filter((k) => k !== ctx.def.kind)
    .map((k) => dryRunKindChange(ctx, k));
  memo.set(key, { lists: ctx.lists, schema: ctx.schema, previews });
  return previews;
}

/** The second line under a kind in the Change type list. */
export function kindChangeHint(p: KindChangePreview): string {
  if (p.cast === 'never') return p.reason ?? '';
  if (!p.lossless) return `${p.failures} won't convert · Converts into a new property`;
  if (p.holding > 0) return `All ${p.holding} convert`;
  return '';
}
