/**
 * Getting a column's ratio onto the element the browser lays out (M48.1).
 *
 * BlockNote nests a block as
 *
 *   .bn-block-outer > .bn-block > .bn-block-content
 *
 * and hangs the block's CHILDREN off `.bn-block` as a sibling `.bn-block-group`.
 * A column list turns that group into a flex row, so the flex ITEM is each
 * column's `.bn-block-outer` — two levels above the `[data-content-type=
 * "column"]` element that carries the ratio. CSS custom properties inherit
 * downward and `:has()` cannot match an arbitrary number, so the value has to
 * be carried up in script.
 *
 * It is done from the editor rather than from inside the column's own render
 * because a `useLayoutEffect` in a ProseMirror node view runs BEFORE
 * ProseMirror attaches that node view to the document — measured, and the
 * effect never found its ancestor at all. Called on mount and after every
 * document change, this runs when the tree is real.
 */

import { useEffect } from 'react';
import { DEFAULT_COLUMN_WIDTH } from '@/engine/pageColumns';

/**
 * The attribute a column's ratio arrives on.
 *
 * Written by BLOCKNOTE, not by our render: it hoists a custom block's props
 * onto the content element as data attributes — and MEASURED, it omits any
 * prop still sitting at its declared default. So `width: 2` renders
 * `data-width="2"` and `width: 1` renders no attribute at all, which is the
 * same deviations-only rule this codebase serializes by, arrived at from the
 * other direction. An absent attribute therefore means the default, never
 * "unknown".
 */
const WIDTH_ATTRIBUTE = 'data-width';

/** The custom property the column CSS reads. */
export const COLUMN_WIDTH_PROPERTY = '--cb-column-width';

/**
 * Copy every column's ratio onto its flex item. Returns how many it moved, so
 * a caller (and a test) can tell "no columns on this page" from "the DOM shape
 * changed under us and this silently stopped working" — the failure mode that
 * would otherwise render every column at ratio 1 with no error anywhere.
 */
export function syncColumnWidths(root: ParentNode): number {
  let moved = 0;
  for (const column of root.querySelectorAll(`[data-content-type="column"]`)) {
    const outer = column.closest('[data-node-type="blockOuter"]');
    if (!(outer instanceof HTMLElement)) continue;
    const declared = column.getAttribute(WIDTH_ATTRIBUTE) ?? String(DEFAULT_COLUMN_WIDTH);
    if (outer.style.getPropertyValue(COLUMN_WIDTH_PROPERTY) !== declared) {
      outer.style.setProperty(COLUMN_WIDTH_PROPERTY, declared);
    }
    moved += 1;
  }
  return moved;
}

/**
 * Keep every column's ratio in sync with the DOM, for as long as the editor is
 * mounted.
 *
 * A MutationObserver rather than a change handler because the DOM this reads
 * is written by ProseMirror on its own schedule — after `onChange`, after the
 * effect that loaded the document, and again on undo, on a remote edit, and
 * whenever a node view re-renders. Watching the tree covers all of those with
 * one rule instead of a list of hooks that will be one short.
 *
 * Coalesced to an animation frame: a keystroke can fire several mutations and
 * the work is a `querySelectorAll` over the whole editor.
 */
export function useColumnWidths(host: { current: HTMLElement | null }): void {
  useEffect(() => {
    const root = host.current;
    if (root === null) return;
    let frame: number | null = null;
    const sync = () => {
      frame = null;
      syncColumnWidths(root);
    };
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(sync);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true, attributes: true });
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
    // The host element is stable for the component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
