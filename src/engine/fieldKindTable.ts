/**
 * The field-kind vocabulary (M60.3): `shared/schema/field-kinds.v1.json`,
 * which Rust's `src-tauri/src/vault/schema.rs` reads too. It holds the facts
 * about every property kind (the atoms it accepts, its messages, whether it
 * groups, orders, sums or covers a card, its filter family), the filter
 * families' operators, the default statuses and their groups, the rollup
 * results, the virtual fields and the collation words. Both readers refuse a
 * malformed table in the same words and replay the same `cases` (D3).
 *
 * `FIELD_KINDS`, `FILTER_OPS`, `FILTER_FAMILIES` and `RollupCalc` stay TS
 * literals because they define the unions; fieldKindTable.test.ts holds each
 * to this table, in order.
 */

import RAW from '../../shared/schema/field-kinds.v1.json';
import type { FieldKind, FilterFamily, FilterOp, RollupCalc, StatusDef } from './types';

export const FIELD_KINDS_PATH = 'shared/schema/field-kinds.v1.json';
export const FIELD_KINDS_DIGEST_PATH = 'shared/schema/field-kinds.v1.sha256';
export const FIELD_KINDS_FORMAT = 1;

// The code's own lists, which the table must match: the Rust reader keeps
// the same constants and refuses in the same words.
const KIND_IDS: readonly string[] = [
  'text',
  'number',
  'checkbox',
  'date',
  'daterange',
  'select',
  'multiselect',
  'status',
  'person',
  'relation',
  'url',
  'email',
  'phone',
  'files',
  'rollup',
  'created_time',
  'last_edited_time',
  'formula',
  'repeat',
];
const ATOMS = [
  'string',
  'number',
  'boolean',
  'string_list',
  'date_text',
  'date_range',
  'url_text',
] as const;
const FAMILIES = ['text', 'number', 'date', 'choice', 'multi', 'boolean', 'any'] as const;
const ROLLUP_CALC_IDS = [
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'percent_done',
  'earliest',
  'latest',
  'show',
];
const ROLLUP_RESULT_WORDS = ['number', 'value', 'text'];
const STATUS_CHAIN = ['project', 'type', 'default'];
const VIRTUAL_FIELD_IDS = ['title', 'type', 'createdAt', 'modifiedAt'];
const DATES_REF = 'shared/calendar/dates.v1.json';

export type Atom = (typeof ATOMS)[number];
export type MessageKey = 'shape' | 'endpoint' | 'backwards' | 'limit_one' | 'derived';
export type RollupResult = 'number' | 'value' | 'text';

/** One kind's facts, as the artifact states them. */
export interface KindFacts {
  kind: FieldKind;
  accepts: Atom[];
  multi: boolean;
  computed: boolean;
  /** Values are wikilinks to other pages: the kind honours `limit` and a
   * reverse `from`. */
  links: boolean;
  groupable: boolean;
  orderable: boolean;
  numeric: boolean;
  media: boolean;
  filters: FilterFamily;
  /** The kind's options live on the TYPE (`statuses:`), not on the field. */
  status_set: boolean;
  /** Kept for existing vaults, out of the "+ Add property" catalog. */
  legacy: boolean;
  messages: Partial<Record<MessageKey, string>> & { shape: string };
}

export interface FieldKindTable {
  deadline_cases: {
    name: string;
    fields: Record<string, unknown>;
    deadline: unknown;
    expect: string | null;
  }[];
  format: number;
  artifact_version: number;
  rule_version: string;
  dates: string;
  atoms: Atom[];
  url_prefixes: string[];
  url_match: string;
  kinds: KindFacts[];
  filter_ops: FilterOp[];
  filter_families: Record<FilterFamily, FilterOp[]>;
  status_groups: StatusDef['group'][];
  status_group_default: StatusDef['group'];
  status_chain: string[];
  default_statuses: (StatusDef & { hollow: boolean })[];
  rollup_calcs: { calc: RollupCalc; result: RollupResult }[];
  virtual_fields: string[];
  collation: { text_tests: string; equality: string; ordered: string; sort: string };
  cases: Record<string, unknown[]>;
}

const sameList = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

function collationWord(key: string, got: string, known: string): void {
  if (got !== known) throw new Error(`field-kinds: collation ${key} has an unknown word ${got}`);
}

/** Parse and check a table, refusing in the words `schema.rs` uses. */
export function parseFieldKindTable(value: unknown): FieldKindTable {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('field-kinds: the table is not an object');
  }
  const t = value as FieldKindTable;
  if (t.format !== FIELD_KINDS_FORMAT) {
    throw new Error(`field-kinds: format must be ${FIELD_KINDS_FORMAT}, not ${String(t.format)}`);
  }
  if (typeof t.rule_version !== 'string' || t.rule_version.trim() === '') {
    throw new Error('field-kinds: rule_version is empty');
  }
  if (t.dates !== DATES_REF) throw new Error(`field-kinds: dates must name ${DATES_REF}`);
  if (!sameList(t.atoms, ATOMS)) {
    throw new Error(`field-kinds: atoms must be ${ATOMS.join(', ')} in order`);
  }
  if (t.url_prefixes.length === 0) throw new Error('field-kinds: url_prefixes is empty');
  if (t.url_match !== 'prefix_ignoring_ascii_case') {
    throw new Error(`field-kinds: url_match has an unknown word ${t.url_match}`);
  }
  if (
    !sameList(
      t.kinds.map((k) => k.kind),
      KIND_IDS,
    )
  ) {
    throw new Error(`field-kinds: kinds must be ${KIND_IDS.join(', ')} in order`);
  }
  if (!sameList(Object.keys(t.filter_families), FAMILIES)) {
    throw new Error(`field-kinds: filter_families must be ${FAMILIES.join(', ')} in order`);
  }
  for (const [family, ops] of Object.entries(t.filter_families)) {
    const stray = ops.find((op) => !t.filter_ops.includes(op));
    if (stray !== undefined) {
      throw new Error(`field-kinds: ${family} names an operator ${stray} that filter_ops lacks`);
    }
  }
  for (const k of t.kinds) {
    const atom = k.accepts.find((a) => !(ATOMS as readonly string[]).includes(a));
    if (atom !== undefined) {
      throw new Error(`field-kinds: ${k.kind} accepts an unknown atom ${atom}`);
    }
    if (!(FAMILIES as readonly string[]).includes(k.filters)) {
      throw new Error(`field-kinds: ${k.kind} filters by an unknown family ${k.filters}`);
    }
    const required: MessageKey[] = ['shape'];
    if (k.accepts.includes('date_range')) required.push('endpoint', 'backwards');
    if (k.links) required.push('limit_one', 'derived');
    const missing = required.find((m) => typeof k.messages[m] !== 'string');
    if (missing !== undefined) {
      throw new Error(`field-kinds: ${k.kind} is missing its ${missing} message`);
    }
  }
  if (!t.status_groups.includes(t.status_group_default)) {
    throw new Error(
      `field-kinds: status_group_default ${t.status_group_default} is not a status group`,
    );
  }
  if (!sameList(t.status_chain, STATUS_CHAIN)) {
    throw new Error(`field-kinds: status_chain must be ${STATUS_CHAIN.join(', ')}`);
  }
  const seen = new Set<string>();
  for (const s of t.default_statuses) {
    if (!t.status_groups.includes(s.group)) {
      throw new Error(`field-kinds: default status ${s.id} has an unknown group ${s.group}`);
    }
    if (seen.has(s.id)) throw new Error(`field-kinds: default status ${s.id} is listed twice`);
    seen.add(s.id);
  }
  if (
    !sameList(
      t.rollup_calcs.map((r) => r.calc),
      ROLLUP_CALC_IDS,
    )
  ) {
    throw new Error(`field-kinds: rollup_calcs must be ${ROLLUP_CALC_IDS.join(', ')} in order`);
  }
  const badResult = t.rollup_calcs.find((r) => !ROLLUP_RESULT_WORDS.includes(r.result));
  if (badResult !== undefined) {
    throw new Error(
      `field-kinds: rollup ${badResult.calc} has an unknown result ${badResult.result}`,
    );
  }
  if (!sameList(t.virtual_fields, VIRTUAL_FIELD_IDS)) {
    throw new Error(`field-kinds: virtual_fields must be ${VIRTUAL_FIELD_IDS.join(', ')} in order`);
  }
  collationWord('text_tests', t.collation.text_tests, 'lowercase');
  collationWord('equality', t.collation.equality, 'exact');
  collationWord('ordered', t.collation.ordered, 'number_date_code_unit');
  collationWord('sort', t.collation.sort, 'options_number_locale');
  return t;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** The shipped table, checked and frozen on load (its digest is held by the
 * tests, as for the policy artifacts). */
export const FIELD_KIND_TABLE: Readonly<FieldKindTable> = deepFreeze(parseFieldKindTable(RAW));

const FACTS = new Map(FIELD_KIND_TABLE.kinds.map((k) => [k.kind, k]));

/** The facts the table states for `kind`; an unknown kind reads as text. */
export function kindFacts(kind: FieldKind): KindFacts {
  return FACTS.get(kind) ?? FIELD_KIND_TABLE.kinds[0];
}

/** Which operators each filter family offers, in menu order. */
export const FAMILY_OPS: Readonly<Record<FilterFamily, readonly FilterOp[]>> =
  FIELD_KIND_TABLE.filter_families;

/** The status set a record falls back to when neither its project nor its
 * type declares one. */
export const DEFAULT_STATUS_SET: readonly StatusDef[] = FIELD_KIND_TABLE.default_statuses.map(
  ({ hollow, ...rest }) => (hollow ? { ...rest, hollow } : rest),
);

export const STATUS_GROUPS: readonly StatusDef['group'][] = FIELD_KIND_TABLE.status_groups;
export const STATUS_GROUP_DEFAULT: StatusDef['group'] = FIELD_KIND_TABLE.status_group_default;

/** What each rollup calculation yields: a number, a stored value, or text. */
export const ROLLUP_RESULTS: ReadonlyMap<RollupCalc, RollupResult> = new Map(
  FIELD_KIND_TABLE.rollup_calcs.map((r) => [r.calc, r.result]),
);

/** The URL prefixes a `url` value may start with, ignoring ASCII case. */
export const URL_PREFIXES: readonly string[] = FIELD_KIND_TABLE.url_prefixes;

/** The fields every entry answers from its own facts, never frontmatter. */
export const VIRTUAL_FIELDS: readonly string[] = FIELD_KIND_TABLE.virtual_fields;
