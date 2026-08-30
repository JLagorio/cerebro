import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Grip } from '@/components/ui/Grip';
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
 * The gutter grew from 96px to the icon plus its gap: the row gained a glyph
 * rather than spending the name's width on one.
 *
 * M46.2 Task 7 fits the whole row to the measured anatomy (reference §A.1):
 * 34px of content with the 4px that completes the 38px pitch living in the
 * container's gap, a 120px label column, and ONE lit region — the label cell.
 * The name's own box narrows to 84px in the bargain, because the cell's 6px
 * of padding is inside the measured 120; the clipped-name tooltip that has
 * been here since M16.6 is what keeps that readable.
 */

/**
 * Label column, in px — the measured 120 (§A2), `flex-shrink: 0`.
 *
 * It was 116 while the icon slot was 13 (M16.6) and the cell had no padding.
 * Notion spends the same 120 as 6 + 18 + 6 + 84 + 6: the cell's padding is
 * INSIDE the column, so the name box is 84px rather than the 96 it had.
 */
export const PROPERTY_LABEL_W = 120;

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
   * `useSortableList().gripProps`. The two share one 18 x 24 cell — the
   * `row` grip's slot — so a row neither grows nor shifts when the pointer
   * crosses it.
   */
  grip?: GripProps;
  /** Says what dragging this actually changes. */
  gripHint?: string;
  /**
   * The row's slot while a drag is live, from `useSortableList().rowStyle`.
   * Nothing while one is not.
   *
   * It used to be an insertion line and a dim. Notion's list reorder has
   * neither: the rows themselves move, and the gap that opens is the whole of
   * the indicator (M46.2, reference §C-I).
   */
  style?: React.CSSProperties;
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
}: PropertyRowProps) {
  const label = humanize(name);
  const [menuOpen, setMenuOpen] = useState(false);

  // Tooltip the name only when it is actually cut off. A tooltip that repeats
  // text already on screen is noise, and this one lands on top of the row
  // above it — the first live look at M16.6 showed "Priority" covering
  // "Status" for a name that fitted with room to spare.
  const [clipped, setClipped] = useState(false);
  const watcher = useRef<ResizeObserver | null>(null);
  /**
   * A CALLBACK ref, not an effect over a ref object, because the node this
   * measures is REPLACED by the very state it sets.
   *
   * `Tooltip` renders its child bare while disabled and inside a fragment
   * once enabled, so React unmounts the old name element and mounts a new one
   * the moment `clipped` turns true. An effect keyed on the label never
   * re-runs across that swap: it kept observing the detached node, which
   * reports `0/0`, and the next callback set `clipped` straight back to false
   * — for good, since nothing would ever measure the live node again.
   *
   * Measured in the browser at M46.2 Task 8, on the two demo-vault labels the
   * 84px name box newly clips ("Key result count", "Current value"): the
   * tooltip was silent on both. Re-attaching per node is the whole fix.
   */
  const nameNode = useRef<HTMLElement | null>(null);
  const nameRef = useCallback((el: HTMLElement | null) => {
    // The menu anchors on whatever node is live, so it is kept here too.
    nameNode.current = el;
    watcher.current?.disconnect();
    watcher.current = null;
    if (el === null) return;
    const check = () => setClipped(el.scrollWidth > el.clientWidth + 1);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    watcher.current = ro;
  }, []);
  useEffect(() => () => watcher.current?.disconnect(), []);

  // 14 / 400 / 20 in the panel (§A8). It was 12px, the step below our values —
  // the label is the same size as its value in Notion and reads as secondary
  // by COLOUR, not by size.
  //
  // Ours sets values at 13, so a 14px label is one step ABOVE the thing it
  // names. Task 8 ruled on that in the browser rather than on the number: at
  // 1x the panel reads correctly, because `--n-500` against `--n-800` is a far
  // stronger cue than 1px of size and the value still leads; at 2.2x the
  // inversion is visible but nobody reads a panel at 2.2x. It STAYS, as
  // recorded debt — closing it properly means 14px values, which reaches every
  // `FieldEditor` control including the grid's, and that is a type-ramp
  // decision, not a drag-slice one.
  //
  // What the ruling did surface is the real cost of the 84px name box: it
  // clips two of the demo vault's 52 panel labels where 96px clipped none —
  // and the tooltip that covers them was broken. See `nameRef` above.
  const nameClass = 'min-w-0 flex-1 truncate text-left text-md leading-md text-n-500';

  return (
    <div
      data-testid="property-row"
      data-property={name}
      style={style}
      // -mx-1.5 answers the label cell's own `px-1.5`: the cell is what paints
      // now, and its 6px of padding would otherwise push every glyph and name
      // 6px right of the panel's content edge.
      className={[
        'group -mx-1.5 flex min-w-0',
        // 34px of content; the 4px that makes the 38px pitch is the
        // CONTAINER's gap, so it stays outside every hover target (§A1).
        'min-h-[34px]',
        align === 'center' ? 'items-center' : 'items-start',
      ].join(' ')}
    >
      <span
        // The label CELL, and the row's one hover region (§A3, §A4, §A6). The
        // row itself no longer washes and neither does the value: three lit
        // regions at once was the baseline's worst single anatomy delta, and
        // a row that lights label AND value reads as two buttons rather than
        // as one label with a value.
        //
        // 20ms, declared (M46.2 Task 3): a property list is read by running
        // the pointer down it, and an undeclared wash strobes on the way past.
        className={[
          'flex min-h-[34px] min-w-0 flex-none items-center gap-1.5 rounded-sm px-1.5',
          'select-none text-n-500 motion-hover hover:bg-n-50',
          // A label with no menu behind it opens nothing, so it does not
          // claim a pointer. Notion has no such row; every one of its labels
          // is a menu trigger.
          menu === undefined ? '' : 'cursor-pointer',
        ].join(' ')}
        style={{ width: PROPERTY_LABEL_W }}
      >
        {/* Icon and grip occupy the same 18 x 24 cell (§A10, §B1) — Notion
            swaps them in place, and a grip that appended itself would shove
            every name a glyph to the right the moment the pointer arrived.
            The cell is the grip's slot, so its size is the primitive's: the
            13px cell this used to be made a 169px² target where Notion's is
            432px² (M46.2 Task 6).

            Both halves carry `motion-move`, which turns the swap from a hard
            cut into the cross-fade the reference measured (§B1). Notion times
            this one at 0.15s and its gutter cluster at 0.2s; we spend the
            movement token for both rather than mint a third number for a
            difference nobody can see. The grip has no wash of its own at all
            now (§B4): the label cell's is the row's one highlight, and a grip
            that painted its own put a second, smaller one inside it. */}
        <span className="relative flex h-6 w-[18px] flex-none items-center justify-center">
          <Icon
            name={icon ?? kindMeta(kind).icon}
            size={16}
            color="var(--n-400)"
            className={grip === undefined ? undefined : 'motion-move group-hover:opacity-0'}
          />
          {grip !== undefined && (
            <Tooltip label={gripHint ?? ''}>
              <Grip
                {...grip}
                // Opacity, not `hidden`: a hidden grip is out of the tab
                // order, and arrow-key reordering is the whole point of the
                // primitive underneath this.
                className="absolute inset-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
              />
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
              ref={nameRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={`${label} property menu`}
              onClick={() => setMenuOpen((v) => !v)}
              // No wash of its own: the cell it sits in is what lights (§A4),
              // and a button that painted too would be a second highlight
              // inside the first.
              className={`${nameClass} cursor-pointer border-0 bg-transparent p-0`}
            >
              {label}
            </button>
          )}
        </Tooltip>
      </span>
      {/* The label -> value gap is a 4px MARGIN on the value column, not a
          column gap (§A2) — the gap belongs to the value, so the label cell's
          wash runs the full 120px and stops exactly at the column's edge. */}
      <div className="ml-1 min-w-0 flex-1">{children}</div>
      {trailing}
      {menu !== undefined && menuOpen && (
        <Popover
          anchorRef={nameNode}
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
