import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Arrow-key navigation for row-based layouts (M9.6).
 *
 * Rows were `<div role="row">` with an `onClick` and no `tabIndex` — mouse
 * only, which is an accessibility gap before it is an ergonomic one. This is
 * a roving-tabindex implementation: the container is the tab stop, and the
 * arrows move an internal cursor rather than tabbing through every row in a
 * list that might be hundreds long.
 */
export interface RowKeyboard {
  /** Index of the focused row, or -1. */
  index: number;
  /** Props for the scroll container. */
  containerProps: {
    tabIndex: number;
    onKeyDown: (e: React.KeyboardEvent) => void;
    onBlur: (e: React.FocusEvent) => void;
  };
  /** Props for row `index`. */
  rowProps: (i: number) => { 'data-focused'?: 'true'; ref?: (el: HTMLElement | null) => void };
  setIndex: (i: number) => void;
}

export function useRowKeyboard(options: {
  count: number;
  onOpen: (index: number) => void;
  /** Space toggles expansion where the layout has any. */
  onToggle?: (index: number) => void;
  onEscape?: () => void;
}): RowKeyboard {
  const { count, onOpen, onToggle, onEscape } = options;
  const [index, setIndex] = useState(-1);
  const rows = useRef<(HTMLElement | null)[]>([]);

  // A list that shrinks under the cursor must not leave it pointing past the
  // end — filtering or a delete would otherwise strand focus nowhere.
  useEffect(() => {
    setIndex((i) => (i >= count ? count - 1 : i));
  }, [count]);

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

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Never steal keys from an editor inside a cell.
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
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
        case 'Home':
          e.preventDefault();
          setIndex(0);
          break;
        case 'End':
          e.preventDefault();
          setIndex(count - 1);
          break;
        case 'Enter':
          if (index >= 0) {
            e.preventDefault();
            onOpen(index);
          }
          break;
        case ' ':
          if (index >= 0 && onToggle !== undefined) {
            e.preventDefault();
            onToggle(index);
          }
          break;
        case 'Escape':
          setIndex(-1);
          onEscape?.();
          break;
      }
    },
    [count, index, move, onOpen, onToggle, onEscape],
  );

  return {
    index,
    containerProps: {
      tabIndex: 0,
      onKeyDown,
      // Dropping the cursor on blur keeps a stale highlight from reading as
      // "this row is selected" when focus has moved elsewhere entirely.
      onBlur: (e: React.FocusEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setIndex(-1);
      },
    },
    rowProps: (i: number) =>
      i === index
        ? { 'data-focused': 'true', ref: (el: HTMLElement | null) => (rows.current[i] = el) }
        : { ref: (el: HTMLElement | null) => (rows.current[i] = el) },
    setIndex,
  };
}
