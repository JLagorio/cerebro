import React, { useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Popover } from '@/components/ui/Popover';
import { Tooltip } from '@/components/ui/Tooltip';
import { humanize } from '@/detail/FieldEditor';
import type { GripProps } from '@/hooks/useSortableList';
import { kindMeta } from '@/engine/properties';
import type { FieldKind } from '@/engine/types';

/**
 * One property row in a detail panel (M16.6).
 *
 * There was no such component: `RecordProperties` and `DocProperties` each
 * hand-assembled rows out of a `w-24` span and a flex child, and they had
 * drifted. Declared rows had no hover state and no `truncate`, so a long
 * property name pushed its own value off the row; undeclared rows had both.
 * Neither carried the kind icon, even though `kindMeta(kind).icon` is the same
 * map the table header, the settings panel and the add-property catalog all
 * already draw from — every surface in the app said what kind a property was
 * except the one where you edit it.
 *
 * The gutter grew from 96px to 116px, which is the icon plus its gap: the NAME
 * has the same room it always had, and the row gained a glyph rather than
 * spending the name's width on one.
 */

/** Label column, in px. Icon (13) + gap (6) + the 96px names always had. */
export const PROPERTY_LABEL_W = 116;

export interface PropertyRowProps {
  /**
   * Chooses the leading icon. Undeclared keys have no declared kind — pass
   * `inferKindFromValue(...)`, which reads the stored shape.
   */
  kind: FieldKind;
  /** Raw field name; humanized for display and for the tooltip. */
  name: string;
  /** The value control. */
  children: React.ReactNode;
  /**
   * Overrides the kind icon. For the rows that are not properties at all —
   * a doc's Type — where a kind glyph would be a lie.
   */
  icon?: string;
  /**
   * `center` for a control that is one line tall by construction (an input, a
   * switch). `start` keeps a multi-value field's wrapped chips aligned to the
   * label rather than centred against a three-line block.
   */
  align?: 'start' | 'center';
  /** Revealed on hover or focus at the end of the row, e.g. Remove. */
  trailing?: React.ReactNode;
  /**
   * Makes the NAME a menu trigger, which is where Notion puts it (M16.7).
   * Omitted for rows with no schema behind them — a doc's Type, an
   * undeclared key — where there would be nothing for the menu to edit.
   */
  menu?: (args: { close: () => void }) => React.ReactNode;
  /**
   * Turns the kind icon into a drag grip on hover (M16.8). Spread from
   * `useSortableList().gripProps`. The two share one 13px cell, so a row
   * neither grows nor shifts when the pointer crosses it.
   */
  grip?: GripProps;
  /** Says what dragging this actually changes. */
  gripHint?: string;
  /** The insertion line, from `useSortableList().dropIndicator(index)`. */
  style?: React.CSSProperties;
  /** Dimmed while it is the row being dragged. */
  dragging?: boolean;
}

export function PropertyRow({
  kind,
  name,
  children,
  icon,
  align = 'start',
  trailing,
  menu,
  grip,
  gripHint,
  style,
  dragging = false,
}: PropertyRowProps) {
  const label = humanize(name);
  const nameRef = useRef<HTMLElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // Tooltip the name only when it is actually cut off. A tooltip that repeats
  // text already on screen is noise, and this one lands on top of the row
  // above it — the first live look at M16.6 showed "Priority" covering
  // "Status" for a name that fitted with room to spare.
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = nameRef.current;
    if (el === null) return;
    const check = () => setClipped(el.scrollWidth > el.clientWidth + 1);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [label]);

  const nameClass = [
    'min-w-0 flex-1 truncate rounded-[5px] text-left text-[12px] text-[var(--n-500)]',
    align === 'center' ? '' : 'pt-[3px]',
  ].join(' ');

  return (
    <div
      data-testid="property-row"
      data-property={name}
      style={style}
      // -mx-1/px-1: the hover background has to reach past the text on both
      // sides or it reads as a highlight on the label rather than on the row.
      className={[
        'group -mx-1 flex min-w-0 gap-1.5 rounded-[6px] px-1',
        'hover:bg-[var(--n-25)]',
        align === 'center' ? 'items-center' : 'items-start',
        dragging ? 'opacity-40' : '',
      ].join(' ')}
    >
      <span
        className={[
          'flex min-w-0 flex-none items-center gap-1.5',
          align === 'center' ? '' : 'pt-[3px]',
        ].join(' ')}
        style={{ width: PROPERTY_LABEL_W }}
      >
        {/* Icon and grip occupy the same 13px cell — Notion swaps them in
            place, and a grip that appended itself would shove every name a
            glyph to the right the moment the pointer arrived. */}
        <span className="relative flex h-[13px] w-[13px] flex-none items-center justify-center">
          <Icon
            name={icon ?? kindMeta(kind).icon}
            size={13}
            color="var(--n-400)"
            className={grip === undefined ? undefined : 'group-hover:opacity-0'}
          />
          {grip !== undefined && (
            <Tooltip label={gripHint ?? ''}>
              <span
                {...grip}
                // Opacity, not `hidden`: a hidden grip is out of the tab
                // order, and arrow-key reordering is the whole point of the
                // primitive underneath this.
                className="absolute inset-0 flex cursor-grab items-center justify-center rounded-[3px] text-[var(--n-400)] opacity-0 hover:bg-[var(--n-100)] hover:text-[var(--n-600)] focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Icon name="grip-vertical" size={13} />
              </span>
            </Tooltip>
          )}
        </span>
        {/* Suppressed while the menu is open, where it would sit on top of
            the very thing it opened. */}
        <Tooltip label={label} disabled={menuOpen || !clipped}>
          {menu === undefined ? (
            <span ref={nameRef} className={nameClass}>
              {label}
            </span>
          ) : (
            <button
              ref={nameRef as React.RefObject<HTMLButtonElement>}
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={`${label} property menu`}
              onClick={() => setMenuOpen((v) => !v)}
              className={`${nameClass} border-0 bg-transparent p-0 hover:bg-[var(--n-100)] hover:text-[var(--n-700)]`}
            >
              {label}
            </button>
          )}
        </Tooltip>
      </span>
      <div className="min-w-0 flex-1">{children}</div>
      {trailing}
      {menu !== undefined && menuOpen && (
        <Popover
          anchorRef={nameRef}
          onClose={() => setMenuOpen(false)}
          role="menu"
          ariaLabel={`${label} property`}
          trapFocus
        >
          {menu({ close: () => setMenuOpen(false) })}
        </Popover>
      )}
    </div>
  );
}

/** The reveal-on-hover-OR-focus shape for a row's trailing action. `hidden
 * group-hover:` takes the control out of the tab order entirely, so a keyboard
 * user cannot reach it at all. */
export const ROW_ACTION =
  'inline-flex flex-none opacity-0 group-hover:opacity-100 focus-within:opacity-100';
