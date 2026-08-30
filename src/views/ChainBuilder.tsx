import type React from 'react';
import { useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Popover } from '@/components/ui/Popover';
import { Select } from '@/components/ui/Select';
import { Tooltip } from '@/components/ui/Tooltip';
import { useSortableList } from '@/hooks/useSortableList';

/**
 * The shared editor for an ordered chain — grouping levels, sort keys, or
 * hierarchy descent (M9.1).
 *
 * A single `Dropdown` cannot express "status, then assignee": it has one
 * slot. Every one of these axes is a list, so they all get the same control —
 * a row per level, add at the bottom, remove per row. Modelled on
 * PropertyVisibility's popover so the toolbar keeps one interaction shape.
 */

export interface ChainRow {
  value: string;
  options: { value: string; label: string }[];
  /** Ascending/descending toggle; omitted for axes with no direction. */
  dir?: 'asc' | 'desc';
}

export interface ChainBuilderProps {
  label: string;
  icon: string;
  testId: string;
  /** Trigger summary; '' falls back to the bare label. */
  summary: string;
  rows: ChainRow[];
  /** Options for a NEW level; empty hides the add row. */
  addOptions: { value: string; label: string }[];
  addLabel: string;
  onChange(index: number, value: string): void;
  onToggleDir?(index: number): void;
  onRemove(index: number): void;
  onAdd(value: string): void;
  /**
   * Move the level at `from` so it sits at `to` (M16.26). Omitted leaves the
   * chain unorderable, which is where the GROUPING chain stays for now: a
   * relation level re-types every level below it, so a permutation there is
   * not the no-op it is on a sort chain — the tail's fields would belong to
   * the wrong type. Reordering it has to rebuild the tail, not swap two rows.
   */
  onMove?(from: number, to: number): void;
  max?: number;
  emptyHint?: string;
  /** Shown instead of the add row when the chain cannot be extended. */
  blockedHint?: string;
}

const ADD_SENTINEL = '__add__';

export function ChainBuilder({
  label,
  icon,
  testId,
  summary,
  rows,
  addOptions,
  addLabel,
  onChange,
  onToggleDir,
  onRemove,
  onAdd,
  onMove,
  max = 3,
  emptyHint,
  blockedHint,
}: ChainBuilderProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const atCap = rows.length >= max;
  const active = rows.length > 0;

  // A chain is ORDERED — first key wins, and the only way to demote the
  // leading sort was to delete every row and re-add them in the order you
  // wanted. Row identity is the level's value, which is unique within a chain
  // because every caller excludes the fields already taken.
  const labelOf = (value: string) =>
    rows.find((r) => r.value === value)?.options.find((o) => o.value === value)?.label ?? value;
  const sortable = useSortableList({
    ids: rows.map((r) => r.value),
    disabled: onMove === undefined,
    labelFor: labelOf,
    onReorder: (value, to) => {
      const from = rows.findIndex((r) => r.value === value);
      if (from !== -1 && from !== to) onMove?.(from, to);
    },
  });

  return (
    <span className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        data-testid={testId}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={[
          // whitespace-nowrap: the row WRAPS at narrow widths, but a pill must
          // wrap as a unit — "Group: status" broken across two lines reads as
          // two controls (M11 responsiveness).
          'inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-sm',
          active
            ? 'border-cortex-300 bg-cortex-50 text-cortex-700'
            : 'border-n-300 bg-n-0 text-n-700 hover:border-n-400',
        ].join(' ')}
      >
        <Icon name={icon} size={13} color={active ? 'var(--cortex-600)' : 'var(--n-500)'} />
        {summary === '' ? label : summary}
        {rows.length > 1 && (
          <span className="[font-family:var(--font-mono)] text-2xs opacity-70">
            +{rows.length - 1}
          </span>
        )}
      </button>
      {open && (
        /**
         * The shared `Popover` (M20.4).
         *
         * This was a hand-rolled `fixed inset-0` scrim plus `FixedBelowAnchor`,
         * so Escape did nothing at all and tabbing off the end of the surface
         * landed on an invisible full-screen button — focus apparently lost,
         * with no key that would give it back. The Filter chip beside it has
         * used the primitive correctly since M16.1; these two were the last
         * two that had not been converted.
         */
        <Popover
          anchorRef={triggerRef}
          onClose={() => setOpen(false)}
          role="dialog"
          ariaLabel={label}
        >
          <div className="w-[330px] rounded-lg border border-n-200 bg-n-0 p-2 shadow-[var(--shadow-lg)]">
            <div className="px-0.5 pb-1.5 text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
              {label}
            </div>
            {rows.length === 0 && emptyHint !== undefined && (
              <p className="m-0 px-0.5 pb-2 text-xs leading-[16px] text-n-500">{emptyHint}</p>
            )}
            <div
              ref={sortable.containerRef as React.RefObject<HTMLDivElement>}
              className="flex flex-col gap-1.5"
              style={sortable.containerStyle}
            >
              {rows.map((row, i) => (
                <div
                  key={`${i}:${row.value}`}
                  className="group flex items-center gap-1.5"
                  style={sortable.rowStyle(i)}
                >
                  {/* The grip shares the By/then cell rather than appending
                        itself, so the arrival of a pointer does not shove
                        every row's control a glyph to the right (M16.8). */}
                  <span className="relative flex w-8 flex-none items-center">
                    <span
                      className={[
                        'text-2xs text-n-400',
                        onMove === undefined ? '' : 'group-hover:opacity-0',
                      ].join(' ')}
                    >
                      {i === 0 ? 'By' : 'then'}
                    </span>
                    {onMove !== undefined && (
                      <Tooltip label="Drag to reorder — the first key breaks ties first">
                        <span
                          {...sortable.gripProps(row.value, i)}
                          // Opacity, not `hidden`: a hidden grip is out of
                          // the tab order, and arrow-key reordering is the
                          // point of the primitive underneath it.
                          className="absolute inset-0 flex cursor-grab items-center justify-start rounded-xs text-n-400 opacity-0 hover:text-n-600 focus-visible:opacity-100 group-hover:opacity-100"
                        >
                          <Icon name="grip-vertical" size={13} />
                        </span>
                      </Tooltip>
                    )}
                  </span>
                  <Select
                    size="sm"
                    value={row.value}
                    options={row.options}
                    onChange={(e) => onChange(i, e.target.value)}
                    width="100%"
                  />
                  {row.dir !== undefined && onToggleDir !== undefined && (
                    <button
                      type="button"
                      aria-label={`Level ${i + 1} direction: ${row.dir === 'asc' ? 'ascending' : 'descending'}`}
                      onClick={() => onToggleDir(i)}
                      className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-md border border-n-200 bg-transparent text-n-500 hover:border-n-400 hover:text-n-800"
                    >
                      <Icon name={row.dir === 'asc' ? 'arrow-up' : 'arrow-down'} size={12} />
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove level ${i + 1}`}
                    onClick={() => onRemove(i)}
                    className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-md border-0 bg-transparent text-n-400 hover:bg-n-50 hover:text-n-800"
                  >
                    <Icon name="x" size={12} />
                  </button>
                </div>
              ))}
            </div>
            {!atCap && addOptions.length > 0 && (
              <div className="mt-1.5 flex items-center gap-1.5 border-t border-n-100 pt-2">
                <span className="w-8 flex-none text-2xs text-n-400">
                  {rows.length === 0 ? 'By' : 'then'}
                </span>
                <Select
                  size="sm"
                  value={ADD_SENTINEL}
                  options={[{ value: ADD_SENTINEL, label: addLabel }, ...addOptions]}
                  onChange={(e) => {
                    if (e.target.value !== ADD_SENTINEL) onAdd(e.target.value);
                  }}
                  width="100%"
                />
              </div>
            )}
            {!atCap && addOptions.length === 0 && blockedHint !== undefined && (
              <p className="m-0 mt-1.5 border-t border-n-100 px-0.5 pt-2 text-2xs leading-[15px] text-n-400">
                {blockedHint}
              </p>
            )}
            {atcapNote(atCap, max)}
          </div>
        </Popover>
      )}
    </span>
  );
}

function atcapNote(atCap: boolean, max: number) {
  if (!atCap) return null;
  return (
    <p className="m-0 mt-1.5 border-t border-n-100 px-0.5 pt-2 text-2xs text-n-400">
      {max} levels is the maximum — deeper nesting stops being readable.
    </p>
  );
}
