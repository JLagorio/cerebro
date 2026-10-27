import type {
  AuthorityError,
  PropertyValue,
  SelectedPropertyValue,
} from '@/lib/generated/workspace';
import type { Entry, FieldDef, FilterGroup, Presentation, ResolvedField, Schema } from './types';
import { VIRTUAL_FIELDS } from './fieldKindTable';

const own = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);
export const selectedProjectionUnavailable = (message: string): AuthorityError => ({
  kind: 'unsupported_projection',
  code: 'capability_unavailable',
  message,
  retryable: false,
});

/** The carrier is descriptive data on the same native Entry/version, never write admission. */
export function selectedEntryIssue(entry: Entry): string | null {
  if (entry.authority?.kind !== 'sqlite_metadata') return null;
  const carrier: unknown = entry.canonicalProperties;
  const value: unknown =
    carrier !== null && typeof carrier === 'object' && !Array.isArray(carrier) && 'value' in carrier
      ? carrier.value
      : undefined;
  if (
    carrier === null ||
    typeof carrier !== 'object' ||
    Array.isArray(carrier) ||
    !('unavailableLegacyKeys' in carrier) ||
    !Array.isArray(carrier.unavailableLegacyKeys) ||
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('kind' in value) ||
    value.kind !== 'object' ||
    !('value' in value) ||
    value.value === null ||
    typeof value.value !== 'object' ||
    Array.isArray(value.value)
  ) {
    return 'Canonical properties are unavailable for this selected record. Refresh the original source.';
  }
  return null;
}

export function selectedPropertyKeys(entry: Entry): string[] {
  if (entry.authority?.kind !== 'sqlite_metadata') return Object.keys(entry.properties);
  if (selectedEntryIssue(entry) !== null) return [];
  const value = entry.canonicalProperties!.value;
  return value.kind === 'object' ? Object.keys(value.value) : [];
}

/** Native-issued exact-safe compatibility only; no second Decimal/Date interpreter. */
export function selectedLegacyProperties(entry: Entry): Entry['properties'] {
  if (entry.authority?.kind !== 'sqlite_metadata') return entry.properties;
  if (selectedEntryIssue(entry) !== null) return {};
  const issued = entry.canonicalProperties!;
  if (issued.value.kind !== 'object') return {};
  const unavailable = new Set(issued.unavailableLegacyKeys);
  return Object.fromEntries(
    Object.entries(entry.properties).filter(
      ([key]) =>
        own(issued.value.kind === 'object' ? issued.value.value : {}, key) && !unavailable.has(key),
    ),
  );
}

/** Callers list the config keys they actually consume, not a new schema policy. */
export function selectedConfigIssue(entry: Entry, keys: readonly string[]): string | null {
  const issue = selectedEntryIssue(entry);
  if (issue !== null) return issue;
  if (entry.authority?.kind !== 'sqlite_metadata') return null;
  const carrier = entry.canonicalProperties!;
  if (carrier.value.kind !== 'object') return 'Canonical configuration is unavailable.';
  const unavailable = new Set(carrier.unavailableLegacyKeys);
  for (const key of keys) {
    if (own(carrier.value.value, key) && (unavailable.has(key) || !own(entry.properties, key))) {
      return 'Canonical configuration “' + key + '” is unavailable in this presentation.';
    }
  }
  return null;
}

function exactFieldValue(entry: Entry, field: string): SelectedPropertyValue {
  const values = entry.canonicalProperties!.value;
  return values.kind === 'object' && own(values.value, field)
    ? { kind: 'present', value: values.value[field] }
    : { kind: 'absent' };
}

/** Exact scalar presentation. It deliberately supplies no legacy arithmetic Decimal/Date. */
export function selectedResolvedField(
  entry: Entry,
  field: string,
  def: FieldDef | null,
  typeIssue?: string,
): ResolvedField | null {
  if (entry.authority?.kind !== 'sqlite_metadata') return null;
  const unavailableReason = selectedEntryIssue(entry) ?? typeIssue;
  const base = { def, raw: undefined, display: 'Unavailable', color: null, ghost: false };
  if (unavailableReason) return { ...base, unavailableReason };
  if (def?.kind === 'formula' || def?.kind === 'rollup' || def?.from !== undefined) {
    return {
      ...base,
      unavailableReason: 'This computed selected property needs its canonical reader.',
    };
  }
  const selectedValue = exactFieldValue(entry, field);
  if (selectedValue.kind === 'absent') return { ...base, display: '', selectedValue };
  const value: PropertyValue = selectedValue.value;
  switch (value.kind) {
    case 'null':
      return { ...base, display: 'Null', selectedValue };
    case 'string':
      return { ...base, raw: value.value, display: value.value, selectedValue };
    case 'boolean':
      return { ...base, raw: value.value, display: value.value ? 'Yes' : 'No', selectedValue };
    case 'decimal':
    case 'date':
      return { ...base, display: value.value, selectedValue };
    default:
      return {
        ...base,
        selectedValue,
        unavailableReason:
          'This stored ' +
          value.kind +
          ' value needs a canonical presentation. It is kept without conversion.',
      };
  }
}

const entryFacts = new Set<string>(VIRTUAL_FIELDS);
function metadataPredicate(filters: FilterGroup | null | undefined): boolean {
  if (!filters) return false;
  const nodes = 'all' in filters ? filters.all : filters.any;
  return nodes.some((node) =>
    'field' in node ? !entryFacts.has(node.field) : metadataPredicate(node),
  );
}

/** A synchronous legacy evaluator cannot claim a canonical metadata result.
 * Native query/agenda/view services own exact semantics; callers can adopt
 * those services explicitly instead of coercing this presentation carrier. */
export function selectedViewIssue(
  entries: Entry[],
  schema: Schema,
  presentation: Presentation,
  filters?: FilterGroup | null,
  sourceType?: string | null,
  search?: string,
): AuthorityError | undefined {
  if (sourceType && schema.types.get(sourceType)?.unavailableReason) {
    return selectedProjectionUnavailable(schema.types.get(sourceType)!.unavailableReason!);
  }
  const selected = entries.filter((entry) => entry.authority?.kind === 'sqlite_metadata');
  if (selected.length === 0) return undefined;
  for (const entry of selected) {
    const issue =
      selectedEntryIssue(entry) ??
      (entry.type ? schema.types.get(entry.type)?.unavailableReason : undefined);
    if (issue) return selectedProjectionUnavailable(issue);
  }
  const dependent =
    Boolean(search?.trim()) ||
    metadataPredicate(filters) ||
    presentation.sort.some((sort) => !entryFacts.has(sort.field)) ||
    presentation.group.some(
      (group) => group.descend !== undefined || !entryFacts.has(group.field),
    ) ||
    presentation.columns.some(
      (column) =>
        column.calc !== undefined ||
        selected.some((entry) => {
          const def = entry.type
            ? schema.types.get(entry.type)?.fields.find((field) => field.name === column.field)
            : undefined;
          return def?.kind === 'formula' || def?.kind === 'rollup' || def?.from !== undefined;
        }),
    ) ||
    presentation.titleCalc !== undefined ||
    ['calendar', 'timeline', 'gantt', 'chart', 'dashboard'].includes(presentation.type);
  return dependent
    ? selectedProjectionUnavailable(
        'This selected view needs a canonical metadata reader for its filters, ordering, groups or calculations. Its result is unavailable here.',
      )
    : undefined;
}
