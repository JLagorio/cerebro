import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { popLayer, pushLayer } from '@/components/ui/layers';

/**
 * One reorderable list, operable by pointer AND keyboard (M16.2).
 *
 * Three unrelated drag systems preceded this: `@dnd-kit/core`, HTML5
 * `dataTransfer` (FileTree, the inbox file drop), and hand-rolled
 * `pointermove` (ResizeHandle, the table's column resize and reorder, and the
 * view settings property list, whose comment says outright that it is a copy
 * of the table's). No census of who imports which — that list has already
 * rotted once; what is load-bearing is the MECHANISM.
 *
 * This hook is the third kind: its own pointer and key handlers on the grip,
 * no provider and no shared context. That is what lets a list built on it sit
 * INSIDE a dnd-kit `DndContext` without the two ever seeing each other's
 * gestures — the layout editor's canvas holds one around the live tab strip,
 * whose tabs reorder through this hook.
 *
 * Only `ResizeHandle` could be driven from a keyboard. That is the gap this
 * closes: the grip is a real button, and arrow keys move the item one slot
 * per press without a pointer ever being involved. Everything else — the drop
 * indicator, the midpoint slot maths, commit-on-release — is the shape the
 * view settings list already proved, generalised.
 *
 * The one thing it does share with the rest of the app is the LAYER STACK
 * (M46.2), and only to say that a drag in flight owns Escape. That is not a
 * drag context: the stack knows nothing about gestures beyond who a keystroke
 * belongs to, so a list inside a `DndContext` still sees neither.
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

export interface GripProps {
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

  /**
   * The teardown for whatever gesture is in flight — its window listeners and
   * its Escape layer — held outside React state because a gesture outlives the
   * render that began it.
   *
   * It is what makes a SECOND press safe (the first gesture's listeners are
   * closures the second one's `removeEventListener` could never match, so
   * without this both would fire on the same release and the drop would commit
   * twice) and what makes an unmount mid-drag safe: a leaked gesture layer sits
   * on top of the stack forever and every later Escape in the app finds it
   * there instead of the surface it was aimed at.
   */
  const endGesture = useRef<(() => void) | null>(null);
  const layerId = useId();
  useEffect(
    () => () => {
      endGesture.current?.();
      endGesture.current = null;
    },
    [],
  );

  const startDrag = useCallback(
    (id: string) => (e: React.PointerEvent) => {
      // `?? 0`: an event that reports no button is a primary press. jsdom
      // implements no PointerEvent at all, so a bare `!== 0` rejects every
      // synthetic drag — which is why the one pre-M16 pointer drag, carrying
      // this same guard, has no test.
      if (disabled || (e.button ?? 0) !== 0) return;
      e.preventDefault();
      // A press while something is already in flight replaces it rather than
      // stacking on it. Two live gestures over one list would each commit.
      endGesture.current?.();
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
      const end = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        window.removeEventListener('keydown', onEscape, true);
        popLayer(layerId);
        endGesture.current = null;
        setDragging(null);
        setDropSlot(null);
      };
      const up = (ev: PointerEvent) => {
        end();
        const slot = slotAt(ev);
        const from = latest.current.ids.indexOf(id);
        if (from === -1) return;
        // A slot below the row's own position counts that row, which is about
        // to be removed — so the target index is one less than the slot.
        const to = slot > from ? slot - 1 : slot;
        if (to !== from) latest.current.onReorder(id, to);
      };
      /**
       * Escape abandons the gesture (M46.2). Measured before this existed: the
       * key did not cancel, the gesture kept tracking, and the RELEASE THEN
       * COMMITTED the move — the opposite of what the user asked for, and the
       * app has no undo.
       *
       * Cancelling is exactly `end()` without the commit. Nothing has moved on
       * screen yet at this point — this list commits on release only, and the
       * drop indicator is the whole of the drag's visible state — so stripping
       * that state IS the restore. A reflow that moves rows during the drag
       * would put its own undo here, beside the listener teardown.
       *
       * Capture on `window`, the node the pointer listeners already use and the
       * first one every keystroke reaches, so nothing nested sees the key at
       * all. `stopImmediate`, not `stopPropagation`: the surfaces this list
       * sits inside listen on `window` themselves (`DetailPanel`) and the
       * latter governs only travel BETWEEN nodes, never siblings on one.
       */
      const onEscape = (ev: KeyboardEvent) => {
        if (ev.key !== 'Escape') return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        end();
      };
      endGesture.current = end;
      // Ordering between `window` listeners is only whoever registered first,
      // which is the opposite of what precedence needs — so the gesture says on
      // the layer stack that Escape is its own for as long as it lasts, and the
      // record panel, the dialog and the popover all defer through the
      // `ownsEscape` they already ask. `'gesture'` and not `'surface'`: nothing
      // opened, and a focus trap must not think it has been superseded.
      pushLayer(layerId, { kind: 'gesture' });
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      window.addEventListener('keydown', onEscape, true);
    },
    [axis, disabled, layerId],
  );

  const onKeyDown = useCallback(
    (id: string) => (e: React.KeyboardEvent) => {
      if (disabled) return;
      // No Escape here on purpose. An arrow press commits through `onReorder`
      // immediately — there is no staged move for Escape to abandon, so the key
      // belongs to whatever surface the list is drawn inside, exactly as it does
      // when no gesture is running at all. Claiming it would take the record
      // panel's own Escape away from a user whose focus is merely on a grip.
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
