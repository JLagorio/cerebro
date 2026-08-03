import { useCallback, useEffect, useId, useRef, useState } from 'react';

/**
 * Arrow-key navigation for row-based layouts (M9.6).
 *
 * Rows were `<div role="row">` with an `onClick` and no `tabIndex` — mouse
 * only, which is an accessibility gap before it is an ergonomic one. This is
 * a roving-tabindex implementation: the container is the tab stop, and the
 * arrows move an internal cursor rather than tabbing through every row in a
 * list that might be hundreds long.
 *
 * M16.17 added a second axis to it, opt-in. Pass `colCount` and the cursor
 * gains a COLUMN: left/right and Tab move a ring between cells, Enter opens
 * the cell's editor, Escape steps back out to the row. Layouts that pass no
 * `colCount` — the list, the gantt — behave exactly as before, because `col`
 * never leaves -1 and every branch that reads it is gated on that.
 */
export interface RowKeyboard {
  /** Index of the focused row, or -1. */
  index: number;
  /** Column under the cursor, or -1 when the cursor is on the whole row. */
  col: number;
  /** Props for the scroll container. */
  containerProps: {
    tabIndex: number;
    onKeyDown: (e: React.KeyboardEvent) => void;
    onKeyDownCapture: (e: React.KeyboardEvent) => void;
    onBlur: (e: React.FocusEvent) => void;
    onFocus: (e: React.FocusEvent) => void;
    /** Points assistive tech at the cursor row — focus never leaves the
     * container, so without this an arrow press is silent. */
    'aria-activedescendant'?: string;
  };
  /** Props for row `index`. */
  rowProps: (i: number) => {
    id: string;
    'aria-selected': boolean;
    'data-focused'?: 'true';
    ref: (el: HTMLElement | null) => void;
  };
  /**
   * Props for the cell at (row, col). The id is what
   * `aria-activedescendant` points at while the cell cursor is live, and
   * what the hook looks the cell up by when Enter opens its editor — which
   * is why the cursor needs no second ref array.
   */
  cellProps: (row: number, col: number) => { id: string; 'data-cursor'?: 'true' };
  setIndex: (i: number) => void;
  /** Put the cursor on one cell — for a layout that wants a click to move it. */
  setCell: (row: number, col: number) => void;
}

/** What a row must spread to take part in the roving cursor. */
export type RowKeyboardRowProps = ReturnType<RowKeyboard['rowProps']>;
/** What a cell must spread to take part in the cell cursor (M16.17). */
export type RowKeyboardCellProps = ReturnType<RowKeyboard['cellProps']>;

/** The control Enter hands the cell over to. */
const CELL_CONTROL =
  'input:not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** True while the keystroke belongs to an editor rather than to the cursor. */
function inEditor(target: HTMLElement): boolean {
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
}

export function useRowKeyboard(options: {
  count: number;
  onOpen: (index: number) => void;
  /** Space toggles expansion where the layout has any. */
  onToggle?: (index: number) => void;
  onEscape?: () => void;
  /**
   * Number of cells a row renders, in display order. Omit (or 0) and the
   * cursor stays one-dimensional — the M9.6 behaviour, unchanged.
   */
  colCount?: number;
}): RowKeyboard {
  const { count, onOpen, onToggle, onEscape, colCount = 0 } = options;
  const [index, setIndex] = useState(-1);
  const [col, setCol] = useState(-1);
  const rows = useRef<(HTMLElement | null)[]>([]);
  // Stable per instance, so two grids on one screen cannot mint the same
  // descendant id.
  const idBase = useId();
  const rowId = useCallback((i: number) => `${idBase}row-${i}`, [idBase]);
  const cellId = useCallback((r: number, c: number) => `${idBase}cell-${r}-${c}`, [idBase]);

  // A list that shrinks under the cursor must not leave it pointing past the
  // end — filtering or a delete would otherwise strand focus nowhere.
  useEffect(() => {
    setIndex((i) => (i >= count ? count - 1 : i));
  }, [count]);

  // The same for the other axis: hiding a column, or leaving a layout that
  // has cells at all, must not leave the ring on a slot that is not drawn.
  useEffect(() => {
    setCol((c) => (c >= colCount ? colCount - 1 : c));
  }, [colCount]);

  const showCell = useCallback(
    (r: number, c: number) => {
      document
        .getElementById(cellId(r, c))
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    },
    [cellId],
  );

  const move = useCallback(
    (delta: number) => {
      setIndex((i) => {
        const next = Math.min(Math.max(i + delta, 0), count - 1);
        rows.current[next]?.scrollIntoView({ block: 'nearest' });
        return next;
      });
    },
    [count],
  );

  /** Step the cell cursor by `delta`, wrapping onto the neighbouring row. */
  const stepCell = useCallback(
    (delta: 1 | -1) => {
      if (colCount === 0 || count === 0) return;
      const row = index < 0 ? 0 : index;
      const next = col + delta;
      if (next >= 0 && next < colCount) {
        setIndex(row);
        setCol(next);
        showCell(row, next);
        return;
      }
      // Off the end of the row: wrap onto the far side of the neighbouring
      // one, which is what makes Tab a traversal of the whole grid rather
      // than of a single row. At the first and last cell there is nowhere to
      // wrap to, and the cursor stays put.
      const targetRow = row + delta;
      if (targetRow < 0 || targetRow >= count) return;
      const landing = delta === 1 ? 0 : colCount - 1;
      setIndex(targetRow);
      setCol(landing);
      showCell(targetRow, landing);
    },
    [col, colCount, count, index, showCell],
  );

  /** Hand the cell over to whatever control it holds. */
  const openCell = useCallback(
    (r: number, c: number) => {
      const control = document
        .getElementById(cellId(r, c))
        ?.querySelector<HTMLElement>(CELL_CONTROL);
      if (control === null || control === undefined) return;
      control.focus();
      // A control that is not a text field OPENS on click — a select chip, a
      // date, a relation picker. Focusing one only puts a ring on it, which
      // is not what Enter promised.
      if (!(control instanceof HTMLInputElement) && !(control instanceof HTMLTextAreaElement)) {
        control.click();
      }
    },
    [cellId],
  );

  /**
   * Escape's safety net, in the CAPTURE phase (M16.17).
   *
   * `FieldEditor`'s text branch handles Escape itself: it calls
   * `stopPropagation` and unmounts its input to discard the draft. So the
   * bubble handler below never sees the key, and — because removing a
   * focused element fires no blur — focus silently lands on the body while
   * the cursor is still sitting on the cell. The grid then answers no
   * keystrokes at all, and nothing on screen says why.
   *
   * Capture sees the key before the editor does. The recovery is DEFERRED,
   * because the teardown has not happened yet, and CONDITIONAL, because a
   * surface that legitimately claimed focus in the meantime must keep it.
   * Fixing this at the source means an opt-in grid prop on `FieldEditor`,
   * which is a change to the highest-blast-radius file in the app and does
   * not belong in a table phase.
   */
  const onKeyDownCapture = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'Escape' || col < 0) return;
      if (!inEditor(e.target as HTMLElement)) return;
      const container = e.currentTarget as HTMLElement;
      queueMicrotask(() => {
        if (document.activeElement === document.body) container.focus();
      });
    },
    [col],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const container = e.currentTarget as HTMLElement;
      if (inEditor(target)) {
        // Never steal keys from an editor inside a cell — except the one key
        // whose whole job is leaving it. Without this there is no way back to
        // the cursor from an editor the cursor itself opened.
        if (e.key === 'Escape' && col >= 0) {
          e.preventDefault();
          e.stopPropagation();
          target.blur();
          container.focus();
        }
        return;
      }
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          move(index < 0 ? 0 : 1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          move(-1);
          break;
        case 'ArrowRight':
          if (colCount === 0) break;
          e.preventDefault();
          stepCell(1);
          break;
        case 'ArrowLeft':
          if (colCount === 0 || col < 0) break;
          e.preventDefault();
          // Left off column 0 gives the row back rather than wrapping onto
          // the end of the row above: the row cursor is where Enter opens
          // the record, and it has to stay reachable.
          if (col === 0) setCol(-1);
          else stepCell(-1);
          break;
        case 'Tab':
          // Bound only once the cell cursor is live. A grid that swallowed
          // Tab unconditionally would trap every keyboard user who merely
          // tabbed onto it on their way somewhere else.
          if (colCount === 0 || col < 0) break;
          e.preventDefault();
          stepCell(e.shiftKey ? -1 : 1);
          break;
        case 'Home':
          e.preventDefault();
          setIndex(0);
          break;
        case 'End':
          e.preventDefault();
          setIndex(count - 1);
          break;
        case 'Enter':
          if (index < 0) break;
          e.preventDefault();
          if (col >= 0) openCell(index, col);
          else onOpen(index);
          break;
        case ' ':
          if (index >= 0 && onToggle !== undefined) {
            e.preventDefault();
            onToggle(index);
          }
          break;
        case 'Escape':
          // One press, one step out: cell → row → nothing.
          if (col >= 0) {
            e.preventDefault();
            setCol(-1);
            break;
          }
          setIndex(-1);
          onEscape?.();
          break;
      }
    },
    [col, colCount, count, index, move, onEscape, onOpen, onToggle, openCell, stepCell],
  );

  const active = index >= 0 ? (col >= 0 ? cellId(index, col) : rowId(index)) : undefined;

  return {
    index,
    col,
    containerProps: {
      tabIndex: 0,
      onKeyDown,
      onKeyDownCapture,
      // Dropping the cursor on blur keeps a stale highlight from reading as
      // "this row is selected" when focus has moved elsewhere entirely.
      onBlur: (e: React.FocusEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setIndex(-1);
          setCol(-1);
        }
      },
      // Tabbing in used to change nothing on screen and announce nothing, so
      // the whole keyboard path through the grid was invisible: the user had
      // to guess that ArrowDown was what woke it up. Landing the cursor on the
      // first row makes arrival visible and gives aria-activedescendant
      // something to point at.
      onFocus: (e: React.FocusEvent) => {
        if (e.target !== e.currentTarget) return;
        setIndex((i) => (i === -1 && count > 0 ? 0 : i));
      },
      ...(active !== undefined ? { 'aria-activedescendant': active } : {}),
    },
    rowProps: (i: number) => ({
      id: rowId(i),
      'aria-selected': i === index,
      ...(i === index ? ({ 'data-focused': 'true' } as const) : {}),
      ref: (el: HTMLElement | null) => (rows.current[i] = el),
    }),
    cellProps: (row: number, c: number) => ({
      id: cellId(row, c),
      ...(row === index && c === col ? ({ 'data-cursor': 'true' } as const) : {}),
    }),
    setIndex,
    setCell: (row: number, c: number) => {
      setIndex(row);
      setCol(c);
    },
  };
}
