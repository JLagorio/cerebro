import { Dropdown } from '@/components/ui/Dropdown';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { PropertyVisibility } from '@/views/PropertyVisibility';
import { humanize } from '@/engine/schema';
import type { FieldDef, Presentation } from '@/engine/types';

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
  orderBy: Presentation['orderBy'],
  options: { value: string }[] = ORDER_OPTIONS,
): string {
  const value = `${orderBy.field}:${orderBy.dir}`;
  return options.some((o) => o.value === value) ? value : 'modifiedAt:desc';
}

export function valueToOrder(value: string): Presentation['orderBy'] {
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

export interface ViewToolbarProps {
  presentation: Presentation;
  onChange: (presentation: Presentation) => void;
  /** Declared fields of the collection's type; when set, the group/order
   * dropdowns offer those instead of the Work-item fallbacks. */
  fields?: FieldDef[];
  /** Offer the split (record browser) layout segment (M3 type screen). */
  withSplit?: boolean;
}

// Task 8: the Save-view button is gone — saved-view tabs auto-persist edits
// and new views are created from the tab row's "New view" affordance.
export function ViewToolbar({ presentation, onChange, fields, withSplit = false }: ViewToolbarProps) {
  const groupOptions = groupOptionsFor(fields);
  const orderOptions = orderOptionsFor(fields);
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
        ]}
        value={presentation.type}
        onChange={(value) =>
          onChange({ ...presentation, type: value as Presentation['type'] })
        }
      />
      {/* M2 Task 2: DS Dropdown replaces the native selects. The split layout
          is a flat ordered list, so grouping doesn't apply there. */}
      {presentation.type !== 'split' && (
        <Dropdown
          size="sm"
          label="Group by"
          options={groupOptions}
          value={presentation.groupBy ?? 'none'}
          onChange={(value) =>
            onChange({
              ...presentation,
              groupBy: value === 'none' ? null : value,
            })
          }
        />
      )}
      <Dropdown
        size="sm"
        label="Order by"
        options={orderOptions}
        value={orderToValue(presentation.orderBy, orderOptions)}
        onChange={(value) => onChange({ ...presentation, orderBy: valueToOrder(value) })}
      />
      {/* M3.4: every view controls which properties it shows. The split
          browser has its own full property panel, so it opts out. */}
      {fields !== undefined && presentation.type !== 'split' && (
        <PropertyVisibility
          fields={fields}
          visibleFields={presentation.visibleFields}
          onChange={(visibleFields) => onChange({ ...presentation, visibleFields })}
        />
      )}
      <span className="flex-1" />
    </div>
  );
}
