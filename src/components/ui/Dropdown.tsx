import React, { useId, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { useEscapeLayer } from '@/components/ui/Popover';

/**
 * Puts the open listbox on the layer stack (M16.34).
 *
 * The Escape branch in `onKeyDown` below is a React BUBBLE handler, and its
 * comment promised that "an open dropdown must swallow Escape before global
 * listeners". That was true when the global listeners bubbled too. M16.1
 * moved them to `window` in the CAPTURE phase, which runs before any React
 * handler — so the promise quietly inverted, and a Dropdown open inside a
 * Popover let Escape close the POPOVER out from under it. The listbox
 * appeared to close as well, but only because its parent had unmounted.
 *
 * A child component, so the layer exists exactly as long as the listbox does:
 * a hook in the parent would hold one open for a closed menu.
 */
function DropdownEscapeLayer({ onClose }: { onClose: () => void }) {
  useEscapeLayer(onClose);
  return null;
}

/**
 * DS dropdown (M2 Task 2): a custom listbox-button replacing native selects
 * in toolbars — native popups can't carry DS styling, icons, or check marks.
 * Anchored like FieldPopover; render context needs no `relative` wrapper
 * (the component brings its own).
 */
export interface DropdownOption {
  value: string;
  label: string;
  /** optional lucide icon rendered before the label */
  icon?: string;
}

export interface DropdownProps {
  options: DropdownOption[];
  value: string;
  onChange: (value: string) => void;
  /** accessible name for the trigger button */
  label: string;
  /** "sm" 28 | "md" 32 (default) — mirrors Select */
  size?: 'sm' | 'md';
  width?: number | string;
  disabled?: boolean;
}

export function Dropdown({
  options,
  value,
  onChange,
  label,
  size = 'md',
  width,
  disabled,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const selected = options[selectedIndex] ?? null;

  const openMenu = () => {
    setActive(selectedIndex);
    setOpen(true);
  };
  const pick = (v: string) => {
    setOpen(false);
    if (v !== value) onChange(v);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === 'Escape') {
      // Belt only. `DropdownEscapeLayer` handles this from the layer stack
      // before the key ever reaches React, and is what makes the dropdown win
      // against an enclosing popover; this branch survives for the case where
      // the event is dispatched at the element rather than at the window.
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const o = options[active];
      if (o) pick(o.value);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <span className="relative inline-flex" style={{ width }} onKeyDown={onKeyDown}>
      {open && <DropdownEscapeLayer onClose={() => setOpen(false)} />}
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        style={{ height: size === 'sm' ? 'var(--control-h-sm)' : 'var(--control-h)' }}
        className="inline-flex w-full cursor-pointer items-center gap-1.5 rounded-[var(--r-md)] border border-[var(--n-300)] bg-[var(--n-0)] pl-2.5 pr-2 text-[13px] text-[var(--n-800)] outline-none hover:bg-[var(--n-50)] focus-visible:border-[var(--cortex-500)] focus-visible:shadow-[0_0_0_3px_var(--cortex-100)] disabled:cursor-not-allowed disabled:bg-[var(--n-50)] disabled:text-[var(--n-400)]"
      >
        {selected?.icon && <Icon name={selected.icon} size={13} color="var(--n-500)" />}
        <span className="min-w-0 flex-1 truncate text-left">{selected?.label ?? ''}</span>
        <Icon name="chevron-down" size={14} color="var(--n-500)" />
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            // A full-screen backdrop swallows wheel events — the app "stops
            // scrolling" while any menu is open. Scrolling dismisses instead.
            onWheel={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default bg-transparent"
          />
          <div
            id={listId}
            role="listbox"
            aria-label={label}
            // The arrow-key highlight was paint only (M16.35): it shaded a row
            // and told assistive tech nothing, because DOM focus never leaves
            // the trigger button. `aria-activedescendant` is what names the
            // shaded row for a screen reader — without it the listbox reads as
            // if nothing in it were current, and Enter appeared to pick at
            // random. The ids come from the same `useId` that names the list.
            aria-activedescendant={
              options[active] === undefined ? undefined : `${listId}-${options[active].value}`
            }
            className="cb-menu-in absolute left-0 top-full z-50 mt-1 min-w-full whitespace-nowrap rounded-lg border border-[var(--n-200)] bg-[var(--n-0)] p-1.5 shadow-[var(--shadow-lg)]"
          >
            <div className="max-h-[264px] overflow-y-auto">
              {options.map((o, i) => (
                <button
                  key={o.value}
                  id={`${listId}-${o.value}`}
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(o.value)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-[7px] text-left text-[13px] text-[var(--n-800)] ${
                    i === active ? 'bg-[var(--n-50)]' : ''
                  }`}
                >
                  {o.icon && <Icon name={o.icon} size={13} color="var(--n-500)" />}
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.value === value && <Icon name="check" size={14} color="var(--cortex-600)" />}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </span>
  );
}
