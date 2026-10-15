import React, { useCallback, useRef, useState } from 'react';
import { useDragGesture } from '@/hooks/useDragGesture';
import { snapDelta, type TimeSlot } from '@/engine/timeGrid';

/**
 * Dragging a record along a date axis (M16.23, M16.24).
 *
 * The three time views had zero drag handlers between them: every chip and bar
 * was a click-only `<button>`, so the one gesture a calendar exists for —
 * "this happens on Thursday, not Tuesday" — meant opening the record and
 * retyping a date. This is the gesture, once, for all three.
 *
 * It is not a fourth DnD system. `useSortableList` (M16.2) reorders a list by
 * SLOT INDEX, which a date axis has no notion of: a calendar drop lands on a
 * calendar day and a timeline drop lands wherever the pixels say, and neither
 * is "position 3 of 7". What the two share — the window listeners, the
 * `(e.button ?? 0)` guard jsdom forces, commit-on-release, and a keyboard path
 * so the gesture is not pointer-only — is copied deliberately and noted here so
 * a later phase can lift the common half out of both. M46.2 lifted the first
 * piece of it: the claim on Escape and the teardown an unmount runs are
 * `useDragGesture` now, shared with every other pointer loop in the app.
 *
 * Whole-day axes keep their times unchanged. An hours grid opts into a
 * minute axis, with snapped moves and empty-space selections (M61.9).
 */

/** What a gesture moves: the whole span, or one of its two endpoints. */
export type DragEdge = 'move' | 'start' | 'end';

export interface TimeDragState {
  id: string;
  edge: DragEdge;
  /** Days the gesture currently represents; negative moves earlier. */
  days: number;
  minutes: number;
}

export interface TimeDragHandle {
  ref: (el: HTMLElement | null) => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

export interface TimeDrag {
  /** Spread onto the grabbable element — the bar, the chip, or an edge grip. */
  handleProps: (id: string, edge?: DragEdge) => TimeDragHandle;
  slotProps: (day: string) => { onPointerDown: (e: React.PointerEvent) => void };
  selection: (TimeSlot & { day: string }) | null;
  /**
   * The day under the pointer, as a delta from the day the gesture began, for
   * views whose geometry wraps. Ignored when no gesture is live.
   */
  hover: (days: number) => void;
  /** The gesture in flight, for drawing the preview. */
  drag: TimeDragState | null;
  /**
   * True exactly once after a gesture that actually moved something.
   *
   * A pointerup at the end of a drag still fires `click` on the element the
   * gesture started on, so without this every successful drag ALSO opened the
   * record it had just rescheduled.
   */
  consumeClick: () => boolean;
}

export interface TimeDragOptions {
  /**
   * Horizontal pixels one day occupies. Given, the pointer's x delta becomes
   * days by itself — the timeline and gantt case. Omitted, the view reports
   * the day under the pointer through `hover` instead, because a month grid
   * wraps and horizontal pixels stop meaning elapsed time at the week's edge.
   */
  pxPerDay?: number;
  /** Days one grid ROW is worth: 7 on a calendar, 0 on a linear axis. */
  rowDays?: number;
  /** Vertical pixels per minute; omitted on whole-day axes. */
  pxPerMinute?: number;
  snapMinutes?: number;
  dayLocked?: boolean;
  onSelect?: (day: string, slot: TimeSlot) => void;
  /** Apply only a nonzero day or minute change. */
  onCommit: (id: string, edge: DragEdge, days: number, minutes: number) => void;
  /** No date field, or a read-only surface. */
  disabled?: boolean;
}

export function useTimeDrag({
  pxPerDay,
  rowDays = 0,
  pxPerMinute,
  snapMinutes = 30,
  dayLocked = false,
  onSelect,
  onCommit,
  disabled = false,
}: TimeDragOptions): TimeDrag {
  const [drag, setDrag] = useState<TimeDragState | null>(null);
  const [selection, setSelection] = useState<(TimeSlot & { day: string }) | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const live = useRef<TimeDragState | null>(null);
  const moved = useRef(false);
  /** The gesture's claim on Escape, and the teardown an unmount runs (M46.2). */
  const gesture = useDragGesture();

  // Latest-ref: the window listeners below are attached once per gesture and
  // must not commit through a stale callback if a render lands mid-drag.
  const latest = useRef({ onCommit, pxPerDay, pxPerMinute, snapMinutes, dayLocked, onSelect });
  latest.current = { onCommit, pxPerDay, pxPerMinute, snapMinutes, dayLocked, onSelect };

  /** Move focus with the element, which React remounts under its new day. */
  const refocus = useCallback((key: string) => {
    requestAnimationFrame(() => elements.current.get(key)?.focus());
  }, []);

  const commit = useCallback(
    (state: TimeDragState, key: string, viaPointer: boolean) => {
      if (state.days === 0 && state.minutes === 0) return;
      // Only a POINTER gesture is followed by a click to swallow. Setting this
      // on the keyboard path too would eat the next real click on the bar.
      if (viaPointer) moved.current = true;
      latest.current.onCommit(state.id, state.edge, state.days, state.minutes);
      refocus(key);
    },
    [refocus],
  );

  const onPointerDown = useCallback(
    (id: string, edge: DragEdge, key: string) => (e: React.PointerEvent) => {
      // `?? 0`: jsdom implements no PointerEvent, so React reads `button` as
      // null off a synthetic one and a bare `!== 0` rejects every test drag.
      if (disabled || (e.button ?? 0) !== 0) return;
      // Suppress the native text selection a drag across labels would start.
      // Focus is then restored by hand — preventDefault on a <button> also
      // cancels the focus that makes the keyboard path reachable.
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLElement).focus();
      const originX = e.clientX;
      const originY = e.clientY;
      const begin: TimeDragState = { id, edge, days: 0, minutes: 0 };
      live.current = begin;
      setDrag(begin);

      const update = (days: number, minutes: number) => {
        if (
          live.current === null ||
          (live.current.days === days && live.current.minutes === minutes)
        )
          return;
        live.current = { ...live.current, days, minutes };
        setDrag(live.current);
      };
      const stop = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        live.current = null;
        setDrag(null);
      };
      const move = (ev: PointerEvent) => {
        const {
          pxPerDay: px,
          pxPerMinute: minutePx,
          snapMinutes: snap,
          dayLocked: locked,
        } = latest.current;
        const days = locked
          ? 0
          : px !== undefined && px > 0
            ? Math.round((ev.clientX - originX) / px)
            : (live.current?.days ?? 0);
        const minutes =
          minutePx !== undefined && minutePx > 0
            ? snapDelta((ev.clientY - originY) / minutePx, snap)
            : 0;
        update(days, minutes);
      };
      const up = () => {
        const state = live.current;
        gesture.end();
        if (state !== null) commit(state, key, true);
      };
      const cancel = () => gesture.end();
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
      /**
       * Escape abandons the gesture. Without it the only way out of a drag
       * begun by accident is to drop it somewhere and drag it back.
       *
       * The key used to be taken here, on `window` in the BUBBLE phase with no
       * `stopPropagation` and no layer — so it abandoned the bar AND closed the
       * record panel or dialog behind it, one press for two dismissals (M46.2).
       * `useDragGesture` claims it in the capture phase and pushes a `'gesture'`
       * layer for the drag's life instead, which is also what makes the
       * teardown survive an unmount: a gesture the view outlived kept its window
       * listeners, and the release still reached `onCommit` — a write from a
       * view no longer on screen.
       *
       * Nothing is committed until the release, so stripping the preview IS the
       * restore, and the release then finds nothing live to write.
       */
      gesture.begin(stop);
    },
    [disabled, commit, gesture],
  );

  const onKeyDown = useCallback(
    (id: string, edge: DragEdge, key: string) => (e: React.KeyboardEvent) => {
      if (disabled) return;
      const horizontal = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
      const vertical = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
      const hours = pxPerMinute !== undefined;
      const days = dayLocked ? 0 : horizontal !== 0 ? horizontal : hours ? 0 : vertical * rowDays;
      const minutes = hours ? vertical * snapMinutes : 0;
      if (days === 0 && minutes === 0) return;
      e.preventDefault();
      e.stopPropagation();
      // Shift on a whole bar drags its END instead — the keyboard equivalent
      // of grabbing the right-hand grip, which has no keyboard of its own
      // while it is a 6px strip you have to see to aim at.
      const which: DragEdge = edge === 'move' && e.shiftKey ? 'end' : edge;
      commit({ id, edge: which, days, minutes }, key, false);
    },
    [disabled, rowDays, pxPerMinute, snapMinutes, dayLocked, commit],
  );

  const handleProps = useCallback(
    (id: string, edge: DragEdge = 'move'): TimeDragHandle => {
      // Composite: a bar and its two grips are three elements over one record.
      const key = `${id}:${edge}`;
      return {
        ref: (el: HTMLElement | null) => {
          if (el === null) elements.current.delete(key);
          else elements.current.set(key, el);
        },
        onPointerDown: onPointerDown(id, edge, key),
        onKeyDown: onKeyDown(id, edge, key),
      };
    },
    [onPointerDown, onKeyDown],
  );

  const hover = useCallback((days: number) => {
    if (latest.current.dayLocked || live.current === null || live.current.days === days) return;
    live.current = { ...live.current, days };
    setDrag(live.current);
  }, []);

  const consumeClick = useCallback(() => {
    const was = moved.current;
    moved.current = false;
    return was;
  }, []);

  const slotProps = useCallback(
    (day: string) => ({
      onPointerDown: (e: React.PointerEvent) => {
        const { pxPerMinute: px, snapMinutes: snap, onSelect: select } = latest.current;
        if (
          disabled ||
          select === undefined ||
          px === undefined ||
          px <= 0 ||
          (e.button ?? 0) !== 0
        )
          return;
        if (
          e.target instanceof Element &&
          e.target.closest('button, input, textarea, [data-calendar-handle]')
        )
          return;
        e.preventDefault();
        const top = e.currentTarget.getBoundingClientRect().top;
        const minute = (y: number) =>
          Math.max(0, Math.min(1440 - snap, Math.floor((y - top) / px / snap) * snap));
        const origin = minute(e.clientY);
        let current = { day, start: origin, end: origin + snap };
        setSelection(current);
        const move = (event: PointerEvent) => {
          const at = minute(event.clientY);
          current = {
            day,
            start: Math.min(origin, at),
            end: Math.min(1440, Math.max(origin, at) + snap),
          };
          setSelection(current);
        };
        const stop = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', cancel);
          setSelection(null);
        };
        const up = () => {
          const slot = current;
          gesture.end();
          moved.current = true;
          latest.current.onSelect?.(day, { start: slot.start, end: slot.end });
        };
        const cancel = () => gesture.end();
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', cancel);
        gesture.begin(stop);
      },
    }),
    [disabled, gesture],
  );

  return { handleProps, slotProps, selection, hover, drag, consumeClick };
}
