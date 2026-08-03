import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { FixedBelowAnchor } from '@/detail/FieldPopover';
import type { ColumnDef } from '@/engine/columns';
import { kindMeta } from '@/engine/properties';
import { humanize } from '@/engine/schema';
import type { FilterGroup, Presentation } from '@/engine/types';
import { seedFilterRule } from '@/engine/viewFilters';
import { groupByField, sortBy } from '@/engine/views';
import { countRules, GROUPABLE_KINDS, META_SORTS, ORDERABLE_KINDS } from '@/views/ViewToolbar';
import { axesFor } from '@/views/viewKinds';

/**
 * The view-control icon cluster (M12.8): Notion's toolbar-in-the-tab-row.
 *
 * Filter, sort and group used to live in a permanent strip of pills below the
 * tabs — always present, mostly idle. Now each is an icon at the tab row's
 * right edge. An icon whose axis is EMPTY opens a quick field picker, so the
 * first rule is one click and one choice; an icon whose axis has rules toggles
 * the chip bar below, where the full builders live. The icon tints when its
 * axis is active, so a hidden bar never hides the fact that a view is
 * filtered.
 */
export function ViewControlIcons({
  presentation,
  filters = null,
  fields,
  onChange,
  onFiltersChange,
  barOpen,
  onBarOpenChange,
  settingsOpen = false,
  onSettingsOpenChange,
  settingsPanel,
  onNew,
}: {
  presentation: Presentation;
  filters?: FilterGroup | null;
  fields: ColumnDef[];
  onChange: (next: Presentation) => void;
  onFiltersChange?: (next: FilterGroup | null) => void;
  /** Whether the chip bar below the tabs is showing. */
  barOpen: boolean;
  onBarOpenChange: (open: boolean) => void;
  /** M12.8: the view-settings menu — layout, properties, and the rest of the
   * view's configuration — floats from the sliders icon, never a side panel. */
  settingsOpen?: boolean;
  onSettingsOpenChange?: (open: boolean) => void;
  settingsPanel?: React.ReactNode;
  /** Creates an untitled record and opens it. Absent on typeless views. */
  onNew?: () => void;
}) {
  const filterCount = countRules(filters);
  const axes = axesFor(presentation.type);

  const option = (f: ColumnDef) => ({
    value: f.name,
    label: humanize(f.name),
    icon: kindMeta(f.kind).icon,
  });

  const toggleBar = () => onBarOpenChange(!barOpen);

  return (
    <>
      {onFiltersChange !== undefined && (
        <QuickAxisIcon
          icon="list-filter"
          label="Filter"
          active={filterCount > 0}
          placeholder="Filter by…"
          options={[{ value: 'title', label: 'Name', icon: 'type' }, ...fields.map(option)]}
          barOpen={barOpen}
          onToggleBar={toggleBar}
          onPick={(field) => {
            // Seeded through the engine so the starter rule is one the FIELD'S
            // KIND can express (M16.25). It also carried a dead `value: ''` on
            // a valueless operator, which then round-tripped into the YAML.
            onFiltersChange({
              all: [seedFilterRule(field, fields.find((f) => f.name === field)?.kind ?? 'text')],
            });
            onBarOpenChange(true);
          }}
        />
      )}
      <QuickAxisIcon
        icon="arrow-up-down"
        label="Sort"
        active={presentation.sort.length > 0}
        placeholder="Sort by…"
        options={[
          ...META_SORTS.map((m) => ({ value: m.value, label: m.label, icon: 'type' })),
          ...fields.filter((f) => ORDERABLE_KINDS.has(f.kind)).map(option),
        ]}
        barOpen={barOpen}
        onToggleBar={toggleBar}
        onPick={(field) => {
          onChange(sortBy(presentation, field, 'asc'));
          onBarOpenChange(true);
        }}
      />
      {axes.group && (
        <QuickAxisIcon
          icon="rows-3"
          label="Group"
          active={presentation.group.length > 0}
          placeholder="Group by…"
          options={fields.filter((f) => GROUPABLE_KINDS.has(f.kind)).map(option)}
          barOpen={barOpen}
          onToggleBar={toggleBar}
          onPick={(field) => {
            onChange(groupByField(presentation, field));
            onBarOpenChange(true);
          }}
        />
      )}
      {onSettingsOpenChange !== undefined && (
        <span className="relative inline-flex">
          <button
            type="button"
            data-testid="view-control-settings"
            aria-label="View settings"
            aria-expanded={settingsOpen}
            onClick={() => onSettingsOpenChange(!settingsOpen)}
            className={[
              'flex h-7 w-7 items-center justify-center rounded-md border-0',
              settingsOpen
                ? 'bg-[var(--n-100)] text-[var(--n-800)]'
                : 'bg-transparent text-[var(--n-500)] hover:bg-[var(--n-50)] hover:text-[var(--n-800)]',
            ].join(' ')}
          >
            <Icon name="sliders-horizontal" size={14} />
          </button>
          {settingsOpen && settingsPanel !== undefined && (
            <>
              <button
                type="button"
                aria-label="Close view settings"
                onClick={() => onSettingsOpenChange(false)}
                onWheel={() => onSettingsOpenChange(false)}
                className="fixed inset-0 z-40 cursor-default border-0 bg-transparent"
              />
              <FixedBelowAnchor>{settingsPanel}</FixedBelowAnchor>
            </>
          )}
        </span>
      )}
      {onNew !== undefined && (
        <span className="ml-1" data-testid="view-control-new">
          <Button variant="primary" size="sm" icon="plus" onClick={() => void onNew()}>
            New
          </Button>
        </span>
      )}
    </>
  );
}

/**
 * One axis icon. Empty axis → a field quick-pick (the Notion "Filter by…"
 * menu); non-empty axis → toggles the chip bar where the builder lives.
 */
function QuickAxisIcon({
  icon,
  label,
  active,
  placeholder,
  options,
  barOpen,
  onToggleBar,
  onPick,
}: {
  icon: string;
  label: string;
  active: boolean;
  placeholder: string;
  options: { value: string; label: string; icon: string }[];
  /** Whether the chip bar below the tabs is showing. */
  barOpen: boolean;
  onToggleBar: () => void;
  onPick: (field: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const openMenu = () => {
    setQuery('');
    setOpen(true);
  };
  const close = () => setOpen(false);

  const shown = options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        data-testid={`view-control-${label.toLowerCase()}`}
        aria-label={label}
        aria-expanded={open}
        // An OPEN bar always closes from these icons. It used to toggle only
        // while its axis was ACTIVE, so clearing the last rule stranded the bar
        // permanently open with nothing left that could close it.
        onClick={() => (open ? close() : barOpen || active ? onToggleBar() : openMenu())}
        className={[
          'flex h-7 w-7 items-center justify-center rounded-md border-0 bg-transparent',
          active
            ? 'text-[var(--cortex-600)] hover:bg-[var(--cortex-50)]'
            : 'text-[var(--n-500)] hover:bg-[var(--n-50)] hover:text-[var(--n-800)]',
        ].join(' ')}
      >
        <Icon name={icon} size={14} />
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label={`Close ${label.toLowerCase()} menu`}
            onClick={close}
            onWheel={close}
            className="fixed inset-0 z-40 cursor-default border-0 bg-transparent"
          />
          <FixedBelowAnchor>
            <div className="w-[240px] rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] p-1.5 shadow-[var(--shadow-lg)]">
              <input
                autoFocus
                aria-label={placeholder}
                placeholder={placeholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    close();
                  }
                  if (e.key === 'Enter' && shown.length > 0) {
                    close();
                    onPick(shown[0].value);
                  }
                }}
                className="mb-1 h-7 w-full rounded-md border border-[var(--n-200)] px-2 text-[12.5px] text-[var(--n-800)] outline-none focus:border-[var(--cortex-500)] focus:shadow-[0_0_0_3px_var(--cortex-100)]"
              />
              <div className="max-h-[264px] overflow-y-auto">
                {shown.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => {
                      close();
                      onPick(o.value);
                    }}
                    className="flex w-full items-center gap-2 rounded-[6px] border-0 bg-transparent px-2 py-1.5 text-left text-[12.5px] text-[var(--n-700)] hover:bg-[var(--n-50)]"
                  >
                    <Icon name={o.icon} size={12} color="var(--n-500)" />
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  </button>
                ))}
                {shown.length === 0 && (
                  <div className="px-2 py-1.5 text-[12px] text-[var(--n-400)]">
                    Nothing matches.
                  </div>
                )}
              </div>
            </div>
          </FixedBelowAnchor>
        </>
      )}
    </span>
  );
}
