import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { ChainBuilder, type ChainRow } from '@/views/ChainBuilder';
import { PropertyVisibility } from '@/views/PropertyVisibility';
import type { ColumnDef } from '@/engine/columns';
import {
  chainTypes,
  descentOptions,
  descentValue,
  parseDescentValue,
} from '@/engine/hierarchyOptions';
import { humanize } from '@/engine/schema';
import { bandLevels, nestLevels } from '@/engine/types';
import type { FieldDef, GroupSpec, Presentation, Schema, SortSpec, ViewType } from '@/engine/types';
import { MAX_GROUP_DEPTH, MAX_NEST_DEPTH } from '@/engine/views';
import { VIEW_SEGMENTS } from '@/views/viewKinds';

// Fallback options for surfaces that don't pass declared fields (the project
// canvas is Work-item-only, so its groupable fields are known statically).
export const GROUP_OPTIONS = [
  { value: 'none', label: 'No grouping' },
  { value: 'status', label: 'Group: status' },
  { value: 'priority', label: 'Group: priority' },
  { value: 'assignee', label: 'Group: assignee' },
  { value: 'estimate', label: 'Group: estimate' },
];

export const ORDER_OPTIONS = [
  { value: 'modifiedAt:desc', label: 'Last modified' },
  { value: 'modifiedAt:asc', label: 'Oldest modified' },
  { value: 'due:asc', label: 'Due date' },
  { value: 'priority:asc', label: 'Priority' },
];

/** Kinds whose values bucket meaningfully (M3 fix: the dropdowns used to be
 * hardcoded to Work-item fields, so grouping on any other type was a no-op). */
const GROUPABLE_KINDS = new Set(['status', 'select', 'multiselect', 'person', 'checkbox', 'relation']);
const ORDERABLE_KINDS = new Set(['status', 'select', 'number', 'date', 'daterange']);

/** Group options for a collection whose type declares `fields`. */
export function groupOptionsFor(fields: FieldDef[] | undefined) {
  if (fields === undefined) return GROUP_OPTIONS;
  return [
    { value: 'none', label: 'No grouping' },
    ...fields
      .filter((f) => GROUPABLE_KINDS.has(f.kind))
      .map((f) => ({ value: f.name, label: `Group: ${humanize(f.name).toLowerCase()}` })),
  ];
}

/** Order options for a collection whose type declares `fields`. */
export function orderOptionsFor(fields: FieldDef[] | undefined) {
  if (fields === undefined) return ORDER_OPTIONS;
  return [
    { value: 'modifiedAt:desc', label: 'Last modified' },
    { value: 'modifiedAt:asc', label: 'Oldest modified' },
    { value: 'title:asc', label: 'Title' },
    ...fields
      .filter((f) => ORDERABLE_KINDS.has(f.kind))
      .map((f) => ({ value: `${f.name}:asc`, label: humanize(f.name) })),
  ];
}

export function orderToValue(
  orderBy: SortSpec,
  options: { value: string }[] = ORDER_OPTIONS,
): string {
  const value = `${orderBy.field}:${orderBy.dir}`;
  return options.some((o) => o.value === value) ? value : 'modifiedAt:desc';
}

export function valueToOrder(value: string): SortSpec {
  const [field, dir] = value.split(':');
  return { field: field || 'modifiedAt', dir: dir === 'asc' ? 'asc' : 'desc' };
}

export function slugifyViewId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Fields a chain can still add, excluding the ones already in it. */
function availableFields(fields: FieldDef[], kinds: Set<string>, taken: Set<string>) {
  return fields
    .filter((f) => kinds.has(f.kind) && !taken.has(f.name))
    .map((f) => ({ value: f.name, label: humanize(f.name) }));
}

/** The taken-set minus this row's own field, so a level can keep its value. */
function without(taken: Set<string>, own: string): Set<string> {
  const next = new Set(taken);
  next.delete(own);
  return next;
}

function dedupe(options: { value: string; label: string }[]) {
  return options.filter((o, i, all) => all.findIndex((x) => x.value === o.value) === i);
}

/** Sortable fields include the entry metadata every record has. */
const META_SORTS = [
  { value: 'modifiedAt', label: 'Last modified' },
  { value: 'createdAt', label: 'Created' },
  { value: 'title', label: 'Title' },
];

export interface ViewToolbarProps {
  presentation: Presentation;
  onChange: (presentation: Presentation) => void;
  /** Declared fields of the collection's type; when set, the chain builders
   * offer those instead of the Work-item fallbacks. */
  fields?: ColumnDef[];
  /** Source type + schema drive the hierarchy chain's per-level options. */
  sourceType?: string | null;
  schema?: Schema;
  /** M9.2: create a property on the source type from the property picker. */
  onAddProperty?: (name: string, kind: FieldDef['kind']) => void;
}

// Task 8: the Save-view button is gone — saved-view tabs auto-persist edits
// and new views are created from the tab row's "New view" affordance.
export function ViewToolbar({
  presentation,
  onChange,
  fields,
  sourceType = null,
  schema,
  onAddProperty,
}: ViewToolbarProps) {
  const declared = fields ?? [];

  // --- grouping chain (M9.7) ------------------------------------------
  // ONE chain. A level bands by a property or descends a relation; the
  // options list offers both, because both answer the same question — what
  // is the next level down?
  const bands = bandLevels(presentation.group);
  const bandTaken = new Set(bands.map((g) => g.field));

  /** Options for the level at `index`, which depends on what precedes it. */
  const optionsForLevel = (index: number): { value: string; label: string }[] => {
    const before = presentation.group.slice(0, index);
    const nestedBefore = nestLevels(before).length;
    // A relation level changes the TYPE of everything below it, so the
    // properties on offer are that type's, not the view source's.
    const typeHere = schema === undefined ? sourceType : (chainTypes(sourceType, nestLevels(before), schema).pop() ?? null);
    const fieldsHere =
      typeHere === null || schema === undefined ? declared : (schema.types.get(typeHere)?.fields ?? declared);
    const own = presentation.group[index];
    const propertyOptions = fieldsHere
      .filter((f) => GROUPABLE_KINDS.has(f.kind))
      .filter((f) => own?.field === f.name || !bandTaken.has(f.name))
      .map((f) => ({ value: `property:${f.name}`, label: humanize(f.name) }));
    const relationOptions =
      schema === undefined || nestedBefore >= MAX_NEST_DEPTH
        ? []
        : descentOptions(typeHere, schema).map((o) => ({ value: o.value, label: `↳ ${o.label}` }));
    return dedupe([...propertyOptions, ...relationOptions]);
  };

  const levelValue = (spec: GroupSpec): string =>
    spec.descend === undefined ? `property:${spec.field}` : descentValue(spec.descend);

  const decodeLevel = (value: string): GroupSpec | null => {
    if (value.startsWith('property:')) return { field: value.slice('property:'.length) };
    const descend = parseDescentValue(value);
    return descend === null ? null : { field: descend.field, descend };
  };

  const groupRows: ChainRow[] = presentation.group.map((spec, i) => ({
    value: levelValue(spec),
    dir: spec.descend === undefined ? (spec.dir ?? 'asc') : undefined,
    options: optionsForLevel(i),
  }));

  const setGroup = (next: GroupSpec[]) => onChange({ ...presentation, group: next });

  const groupSummary =
    presentation.group.length === 0
      ? 'Group'
      : presentation.group[0].descend === undefined
        ? `Group: ${humanize(presentation.group[0].field).toLowerCase()}`
        : `Nest: ${humanize(presentation.group[0].field).toLowerCase()}`;

  // --- sort chain -----------------------------------------------------
  const sortTaken = new Set(presentation.sort.map((s) => s.field));
  const sortable = [
    ...META_SORTS.filter((m) => !sortTaken.has(m.value)),
    ...availableFields(declared, ORDERABLE_KINDS, sortTaken),
  ];
  const sortRows: ChainRow[] = presentation.sort.map((s) => ({
    value: s.field,
    dir: s.dir,
    options: dedupe([
      { value: s.field, label: labelForSort(s.field) },
      ...META_SORTS.filter((m) => !sortTaken.has(m.value)),
      ...availableFields(declared, ORDERABLE_KINDS, without(sortTaken, s.field)),
    ]),
  }));

  const setSort = (next: SortSpec[]) => onChange({ ...presentation, sort: next });

  return (
    <div className="flex flex-none items-center gap-2 border-b border-[var(--n-200)] px-5 py-2">
      {/* M10: the six views, one selected at a time. "Hierarchy" is gone —
          any of these nests when the grouping chain has a relation level, so
          a whole view kind for it was a control that duplicated another. */}
      <SegmentedControl
        size="sm"
        options={VIEW_SEGMENTS}
        value={presentation.type}
        onChange={(value) => onChange({ ...presentation, type: value as ViewType })}
      />

      {/* M9.7: one Group control. Its options list properties AND relations,
          so "band by status" and "nest under the objective" are the same
          gesture — which is what they always were. */}
      <ChainBuilder
          testId="group-chain"
          label="Group"
          icon="rows-3"
          summary={groupSummary}
          rows={groupRows}
          addOptions={optionsForLevel(presentation.group.length)}
          addLabel="Add a level…"
          max={MAX_GROUP_DEPTH + MAX_NEST_DEPTH}
          emptyHint="Records are listed flat. Group by a property to band them, or by a relation to nest them."
          blockedHint="Nothing left to group or nest by at this level."
          onChange={(i, v) => {
            const level = decodeLevel(v);
            if (level === null) return;
            // Changing a relation level invalidates everything below it —
            // those options were resolved against the old type.
            const tail =
              presentation.group[i]?.descend !== undefined || level.descend !== undefined
                ? []
                : presentation.group.slice(i + 1);
            setGroup([...presentation.group.slice(0, i), level, ...tail]);
          }}
          onToggleDir={(i) =>
            setGroup(
              presentation.group.map((g, j) =>
                j === i && g.descend === undefined
                  ? { ...g, dir: (g.dir ?? 'asc') === 'asc' ? 'desc' : 'asc' }
                  : g,
              ),
            )
          }
          onRemove={(i) => setGroup(presentation.group.filter((_, j) => j !== i))}
          onAdd={(v) => {
            const level = decodeLevel(v);
            if (level !== null) setGroup([...presentation.group, level]);
          }}
        />

      <ChainBuilder
        testId="sort-chain"
        label="Sorting"
        icon="arrow-up-down"
        summary={
          presentation.sort.length === 0
            ? 'Sort'
            : `Sort: ${labelForSort(presentation.sort[0].field).toLowerCase()}`
        }
        rows={sortRows}
        addOptions={sortable}
        addLabel="Add a sort key…"
        max={4}
        emptyHint="Records appear in vault order."
        blockedHint="Every sortable property is already in the chain."
        onChange={(i, v) => setSort(presentation.sort.map((s, j) => (j === i ? { ...s, field: v } : s)))}
        onToggleDir={(i) =>
          setSort(presentation.sort.map((s, j) => (j === i ? { ...s, dir: s.dir === 'asc' ? 'desc' : 'asc' } : s)))
        }
        onRemove={(i) => setSort(presentation.sort.filter((_, j) => j !== i))}
        onAdd={(v) => setSort([...presentation.sort, { field: v, dir: 'asc' }])}
      />

      {/* M3.4: every view controls which properties it shows. */}
      <PropertyVisibility
        fields={declared}
        columns={presentation.columns}
        onChange={(columns) => onChange({ ...presentation, columns })}
        onAddProperty={onAddProperty}
        canAddProperty={sourceType !== null}
      />
      <span className="flex-1" />
    </div>
  );
}

function labelForSort(field: string): string {
  const meta = META_SORTS.find((m) => m.value === field);
  return meta?.label ?? humanize(field);
}
