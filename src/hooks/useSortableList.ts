import React, { useCallback, useRef, useState } from 'react';

/**
 * One reorderable list, operable by pointer AND keyboard (M16.2).
 *
 * Three unrelated drag systems preceded this: `@dnd-kit/core` (imported by
 * exactly one component, BoardView), HTML5 `dataTransfer` (FileTree, the
 * inbox file drop), and hand-rolled `pointermove` (ResizeHandle, the table's
 * column resize and reorder, and the view settings property list, whose
 * comment says outright that it is a copy of the table's).
 *
 * Only `ResizeHandle` could be driven from a keyboard. That is the gap this
 * closes: the grip is a real button, and arrow keys move the item one slot
 * per press without a pointer ever being involved. Everything else — the drop
 * indicator, the midpoint slot maths, commit-on-release — is the shape the
 * view settings list already proved, generalised.
 */

export interface SortableList {
  /** Put this on the element whose children are the rows, in order. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Spread onto the grip. It is a button so it can be tabbed to. */
  gripProps: (id: string, index: number) => GripProps;
  /** The id currently being dragged, for dimming it. */
  dragging: string | null;
  /** The slot a release would land in, for the insertion line. */
  dropSlot: number | null;
  /** Convenience for the row: the inset shadow that draws the line. */
  dropIndicator: (index: number) => React.CSSProperties | undefined;
}

interface GripProps {
  ref: (el: HTMLElement | null) => void;
  role: 'button';
  tabIndex: 0;
  'aria-label': string;
  'aria-describedby'?: string;
  'data-sortable-grip': string;
  onPointerDown: (e: React.PointerEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

export interface SortableOptions {
  /** Row ids in their current visual order. */
  ids: string[];
  /** Move `id` so it sits at `toIndex` in the resulting order. */
  onReorder: (id: string, toIndex: number) => void;
  /** Vertical by default; view tabs are horizontal. */
  axis?: 'y' | 'x';
  /** Reordering is meaningless while a list is filtered — the slots on screen
   * are not the slots in the data. */
  disabled?: boolean;
  /** What the grip is a handle for, e.g. "Priority". Used for the label. */
  labelFor?: (id: string) => string;
}

export function useSortableList({
  ids,
  onReorder,
  axis = 'y',
  disabled = false,
  labelFor,
}: SortableOptions): SortableList {
  const containerRef = useRef<HTMLElement | null>(null);
  const gripRefs = useRef(new Map<string, HTMLElement>());
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropSlot, setDropSlot] = useState<number | null>(null);

  // Latest-ref: the pointer listeners below are attached once per gesture and
  // must not close over a stale `ids` if a render lands mid-drag.
  const latest = useRef({ ids, onReorder });
  latest.current = { ids, onReorder };

  const startDrag = useCallback(
    (id: string) => (e: React.PointerEvent) => {
      // `?? 0`: an event that reports no button is a primary press. jsdom
      // implements no PointerEvent at all, so a bare `!== 0` rejects every
      // synthetic drag — which is why the one pre-M16 pointer drag, carrying
      // this same guard, has no test.
      if (disabled || (e.button ?? 0) !== 0) return;
      e.preventDefault();
      const rows = Array.from(containerRef.current?.children ?? []) as HTMLElement[];
      // Measured once, at grab time. Re-measuring per move would read the
      // positions the drop indicator itself has already shifted.
      const mids = rows.map((r) => {
        const box = r.getBoundingClientRect();
        return axis === 'y' ? box.top + box.height / 2 : box.left + box.width / 2;
      });
      const slotAt = (ev: PointerEvent) => {
        const along = axis === 'y' ? ev.clientY : ev.clientX;
        return Math.min(mids.filter((m) => along > m).length, rows.length);
      };
      const move = (ev: PointerEvent) => {
        setDragging(id);
        setDropSlot(slotAt(ev));
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        setDragging(null);
        setDropSlot(null);
        const slot = slotAt(ev);
        const from = latest.current.ids.indexOf(id);
        if (from === -1) return;
        // A slot below the row's own position counts that row, which is about
        // to be removed — so the target index is one less than the slot.
        const to = slot > from ? slot - 1 : slot;
        if (to !== from) latest.current.onReorder(id, to);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    [axis, disabled],
  );

  const onKeyDown = useCallback(
    (id: string) => (e: React.KeyboardEvent) => {
      if (disabled) return;
      const back = axis === 'y' ? 'ArrowUp' : 'ArrowLeft';
      const fwd = axis === 'y' ? 'ArrowDown' : 'ArrowRight';
      if (e.key !== back && e.key !== fwd) return;
      const from = latest.current.ids.indexOf(id);
      if (from === -1) return;
      const to = e.key === back ? from - 1 : from + 1;
      if (to < 0 || to >= latest.current.ids.length) return;
      e.preventDefault();
      latest.current.onReorder(id, to);
      // Focus rides the row. Without this the grip unmounts at its old index
      // and focus falls to <body>, so a second press does nothing and the
      // list can only be reordered one step per tab-back.
      requestAnimationFrame(() => gripRefs.current.get(id)?.focus());
    },
    [axis, disabled],
  );

  const gripProps = useCallback(
    (id: string, index: number): GripProps => ({
      ref: (el: HTMLElement | null) => {
        if (el === null) gripRefs.current.delete(id);
        else gripRefs.current.set(id, el);
      },
      role: 'button',
      tabIndex: 0,
      'aria-label': `Reorder ${labelFor?.(id) ?? id}, position ${index + 1} of ${ids.length}`,
      'data-sortable-grip': id,
      onPointerDown: startDrag(id),
      onKeyDown: onKeyDown(id),
    }),
    [ids.length, labelFor, startDrag, onKeyDown],
  );

  const dropIndicator = useCallback(
    (index: number): React.CSSProperties | undefined => {
      if (dropSlot === null) return undefined;
      const edge = axis === 'y' ? 'bottom' : 'right';
      if (dropSlot === index) {
        return { boxShadow: `inset ${axis === 'y' ? '0 2px' : '2px 0'} 0 var(--cortex-500)` };
      }
      // Dropping past the last row draws on that row's far edge, since there
      // is no row after it to draw on.
      if (dropSlot === ids.length && index === ids.length - 1) {
        return {
          boxShadow: `inset ${edge === 'bottom' ? '0 -2px' : '-2px 0'} 0 var(--cortex-500)`,
        };
      }
      return undefined;
    },
    [dropSlot, ids.length, axis],
  );

  return { containerRef, gripProps, dragging, dropSlot, dropIndicator };
}
