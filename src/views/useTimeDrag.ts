import React, { useCallback, useRef, useState } from 'react';

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
 * a later phase can lift the common half out of both.
 *
 * Everything is measured in WHOLE DAYS. A drag never produces a fraction of a
 * day, because a date property cannot store one.
 */

/** What a gesture moves: the whole span, or one of its two endpoints. */
export type DragEdge = 'move' | 'start' | 'end';

export interface TimeDragState {
  id: string;
  edge: DragEdge;
  /** Days the gesture currently represents; negative moves earlier. */
  days: number;
}

export interface TimeDragHandle {
  ref: (el: HTMLElement | null) => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

export interface TimeDrag {
  /** Spread onto the grabbable element — the bar, the chip, or an edge grip. */
  handleProps: (id: string, edge?: DragEdge) => TimeDragHandle;
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
  /** Apply the move. Never called with `days === 0`. */
  onCommit: (id: string, edge: DragEdge, days: number) => void;
  /** No date field, or a read-only surface. */
  disabled?: boolean;
}

export function useTimeDrag({
  pxPerDay,
  rowDays = 0,
  onCommit,
  disabled = false,
}: TimeDragOptions): TimeDrag {
  const [drag, setDrag] = useState<TimeDragState | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const live = useRef<TimeDragState | null>(null);
  const moved = useRef(false);

  // Latest-ref: the window listeners below are attached once per gesture and
  // must not commit through a stale callback if a render lands mid-drag.
  const latest = useRef({ onCommit, pxPerDay });
  latest.current = { onCommit, pxPerDay };

  /** Move focus with the element, which React remounts under its new day. */
  const refocus = useCallback((key: string) => {
    requestAnimationFrame(() => elements.current.get(key)?.focus());
  }, []);

  const commit = useCallback(
    (state: TimeDragState, key: string, viaPointer: boolean) => {
      if (state.days === 0) return;
      // Only a POINTER gesture is followed by a click to swallow. Setting this
      // on the keyboard path too would eat the next real click on the bar.
      if (viaPointer) moved.current = true;
      latest.current.onCommit(state.id, state.edge, state.days);
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
      (e.currentTarget as HTMLElement).focus();
      const originX = e.clientX;
      const begin: TimeDragState = { id, edge, days: 0 };
      live.current = begin;
      setDrag(begin);

      const update = (days: number) => {
        if (live.current === null || live.current.days === days) return;
        live.current = { ...live.current, days };
        setDrag(live.current);
      };
      const stop = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        window.removeEventListener('keydown', onKey);
        live.current = null;
        setDrag(null);
      };
      const move = (ev: PointerEvent) => {
        const px = latest.current.pxPerDay;
        if (px === undefined || px <= 0) return;
        update(Math.round((ev.clientX - originX) / px));
      };
      const up = () => {
        const state = live.current;
        stop();
        if (state !== null) commit(state, key, true);
      };
      // Escape abandons the gesture. Without it the only way out of a drag
      // begun by accident is to drop it somewhere and drag it back.
      const cancel = () => stop();
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') stop();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
      window.addEventListener('keydown', onKey);
    },
    [disabled, commit],
  );

  const onKeyDown = useCallback(
    (id: string, edge: DragEdge, key: string) => (e: React.KeyboardEvent) => {
      if (disabled) return;
      const horizontal = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
      const vertical = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
      const days = horizontal !== 0 ? horizontal : vertical * rowDays;
      if (days === 0) return;
      e.preventDefault();
      // Shift on a whole bar drags its END instead — the keyboard equivalent
      // of grabbing the right-hand grip, which has no keyboard of its own
      // while it is a 6px strip you have to see to aim at.
      const which: DragEdge = edge === 'move' && e.shiftKey ? 'end' : edge;
      commit({ id, edge: which, days }, key, false);
    },
    [disabled, rowDays, commit],
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
    if (live.current === null || live.current.days === days) return;
    live.current = { ...live.current, days };
    setDrag(live.current);
  }, []);

  const consumeClick = useCallback(() => {
    const was = moved.current;
    moved.current = false;
    return was;
  }, []);

  return { handleProps, hover, drag, consumeClick };
}
