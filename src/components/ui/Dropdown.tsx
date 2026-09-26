import React, { useId, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Popover } from '@/components/ui/Popover';

/**
 * DS dropdown (M2 Task 2): a custom listbox-button replacing native selects
 * in toolbars — native popups can't carry DS styling, icons, or check marks.
 *
 * The menu is a `Popover` (M46.3). It used to be an `absolute` panel inside
 * the trigger's own `relative` wrapper, which is precisely the pre-M16.1
 * mistake `Popover`'s header describes: a panel rendered in place is CLIPPED
 * by any scrolling ancestor, and one near the bottom of the window opens off
 * the screen instead of flipping up. Both were live — MEASURED in the New
 * list dialog, whose body is `overflow: auto`: the "First view" menu lost
 * everything below Calendar to the dialog's edge, and the source-type menu
 * lost everything below Type. Adopting the primitive also retires this
 * file's own escape layer and its `fixed inset-0` backdrop, which `Popover`
 * brings with it.
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
  // The trigger's width at the moment it opened. `min-w-full` used to say
  // this, and stopped meaning anything once the panel left the subtree: the
  // menu is at least as wide as the button and grows for a long option,
  // which is why this is a minimum and not `matchAnchorWidth`.
  const [minWidth, setMinWidth] = useState<number>();
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const listId = useId();
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const selected = options[selectedIndex] ?? null;

  const openMenu = () => {
    setActive(selectedIndex);
    setMinWidth(anchorRef.current?.getBoundingClientRect().width);
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
      // Belt only. The `Popover` owns Escape from the layer stack before the
      // key ever reaches React, and is what makes an open dropdown win
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
    <span ref={anchorRef} className="relative inline-flex" style={{ width }} onKeyDown={onKeyDown}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        style={{ height: size === 'sm' ? 'var(--control-h-sm)' : 'var(--control-h)' }}
        className="motion-hover inline-flex w-full cursor-pointer items-center gap-1.5 rounded-[var(--r-md)] border border-n-300 bg-n-0 pl-2.5 pr-2 text-sm text-n-800 outline-none hover:bg-n-50 focus-visible:border-cortex-500 focus-visible:shadow-[0_0_0_3px_var(--cortex-100)] disabled:cursor-not-allowed disabled:bg-n-50 disabled:text-n-400"
      >
        {selected?.icon && <Icon name={selected.icon} size={13} color="var(--n-500)" />}
        <span className="min-w-0 flex-1 truncate text-left">{selected?.label ?? ''}</span>
        <Icon name="chevron-down" size={14} color="var(--n-500)" />
      </button>
      {open && (
        <Popover
          anchorRef={anchorRef}
          onClose={() => setOpen(false)}
          role="listbox"
          ariaLabel={label}
          id={listId}
          // DOM focus never leaves the trigger button, so the shaded row is
          // paint only until something names it (M16.35). Without this the
          // listbox reads as if nothing in it were current, and Enter
          // appeared to pick at random.
          activeDescendant={
            options[active] === undefined ? undefined : `${listId}-${options[active].value}`
          }
          className="whitespace-nowrap rounded-lg border border-n-200 bg-n-0 p-1.5 shadow-[var(--shadow-lg)]"
        >
          <div className="max-h-[264px] overflow-y-auto" style={{ minWidth }}>
            {options.map((o, i) => (
              <button
                key={o.value}
                id={`${listId}-${o.value}`}
                type="button"
                role="option"
                aria-selected={o.value === value}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o.value)}
                className={`motion-hover flex w-full items-center gap-2 rounded-md px-2 py-[7px] text-left text-sm text-n-800 ${
                  i === active ? 'bg-n-50' : ''
                }`}
              >
                {o.icon && <Icon name={o.icon} size={13} color="var(--n-500)" />}
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.value === value && <Icon name="check" size={14} color="var(--cortex-600)" />}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </span>
  );
}
