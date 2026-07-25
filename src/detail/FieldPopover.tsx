import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';

export interface FieldPopoverOption {
  id: string;
  label: string;
  color: string | null;
  hollow?: boolean;
}

export interface FieldPopoverProps {
  options: FieldPopoverOption[];
  activeId?: string | null;
  /** show a title-filter input (person/relation pickers) */
  searchable?: boolean;
  onPick: (id: string) => void;
  onClose: () => void;
}

/** Anchored option popover; render inside a `relative` wrapper next to its trigger. */
export function FieldPopover({ options, activeId, searchable, onPick, onClose }: FieldPopoverProps) {
  const [query, setQuery] = useState('');
  const visible =
    query.trim() === ''
      ? options
      : options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <>
      <button
        type="button"
        aria-label="Close popover"
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default bg-transparent"
      />
      <div
        role="listbox"
        className="absolute left-0 top-full z-50 mt-1 w-60 rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] p-1.5 shadow-[var(--shadow-lg)]"
      >
        {searchable && (
          <div className="pb-1.5">
            <Input autoFocus size="sm" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} width="100%" />
          </div>
        )}
        <div className="max-h-[264px] overflow-y-auto">
          {visible.map((o) => (
            <button
              key={o.id}
              type="button"
              role="option"
              aria-selected={o.id === activeId}
              onClick={() => {
                onPick(o.id);
                onClose();
              }}
              className="flex w-full items-center gap-2 rounded-[7px] px-2 py-[7px] text-left text-[13px] text-[var(--n-800)] hover:bg-[var(--n-50)]"
            >
              <span
                className="box-border h-2 w-2 flex-none rounded-full"
                style={
                  o.hollow || !o.color
                    ? { border: `1.5px solid ${o.color ?? 'var(--n-400)'}` }
                    : { background: o.color }
                }
              />
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.id === activeId && <Icon name="check" size={14} color="var(--cortex-600)" />}
            </button>
          ))}
          {visible.length === 0 && <div className="p-2 text-[12px] text-[var(--n-400)]">No matches</div>}
        </div>
      </div>
    </>
  );
}
