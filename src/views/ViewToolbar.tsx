import { Dropdown } from '@/components/ui/Dropdown';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import type { Presentation } from '@/engine/types';

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

export function orderToValue(orderBy: Presentation['orderBy']): string {
  const value = `${orderBy.field}:${orderBy.dir}`;
  return ORDER_OPTIONS.some((o) => o.value === value) ? value : 'modifiedAt:desc';
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
}

// Task 8: the Save-view button is gone — saved-view tabs auto-persist edits
// and new views are created from the tab row's "New view" affordance.
export function ViewToolbar({ presentation, onChange }: ViewToolbarProps) {
  return (
    <div className="flex flex-none items-center gap-2 border-b border-[var(--n-200)] px-5 py-2">
      <SegmentedControl
        size="sm"
        options={[
          { value: 'list', label: 'List', icon: 'list', testId: 'view-switch-list' },
          { value: 'board', label: 'Board', icon: 'columns-3', testId: 'view-switch-board' },
        ]}
        value={presentation.type}
        onChange={(value) =>
          onChange({ ...presentation, type: value as Presentation['type'] })
        }
      />
      {/* M2 Task 2: DS Dropdown replaces the native selects. */}
      <Dropdown
        size="sm"
        label="Group by"
        options={GROUP_OPTIONS}
        value={presentation.groupBy ?? 'none'}
        onChange={(value) =>
          onChange({
            ...presentation,
            groupBy: value === 'none' ? null : value,
          })
        }
      />
      <Dropdown
        size="sm"
        label="Order by"
        options={ORDER_OPTIONS}
        value={orderToValue(presentation.orderBy)}
        onChange={(value) => onChange({ ...presentation, orderBy: valueToOrder(value) })}
      />
      <span className="flex-1" />
    </div>
  );
}
