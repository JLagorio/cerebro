import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Tooltip } from '@/components/ui/Tooltip';
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
  search,
  onSearchChange,
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
  /**
   * Free-text search within the open view (M16.26). Ephemeral, unlike a
   * filter: it is where you are looking right now, not part of what the saved
   * view IS, so it never reaches the YAML. Absent hides the control.
   */
  search?: string;
  onSearchChange?: (query: string) => void;
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
      {onSearchChange !== undefined && <SearchBox query={search ?? ''} onChange={onSearchChange} />}
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
                ? 'bg-n-100 text-n-800'
                : 'bg-transparent text-n-500 hover:bg-n-50 hover:text-n-800',
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
              {/* Escape closes THIS, which it never did (M16.29): the panel
                  had a click-away scrim and no keyboard exit at all, so the
                  keystroke fell through to the record panel behind it. */}
              <FixedBelowAnchor onClose={() => onSettingsOpenChange(false)}>
                {settingsPanel}
              </FixedBelowAnchor>
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
 * Search within the view (M16.26).
 *
 * Collapsed to a glyph until pressed, the way Notion's is: a permanent input
 * in a row of 28px icons is the widest thing in the row and earns that width
 * on the minority of visits where anyone types in it. It stays open while it
 * holds a query, because a control that hides a narrowed result set is how a
 * view ends up looking broken.
 */
function SearchBox({ query, onChange }: { query: string; onChange: (q: string) => void }) {
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  if (!open && query === '') {
    return (
      <Tooltip label="Search this view">
        <button
          type="button"
          data-testid="view-control-search"
          aria-label="Search this view"
          onClick={() => setOpen(true)}
          className="flex h-7 w-7 items-center justify-center rounded-md border-0 bg-transparent text-n-500 hover:bg-n-50 hover:text-n-800"
        >
          <Icon name="search" size={14} />
        </button>
      </Tooltip>
    );
  }

  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-md border border-n-300 bg-n-0 pl-1.5 pr-0.5">
      <Icon name="search" size={12} color="var(--n-400)" />
      <input
        ref={input}
        data-testid="view-search-input"
        aria-label="Search this view"
        placeholder="Search…"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          // Collapses only when it is empty. Collapsing with a live query
          // would leave the canvas narrowed by something no longer on screen.
          if (query === '') setOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          onChange('');
          setOpen(false);
        }}
        className="h-6 w-[124px] border-0 bg-transparent text-[12.5px] text-n-800 outline-none placeholder:text-n-400"
      />
      {query !== '' && (
        <IconButton
          icon="x"
          label="Clear search"
          size="sm"
          onClick={() => {
            onChange('');
            setOpen(false);
          }}
        />
      )}
    </span>
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
  // Which row Enter commits (M16.34). It was always the FIRST match, so the
  // list could be arrowed with nothing to arrow WITH: no highlight moved and
  // no other row was reachable from the keyboard at all.
  const [highlight, setHighlight] = useState(0);

  const openMenu = () => {
    setQuery('');
    setHighlight(0);
    setOpen(true);
  };
  const close = () => setOpen(false);

  const shown = options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()));
  // Every keystroke re-cuts the list, so a held index would point at a
  // different field than the one under the highlight a moment ago.
  const retype = (q: string) => {
    setQuery(q);
    setHighlight(0);
  };
  const at = Math.min(highlight, Math.max(shown.length - 1, 0));

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
            ? 'text-cortex-600 hover:bg-cortex-50'
            : 'text-n-500 hover:bg-n-50 hover:text-n-800',
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
            <div className="w-[240px] rounded-lg border border-n-200 bg-n-0 p-1.5 shadow-[var(--shadow-lg)]">
              <input
                autoFocus
                aria-label={placeholder}
                placeholder={placeholder}
                value={query}
                onChange={(e) => retype(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    close();
                  }
                  // Arrows stay in the input — the rows are not tab stops, and
                  // moving focus onto one would take the caret out of the box
                  // you are still typing in.
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (shown.length === 0) return;
                    const next = at + (e.key === 'ArrowDown' ? 1 : -1);
                    setHighlight(((next % shown.length) + shown.length) % shown.length);
                  }
                  if (e.key === 'Enter' && shown.length > 0) {
                    close();
                    onPick(shown[at].value);
                  }
                }}
                className="mb-1 h-7 w-full rounded-md border border-n-200 px-2 text-[12.5px] text-n-800 outline-none focus:border-cortex-500 focus:shadow-[0_0_0_3px_var(--cortex-100)]"
              />
              <div className="max-h-[264px] overflow-y-auto">
                {shown.map((o, i) => (
                  <button
                    key={o.value}
                    type="button"
                    data-highlighted={i === at ? '' : undefined}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => {
                      close();
                      onPick(o.value);
                    }}
                    // The highlight wears the hover background, so pointer and
                    // keyboard say "this is the one Enter takes" the same way.
                    className={[
                      'flex w-full items-center gap-2 rounded-sm border-0 px-2 py-1.5 text-left text-[12.5px] text-n-700 hover:bg-n-50',
                      i === at ? 'bg-n-50' : 'bg-transparent',
                    ].join(' ')}
                  >
                    <Icon name={o.icon} size={12} color="var(--n-500)" />
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  </button>
                ))}
                {shown.length === 0 && (
                  <div className="px-2 py-1.5 text-xs text-n-400">Nothing matches.</div>
                )}
              </div>
            </div>
          </FixedBelowAnchor>
        </>
      )}
    </span>
  );
}
