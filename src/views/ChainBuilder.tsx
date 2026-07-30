import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Select } from '@/components/ui/Select';
import { FixedBelowAnchor } from '@/detail/FieldPopover';

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
  max = 3,
  emptyHint,
  blockedHint,
}: ChainBuilderProps) {
  const [open, setOpen] = useState(false);
  const atCap = rows.length >= max;
  const active = rows.length > 0;

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        data-testid={testId}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={[
          'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12.5px]',
          active
            ? 'border-[var(--cortex-300)] bg-[var(--cortex-50)] text-[var(--cortex-700)]'
            : 'border-[var(--n-300)] bg-[var(--n-0)] text-[var(--n-700)] hover:border-[var(--n-400)]',
        ].join(' ')}
      >
        <Icon name={icon} size={13} color={active ? 'var(--cortex-600)' : 'var(--n-500)'} />
        {summary === '' ? label : summary}
        {rows.length > 1 && (
          <span className="[font-family:var(--font-mono)] text-[11px] opacity-70">
            +{rows.length - 1}
          </span>
        )}
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label={`Close ${label.toLowerCase()}`}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default border-0 bg-transparent"
          />
          <FixedBelowAnchor>
            <div className="w-[330px] rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] p-2 shadow-[var(--shadow-lg)]">
              <div className="px-0.5 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--n-400)]">
                {label}
              </div>
              {rows.length === 0 && emptyHint !== undefined && (
                <p className="m-0 px-0.5 pb-2 text-[11.5px] leading-[16px] text-[var(--n-500)]">
                  {emptyHint}
                </p>
              )}
              <div className="flex flex-col gap-1.5">
                {rows.map((row, i) => (
                  <div key={`${i}:${row.value}`} className="flex items-center gap-1.5">
                    <span className="w-8 flex-none text-[11px] text-[var(--n-400)]">
                      {i === 0 ? 'By' : 'then'}
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
                        className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-md border border-[var(--n-200)] bg-transparent text-[var(--n-500)] hover:border-[var(--n-400)] hover:text-[var(--n-800)]"
                      >
                        <Icon name={row.dir === 'asc' ? 'arrow-up' : 'arrow-down'} size={12} />
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={`Remove level ${i + 1}`}
                      onClick={() => onRemove(i)}
                      className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-md border-0 bg-transparent text-[var(--n-400)] hover:bg-[var(--n-50)] hover:text-[var(--n-800)]"
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </div>
                ))}
              </div>
              {!atCap && addOptions.length > 0 && (
                <div className="mt-1.5 flex items-center gap-1.5 border-t border-[var(--n-100)] pt-2">
                  <span className="w-8 flex-none text-[11px] text-[var(--n-400)]">
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
                <p className="m-0 mt-1.5 border-t border-[var(--n-100)] px-0.5 pt-2 text-[11px] leading-[15px] text-[var(--n-400)]">
                  {blockedHint}
                </p>
              )}
              {atcapNote(atCap, max)}
            </div>
          </FixedBelowAnchor>
        </>
      )}
    </span>
  );
}

function atcapNote(atCap: boolean, max: number) {
  if (!atCap) return null;
  return (
    <p className="m-0 mt-1.5 border-t border-[var(--n-100)] px-0.5 pt-2 text-[11px] text-[var(--n-400)]">
      {max} levels is the maximum — deeper nesting stops being readable.
    </p>
  );
}
