/**
 * What a saved view names that it can't apply (M60.2b, DATA-1).
 *
 * A filter on a field nobody declares or holds, on an option no longer
 * declared, or with an operator the field's kind can't take renders an empty
 * canvas that reads as "no data". A rename ripples through every stored
 * reference (M60.2), but hand-edited YAML escapes the ripple, so a view is
 * checked against its database each time it is drawn and every problem is
 * named, never only the first.
 *
 * Three things are never problems: an undeclared key a record holds (it
 * evaluates by value), a ghost value a record holds (an option retired from
 * the type while records still carry it), and an entry field the position's
 * reader resolves on its own (`ENTRY_FIELDS`).
 */

import { viewRefs, ruleAt, type RefPosition, type ViewRef } from './fieldRefs';
import { chainTypes } from './hierarchyOptions';
import { kindMeta } from './properties';
import { VIRTUAL_FIELDS, humanize } from './schema';
import { nestLevels } from './types';
import type {
  Entry,
  FieldDef,
  FieldKind,
  FilterOp,
  FilterRule,
  Scalar,
  Schema,
  ViewDefinition,
} from './types';
import { filterOpLabel, filterOpsFor, filterStatusSet } from './viewFilters';

export type ViewProblemCode =
  'unknown_field' | 'unknown_option' | 'op_does_not_fit' | 'unknown_type';

/** One thing a view names that it can't apply. */
export interface ViewProblem {
  code: ViewProblemCode;
  /** The field (or, for `unknown_type`, the type) the view names. */
  name: string;
  position: RefPosition;
  /** A filter rule's child indices, from its root group down. */
  filterPath?: number[];
  /** The dashboard widget holding it, by id. */
  widget?: string;
  /** `unknown_option`: the value no option and no record answers to. */
  option?: string;
  /** `op_does_not_fit`: the operator the field's kind can't take. */
  op?: FilterOp;
  /** `op_does_not_fit`: the kind it can't take it on. */
  kind?: FieldKind;
  /** A nest's field: the type that should declare it. */
  type?: string;
}

const VIRTUAL: readonly string[] = VIRTUAL_FIELDS;

/**
 * The entry fields each position's reader resolves with no declaration, off
 * the entry itself. Filters, sorts, bands, charts and dashboard widgets read
 * `schema.fieldValue`, whose virtual fields come first (M60.1); a column
 * draws the title alone; the date axis also reads file times; dependency and
 * cover axes and a nest read declared fields only. Tests pin the reader rows
 * against evaluateFilters and sortEntries, so the readers decide.
 */
export const ENTRY_FIELDS = {
  filter: VIRTUAL,
  sort: VIRTUAL,
  band: VIRTUAL,
  nest: [],
  column: ['title'],
  dateField: ['createdAt', 'modifiedAt'],
  dependencyField: [],
  galleryCover: [],
  chartValue: VIRTUAL,
  chartAxis: VIRTUAL,
  chartSeries: VIRTUAL,
  dashboardFilter: VIRTUAL,
  widgetFilter: VIRTUAL,
  widgetValue: VIRTUAL,
  widgetGroup: VIRTUAL,
} as const satisfies Record<RefPosition, readonly string[]>;

/** Ops that compare a rule's value against a choice's id. */
export const OPTION_OPS: ReadonlySet<FilterOp> = new Set<FilterOp>([
  'equals',
  'not_equals',
  'any_of',
  'none_of',
  'contains',
  'does_not_contain',
]);

/** The kinds whose values are choices from a declared set. */
export const OPTION_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>([
  'select',
  'multiselect',
  'status',
]);

const FILTER_POSITIONS: ReadonlySet<RefPosition> = new Set<RefPosition>([
  'filter',
  'dashboardFilter',
  'widgetFilter',
]);

const valuesOf = (value: FilterRule['value']): Scalar[] => {
  const list = Array.isArray(value) ? value : [value];
  return list.filter((v): v is Exclude<Scalar, null> => v !== null && v !== undefined && v !== '');
};

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);

export const recordsHoldKey = (records: readonly Entry[], name: string): boolean =>
  records.some((e) => name in e.properties || name in e.relationships);

export const recordsHoldValue = (records: readonly Entry[], name: string, value: string): boolean =>
  records.some((e) =>
    asList(e.relationships[name] ?? e.properties[name]).some(
      (x) => x !== null && x !== undefined && String(x) === value,
    ),
  );

export function declaredOptions(schema: Schema, type: string, def: FieldDef) {
  const own = def.options ?? [];
  return own.length > 0 || kindMeta(def.kind).statusSet !== true
    ? own
    : filterStatusSet(schema, type);
}

/**
 * Every problem `view` has against its database, deduped, in walk order.
 *
 * `source` is the view's type, or null for a typeless view, which is judged
 * against every database and every record. `entries` is the vault: a field a
 * record of the source (or of a type its grouping nests through) holds as a
 * key, or a value such a record holds, is never a problem.
 */
export function checkView(
  view: ViewDefinition,
  source: string | null,
  schema: Schema,
  entries: readonly Entry[],
): ViewProblem[] {
  const nests = nestLevels(view.presentation.group);
  const chain =
    source === null
      ? [...schema.types.keys()]
      : [...new Set(chainTypes(source, nests, schema).filter((t): t is string => t !== null))];
  const inChain = new Set(chain);
  const isDatabase = (type: string) =>
    schema.types.has(type) || entries.some((e) => e.type === type && type !== 'Type');

  // The records the view can show. Scanned lazily, only for a name or a value
  // no declaration answers.
  let records: Entry[] | null = null;
  const sourceRecords = (): Entry[] => {
    records ??= entries.filter((e) =>
      source === null ? e.type !== 'Type' : e.type !== null && inChain.has(e.type),
    );
    return records;
  };
  const held = new Map<string, boolean>();
  const holdsKey = (name: string): boolean => {
    let answer = held.get(name);
    if (answer === undefined) {
      answer = recordsHoldKey(sourceRecords(), name);
      held.set(name, answer);
    }
    return answer;
  };
  const holdsValue = (name: string, value: string): boolean =>
    recordsHoldValue(sourceRecords(), name, value);

  /** The declarations of `name` across the chain, each with its type. */
  const declarations = (name: string): { type: string; def: FieldDef }[] =>
    chain.flatMap((type) => {
      const def = schema.types.get(type)?.fields.find((f) => f.name === name);
      return def === undefined ? [] : [{ type, def }];
    });

  /** The option ids a declaration offers: its own, else (status) its type's
   * set, then the defaults. */
  const optionIds = (type: string, def: FieldDef): string[] => {
    return declaredOptions(schema, type, def).map((o) => o.id);
  };

  const out: ViewProblem[] = [];
  const at = (ref: ViewRef) => ({
    position: ref.position,
    ...(ref.filterPath === undefined ? {} : { filterPath: ref.filterPath }),
    ...(ref.widget === undefined ? {} : { widget: ref.widget }),
  });
  const deadNestLevels = new Set<number>();

  for (const ref of viewRefs(view)) {
    if (ref.holds === 'type') {
      if (!isDatabase(ref.name)) {
        out.push({ code: 'unknown_type', name: ref.name, ...at(ref) });
        if (ref.level !== undefined) deadNestLevels.add(ref.level);
      }
      continue;
    }
    if (ref.position === 'nest' && ref.level !== undefined && deadNestLevels.has(ref.level)) {
      continue;
    }
    const entryFields: readonly string[] = ENTRY_FIELDS[ref.position];
    if (entryFields.includes(ref.name)) continue;
    const decls = declarations(ref.name);
    if (decls.length === 0) {
      if (!holdsKey(ref.name)) {
        const owner = ref.position === 'nest' ? nestOwner(ref, nests, schema, source) : null;
        out.push({
          code: 'unknown_field',
          name: ref.name,
          ...at(ref),
          ...(owner === null ? {} : { type: owner }),
        });
      }
      continue;
    }
    if (!FILTER_POSITIONS.has(ref.position)) continue;
    const rule = ruleAt(view, ref);
    if (rule === null) continue;

    if (!decls.some(({ def }) => filterOpsFor(def.kind).includes(rule.op))) {
      out.push({
        code: 'op_does_not_fit',
        name: ref.name,
        ...at(ref),
        op: rule.op,
        kind: decls[0].def.kind,
      });
      continue;
    }
    if (!OPTION_OPS.has(rule.op)) continue;
    const choices = decls.filter(({ def }) => OPTION_KINDS.has(def.kind));
    if (choices.length === 0 || choices.length < decls.length) continue;
    const known = new Set(choices.flatMap(({ type, def }) => optionIds(type, def)));
    for (const value of valuesOf(rule.value)) {
      const option = String(value);
      if (known.has(option) || holdsValue(ref.name, option)) continue;
      out.push({ code: 'unknown_option', name: ref.name, ...at(ref), option });
    }
  }
  return dedupe(out);
}

/** The type a nest level's field belongs to: a reverse nest's own type, a
 * forward nest's chain type. */
function nestOwner(
  ref: ViewRef,
  nests: ReturnType<typeof nestLevels>,
  schema: Schema,
  source: string | null,
): string | null {
  const level = ref.level ?? -1;
  const spec = nests[level];
  if (spec === undefined) return null;
  if (spec.direction === 'reverse') return spec.type;
  return chainTypes(source, nests, schema)[level] ?? null;
}

function dedupe(problems: ViewProblem[]): ViewProblem[] {
  const seen = new Set<string>();
  return problems.filter((p) => {
    const key = [p.code, p.name, p.position, p.option ?? '', p.op ?? ''].join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Where a problem sits, as its sentence names it. */
const POSITION_WORDS = {
  filter: 'filter',
  sort: 'sort',
  band: 'grouping',
  nest: 'grouping',
  column: 'columns',
  dateField: 'date setting',
  dependencyField: 'dependency setting',
  galleryCover: 'card cover',
  chartValue: 'chart value',
  chartAxis: 'chart axis',
  chartSeries: 'chart series',
  dashboardFilter: 'dashboard filter',
  widgetFilter: 'widget filter',
  widgetValue: 'widget value',
  widgetGroup: 'widget grouping',
} as const satisfies Record<RefPosition, string>;

/** One sentence per problem. `source` is the view's type, or null when the
 * view is typeless. */
export function describeViewProblem(p: ViewProblem, source: string | null): string {
  switch (p.code) {
    case 'unknown_field': {
      const where = POSITION_WORDS[p.position];
      const holder = p.type ?? source;
      const who =
        holder === null
          ? 'no database has a property by that name'
          : `${holder} has no property by that name`;
      return `“${p.name}” in the ${where}: ${who}.`;
    }
    case 'unknown_option':
      return `“${p.option ?? ''}” is not an option of ${humanize(p.name)}.`;
    case 'op_does_not_fit': {
      const op = p.op === undefined ? '' : filterOpLabel(p.op);
      const kind = p.kind === undefined ? '' : ` (${kindMeta(p.kind).label})`;
      return `“${op}” doesn't apply to ${humanize(p.name)}${kind}.`;
    }
    case 'unknown_type':
      return `The grouping nests through “${p.name}”, which is not a database.`;
  }
}
