/** The view suggestion vocabulary is shared with vault/views.rs. This reader
 * checks its shape and references; the artifact owns layout capabilities. */
import RAW from '../../shared/schema/views.v1.json';
import { FIELD_KIND_TABLE, kindFacts } from './fieldKindTable';

export const VIEWS_PATH = 'shared/schema/views.v1.json';
export const VIEWS_DIGEST_PATH = 'shared/schema/views.v1.sha256';
export interface ViewVocabulary {
  format: number;
  artifact_version: number;
  rule_version: string;
  view_types: { id: string; suggestable: boolean; needs: string[]; reads: string[] }[];
  chart_kinds: { id: string; needs_axis: boolean; reads: string[] }[];
  chart_aggs: string[];
  measured_aggs: string[];
  chart_sorts: string[];
  directions: string[];
  date_buckets: string[];
  calendar_spans: string[];
  zooms: string[];
  slots: Record<string, { fact?: string | null; family?: string | null; verb: string }>;
  keys: Record<
    'view' | 'presentation' | 'group' | 'sort' | 'column' | 'chart' | 'gallery',
    string[]
  >;
  limits: Record<
    | 'name'
    | 'reasoning'
    | 'args_bytes'
    | 'group_levels'
    | 'sort_keys'
    | 'columns'
    | 'filter_rules'
    | 'filter_depth'
    | 'view_limit'
    | 'problems'
    | 'names_listed',
    number
  >;
}

const ENUMS = [
  'chart_aggs',
  'measured_aggs',
  'chart_sorts',
  'directions',
  'date_buckets',
  'calendar_spans',
  'zooms',
] as const;
const KEYS = ['view', 'presentation', 'group', 'sort', 'column', 'chart', 'gallery'] as const;
const LIMITS = [
  'name',
  'reasoning',
  'args_bytes',
  'group_levels',
  'sort_keys',
  'columns',
  'filter_rules',
  'filter_depth',
  'view_limit',
  'problems',
  'names_listed',
] as const;
const SLOTS = [
  'group',
  'sort',
  'chart.xField',
  'chart.groupBy',
  'chart.value',
  'dateField',
  'gallery.cover',
  'dateBucket',
];
const TOP = [
  'format',
  'artifact_version',
  'rule_version',
  'view_types',
  'chart_kinds',
  ...ENUMS,
  'slots',
  'keys',
  'limits',
];
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function shape(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  return (
    object(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
function tableShape(value: unknown): value is ViewVocabulary {
  if (
    !shape(value, TOP) ||
    !integer(value.format) ||
    !integer(value.artifact_version) ||
    typeof value.rule_version !== 'string'
  )
    return false;
  if (
    !Array.isArray(value.view_types) ||
    !value.view_types.every(
      (v) =>
        shape(v, ['id', 'suggestable', 'needs', 'reads']) &&
        typeof v.id === 'string' &&
        typeof v.suggestable === 'boolean' &&
        strings(v.needs) &&
        strings(v.reads),
    )
  )
    return false;
  if (
    !Array.isArray(value.chart_kinds) ||
    !value.chart_kinds.every(
      (v) =>
        shape(v, ['id', 'needs_axis', 'reads']) &&
        typeof v.id === 'string' &&
        typeof v.needs_axis === 'boolean' &&
        strings(v.reads),
    )
  )
    return false;
  if (!ENUMS.every((key) => strings(value[key]))) return false;
  if (!shape(value.keys, KEYS) || !Object.values(value.keys).every(strings)) return false;
  if (!shape(value.limits, LIMITS) || !Object.values(value.limits).every(integer)) return false;
  return (
    object(value.slots) &&
    Object.values(value.slots).every(
      (slot) =>
        shape(slot, ['verb'], ['fact', 'family']) &&
        typeof slot.verb === 'string' &&
        (slot.fact == null || typeof slot.fact === 'string') &&
        (slot.family == null || typeof slot.family === 'string'),
    )
  );
}
const unique = (values: readonly string[]): boolean =>
  values.length > 0 && values.every((v) => v !== '') && new Set(values).size === values.length;

/** Refusals are the same words as the Rust artifact reader. */
export function parseViewVocabulary(value: unknown): ViewVocabulary {
  if (!tableShape(value)) throw new Error('views: invalid table shape');
  const table = value;
  if (table.format !== 1) throw new Error(`views: format must be 1, not ${table.format}`);
  if (!table.rule_version.trim()) throw new Error('views: rule_version is empty');
  if (table.artifact_version === 0) throw new Error('views: artifact_version must be positive');
  for (const key of ['view_types', 'chart_kinds'] as const) {
    if (!unique(table[key].map((row) => row.id)))
      throw new Error(`views: ${key} must be non-empty and unique`);
  }
  for (const key of KEYS)
    if (!unique(table.keys[key]))
      throw new Error(`views: keys.${key} must be non-empty and unique`);
  for (const view of table.view_types) {
    for (const need of view.needs)
      if (!['band', 'dateField', 'chart', 'axis'].includes(need))
        throw new Error(`views: unknown need ${need}`);
    for (const key of view.reads)
      if (!table.keys.presentation.includes(key))
        throw new Error(`views: view type ${view.id} reads unknown key ${key}`);
  }
  for (const chart of table.chart_kinds)
    for (const key of chart.reads)
      if (!table.keys.chart.includes(key))
        throw new Error(`views: chart kind ${chart.id} reads unknown key ${key}`);
  for (const key of ENUMS) {
    if (key !== 'measured_aggs' && !unique(table[key]))
      throw new Error(`views: ${key} must be non-empty and unique`);
  }
  if (
    !unique(table.measured_aggs) ||
    table.measured_aggs.some((agg) => !table.chart_aggs.includes(agg))
  )
    throw new Error('views: measured_aggs must name chart_aggs');
  for (const key of SLOTS)
    if (!Object.hasOwn(table.slots, key)) throw new Error(`views: missing slot ${key}`);
  for (const [name, slot] of Object.entries(table.slots)) {
    if ((slot.fact != null) === (slot.family != null) || slot.verb === '')
      throw new Error(`views: slot ${name} needs one fact or family and a verb`);
    if (
      slot.fact != null &&
      typeof (kindFacts('text') as unknown as Record<string, unknown>)[slot.fact] !== 'boolean'
    )
      throw new Error(`views: slot ${name} names unknown fact ${slot.fact}`);
    if (slot.family != null && !Object.hasOwn(FIELD_KIND_TABLE.filter_families, slot.family))
      throw new Error(`views: slot ${name} names unknown family ${slot.family}`);
  }
  for (const key of LIMITS)
    if (table.limits[key] === 0) throw new Error(`views: limit ${key} must be a positive integer`);
  return table;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export const VIEW_VOCABULARY: Readonly<ViewVocabulary> = freeze(parseViewVocabulary(RAW));
