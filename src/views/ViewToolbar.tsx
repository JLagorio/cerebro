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
import type { ChildrenSpec, FieldDef, Presentation, Schema, SortSpec } from '@/engine/types';
import { MAX_GROUP_DEPTH, MAX_HIERARCHY_DEPTH } from '@/engine/views';

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
  /** Offer the split (record browser) layout segment (M3 type screen). */
  withSplit?: boolean;
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
  withSplit = false,
  sourceType = null,
  schema,
  onAddProperty,
}: ViewToolbarProps) {
  const declared = fields ?? [];
  const isTree = presentation.type === 'tree';

  // --- grouping chain -------------------------------------------------
  const groupTaken = new Set(presentation.group.map((g) => g.field));
  const groupable = availableFields(declared, GROUPABLE_KINDS, groupTaken);
  const groupRows: ChainRow[] = presentation.group.map((g) => ({
    value: g.field,
    dir: g.dir ?? 'asc',
    // Each level offers its own field plus every field no OTHER level took.
    options: dedupe([
      { value: g.field, label: humanize(g.field) },
      ...availableFields(declared, GROUPABLE_KINDS, without(groupTaken, g.field)),
    ]),
  }));

  const setGroup = (next: Presentation['group']) => onChange({ ...presentation, group: next });

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

  // --- hierarchy chain ------------------------------------------------
  // Level n+1's options come from the type level n LANDS on, which is what
  // makes Objective → Key result → Work item selectable at all.
  const levelTypes = schema === undefined ? [] : chainTypes(sourceType, presentation.hierarchy, schema);
  const hierarchyRows: ChainRow[] = presentation.hierarchy.map((spec, i) => ({
    value: descentValue(spec),
    options: (schema === undefined ? [] : descentOptions(levelTypes[i] ?? null, schema)).map((o) => ({
      value: o.value,
      label: o.label,
    })),
  }));
  const nextDescent =
    schema === undefined ? [] : descentOptions(levelTypes[presentation.hierarchy.length] ?? null, schema);

  const setHierarchy = (next: ChildrenSpec[]) => onChange({ ...presentation, hierarchy: next });

  return (
    <div className="flex flex-none items-center gap-2 border-b border-[var(--n-200)] px-5 py-2">
      <SegmentedControl
        size="sm"
        options={[
          ...(withSplit
            ? [{ value: 'split', label: 'Browse', icon: 'panel-left', testId: 'view-switch-split' }]
            : []),
          { value: 'table', label: 'Table', icon: 'table-2', testId: 'view-switch-table' },
          { value: 'list', label: 'List', icon: 'list', testId: 'view-switch-list' },
          { value: 'board', label: 'Board', icon: 'columns-3', testId: 'view-switch-board' },
          // M9.1: the tree layout had no segment, so a saved hierarchy view
          // showed nothing selected and any click here persisted you out of
          // it with no way back except the settings dialog.
          { value: 'tree', label: 'Hierarchy', icon: 'list-tree', testId: 'view-switch-tree' },
        ]}
        value={presentation.type}
        onChange={(value) =>
          onChange({ ...presentation, type: value as Presentation['type'] })
        }
      />

      {/* The split browser is a flat ordered list, so grouping doesn't apply.
          A hierarchy groups ABOVE its roots, so it keeps one level only. */}
      {presentation.type !== 'split' && (
        <ChainBuilder
          testId="group-chain"
          label="Grouping"
          icon="rows-3"
          summary={
            presentation.group.length === 0
              ? 'Group'
              : `Group: ${humanize(presentation.group[0].field).toLowerCase()}`
          }
          rows={groupRows}
          addOptions={groupable}
          addLabel="Add a grouping level…"
          max={isTree ? 1 : MAX_GROUP_DEPTH}
          emptyHint="Records are listed flat. Add a level to band them by a property."
          blockedHint="This type declares no other groupable property."
          onChange={(i, v) => setGroup(presentation.group.map((g, j) => (j === i ? { ...g, field: v } : g)))}
          onToggleDir={(i) =>
            setGroup(
              presentation.group.map((g, j) =>
                j === i ? { ...g, dir: (g.dir ?? 'asc') === 'asc' ? 'desc' : 'asc' } : g,
              ),
            )
          }
          onRemove={(i) => setGroup(presentation.group.filter((_, j) => j !== i))}
          onAdd={(v) => setGroup([...presentation.group, { field: v }])}
        />
      )}

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

      {/* M9.1: the descent chain, reachable from the toolbar rather than only
          from the view settings dialog. */}
      {isTree && schema !== undefined && (
        <ChainBuilder
          testId="hierarchy-chain"
          label="Nesting"
          icon="list-tree"
          summary={presentation.hierarchy.length === 0 ? 'Nesting' : `Nested ${presentation.hierarchy.length} deep`}
          rows={hierarchyRows}
          addOptions={nextDescent.map((o) => ({ value: o.value, label: o.label }))}
          addLabel="Add a level…"
          max={MAX_HIERARCHY_DEPTH}
          emptyHint="Rows are flat. Pick a relation to nest children underneath them."
          blockedHint="Nothing links to this level's type, so the chain ends here."
          onChange={(i, v) => {
            const spec = parseDescentValue(v);
            if (spec === null) return;
            // Changing a level invalidates everything below it — those
            // relations were computed against the old type.
            setHierarchy([...presentation.hierarchy.slice(0, i), spec]);
          }}
          onRemove={(i) => setHierarchy(presentation.hierarchy.slice(0, i))}
          onAdd={(v) => {
            const spec = parseDescentValue(v);
            if (spec !== null) setHierarchy([...presentation.hierarchy, spec]);
          }}
        />
      )}

      {/* M3.4: every view controls which properties it shows. The split
          browser has its own full property panel, so it opts out. */}
      {presentation.type !== 'split' && (
        <PropertyVisibility
          fields={declared}
          columns={presentation.columns}
          onChange={(columns) => onChange({ ...presentation, columns })}
          onAddProperty={onAddProperty}
          canAddProperty={sourceType !== null}
        />
      )}
      <span className="flex-1" />
    </div>
  );
}

function labelForSort(field: string): string {
  const meta = META_SORTS.find((m) => m.value === field);
  return meta?.label ?? humanize(field);
}
