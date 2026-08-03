import React, { useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Popover } from '@/components/ui/Popover';
import { Tooltip } from '@/components/ui/Tooltip';
import { humanize } from '@/detail/FieldEditor';
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
}

export function PropertyRow({
  kind,
  name,
  children,
  icon,
  align = 'start',
  trailing,
  menu,
}: PropertyRowProps) {
  const label = humanize(name);
  const labelRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const labelClass = [
    'flex flex-none items-center gap-1.5 rounded-[5px] text-left text-[12px] text-[var(--n-500)]',
    align === 'center' ? '' : 'pt-[3px]',
  ].join(' ');
  const glyph = <Icon name={icon ?? kindMeta(kind).icon} size={13} color="var(--n-400)" />;
  const text = <span className="min-w-0 truncate">{label}</span>;

  return (
    <div
      data-testid="property-row"
      data-property={name}
      // -mx-1/px-1: the hover background has to reach past the text on both
      // sides or it reads as a highlight on the label rather than on the row.
      className={[
        'group -mx-1 flex min-w-0 gap-1.5 rounded-[6px] px-1',
        'hover:bg-[var(--n-25)]',
        align === 'center' ? 'items-center' : 'items-start',
      ].join(' ')}
    >
      {/* The name is what truncates, so it is the name that needs the
          tooltip — 116px runs out at about 14 characters. Suppressed while
          the menu is open, where it would sit on top of what it opened. */}
      <Tooltip label={label} disabled={menuOpen}>
        {menu === undefined ? (
          <span className={labelClass} style={{ width: PROPERTY_LABEL_W }}>
            {glyph}
            {text}
          </span>
        ) : (
          <button
            ref={labelRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`${label} property menu`}
            onClick={() => setMenuOpen((v) => !v)}
            style={{ width: PROPERTY_LABEL_W }}
            className={`${labelClass} border-0 bg-transparent p-0 hover:bg-[var(--n-100)] hover:text-[var(--n-700)]`}
          >
            {glyph}
            {text}
          </button>
        )}
      </Tooltip>
      <div className="min-w-0 flex-1">{children}</div>
      {trailing}
      {menu !== undefined && menuOpen && (
        <Popover
          anchorRef={labelRef}
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
