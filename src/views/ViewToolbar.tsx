import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
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
  onSaveView: (name: string) => void;
}

export function ViewToolbar({ presentation, onChange, onSaveView }: ViewToolbarProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [viewName, setViewName] = useState('');

  const save = () => {
    const name = viewName.trim();
    if (!name) return;
    onSaveView(name);
    setDialogOpen(false);
    setViewName('');
  };

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
      <Select
        size="sm"
        options={GROUP_OPTIONS}
        value={presentation.groupBy ?? 'none'}
        onChange={(e) =>
          onChange({
            ...presentation,
            groupBy: e.target.value === 'none' ? null : e.target.value,
          })
        }
      />
      <Select
        size="sm"
        options={ORDER_OPTIONS}
        value={orderToValue(presentation.orderBy)}
        onChange={(e) => onChange({ ...presentation, orderBy: valueToOrder(e.target.value) })}
      />
      <span className="flex-1" />
      <Button variant="secondary" size="sm" icon="bookmark" onClick={() => setDialogOpen(true)}>
        Save view
      </Button>
      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="Save view"
        width={420}
        primaryAction={{ label: 'Save', onClick: save, disabled: viewName.trim() === '' }}
        secondaryAction={{ label: 'Cancel', onClick: () => setDialogOpen(false) }}
      >
        <Input
          autoFocus
          placeholder="View name"
          value={viewName}
          onChange={(e) => setViewName(e.target.value)}
          width="100%"
        />
      </Dialog>
    </div>
  );
}
