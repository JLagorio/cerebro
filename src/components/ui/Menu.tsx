import React, { useCallback, useEffect, useRef } from 'react';
import { Icon } from '@/components/ui/Icon';

/**
 * Menu chrome and menu items (M16.7).
 *
 * Six surfaces had already hand-rolled this — `ContextMenu`, `CreateMenu`,
 * `Dropdown`, `ConversationSwitcher`, and two inside `TableView` — each
 * re-picking its own radius, padding, shadow and text size, and only
 * `ContextMenu` implementing arrow-key navigation. A menu you cannot drive
 * from the keyboard is a menu a screen-reader user cannot use at all.
 *
 * This is chrome plus keyboard, deliberately NOT placement: `Popover` (M16.1)
 * already owns anchoring, flipping and dismissal, and a menu that also placed
 * itself would be a second answer to a question that has one.
 */

const ITEM_BASE =
  'flex w-full items-center gap-2 rounded-sm border-0 bg-transparent px-2 py-[5px] text-left text-sm';

/** A disabled item is still in the DOM and still reads as a menuitem, but it
 * must not take an arrow-key stop — a keyboard user would land on something
 * that cannot respond and have no way to know why. */
const FOCUSABLE = '[role="menuitem"]:not([disabled]),input:not([disabled]),button:not([disabled])';

export function MenuSurface({
  children,
  width,
  className,
  autoFocus = true,
}: {
  children: React.ReactNode;
  width?: number;
  className?: string;
  /** Moves focus to the first item on open. Off for a menu that drills into
   * a sub-surface, where focus should stay where the user put it. */
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const items = useCallback(
    () => [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])],
    [],
  );

  useEffect(() => {
    if (autoFocus) items()[0]?.focus();
  }, [autoFocus, items]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const list = items();
    // A text input owns its own arrow keys — moving the caret is what the
    // user means there, not moving down the menu.
    if (document.activeElement?.tagName === 'INPUT' && (e.key === 'Home' || e.key === 'End')) {
      return;
    }
    const at = list.findIndex((b) => b === document.activeElement);
    const focus = (i: number) => list[Math.max(0, Math.min(list.length - 1, i))]?.focus();
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focus(at + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focus(at - 1);
        break;
      case 'Home':
        e.preventDefault();
        focus(0);
        break;
      case 'End':
        e.preventDefault();
        focus(list.length - 1);
        break;
    }
  };

  return (
    <div
      ref={ref}
      onKeyDown={onKeyDown}
      style={width === undefined ? undefined : { width }}
      className={[
        'rounded-lg border border-n-200 bg-n-0 p-1 shadow-[var(--shadow-lg)]',
        className ?? '',
      ].join(' ')}
    >
      {children}
    </div>
  );
}

export interface MenuItemProps {
  label: string;
  icon?: string;
  /** Right-aligned current value, e.g. the kind a "Type" row is set to. */
  hint?: string;
  /** Draws the chevron that says this opens another surface. */
  submenu?: boolean;
  /** Draws a check — for a menu that is a set of choices. */
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  testId?: string;
  onSelect: () => void;
}

export function MenuItem({
  label,
  icon,
  hint,
  submenu = false,
  checked = false,
  danger = false,
  disabled = false,
  testId,
  onSelect,
}: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      disabled={disabled}
      onClick={onSelect}
      className={[
        ITEM_BASE,
        disabled
          ? 'cursor-default text-n-400'
          : danger
            ? 'text-danger-600 hover:bg-danger-50 focus-visible:bg-danger-50'
            : 'text-n-700 hover:bg-n-50 focus-visible:bg-n-50',
      ].join(' ')}
    >
      {icon !== undefined && (
        <Icon name={icon} size={13} color={danger ? undefined : 'var(--n-500)'} />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint !== undefined && <span className="flex-none text-2xs text-n-400">{hint}</span>}
      {checked && <Icon name="check" size={12} color="var(--cortex-600)" />}
      {submenu && <Icon name="chevron-right" size={11} color="var(--n-400)" />}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-n-100" />;
}

/** A section heading. Not a menuitem: it is not selectable and must not
 * absorb an arrow-key stop on the way past. */
export function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pb-0.5 pt-1 text-2xs font-medium uppercase tracking-wide text-n-400">
      {children}
    </div>
  );
}

/** The back-header a menu grows when it drills into a sub-surface. */
export function MenuBack({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="mb-1 flex items-center gap-1.5">
      <button
        type="button"
        aria-label={`Back to ${title}`}
        onClick={onBack}
        className="flex h-6 w-6 flex-none items-center justify-center rounded-md border-0 bg-transparent text-n-500 hover:bg-n-50"
      >
        <Icon name="arrow-left" size={13} />
      </button>
      <span className="min-w-0 truncate text-sm font-semibold text-n-900">{title}</span>
    </div>
  );
}
