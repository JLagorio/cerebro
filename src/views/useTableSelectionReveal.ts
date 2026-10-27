import { useEffect, type RefObject } from 'react';
import type { Entry } from '@/engine/types';

// Only this existing nonwrapped editable text scalar gains a resting clip mode.
const RESTING_TEXT_BOX =
  ".cb-row > [role='gridcell'][data-field-kind='text'] > .cb-cell-chrome.items-center > button[data-cell-primary] > span.truncate";

type SelectedRange = {
  range: Range;
  start: Node;
  startOffset: number;
  startValue: string | null;
  end: Node;
  endOffset: number;
  endValue: string | null;
  row: Element | null;
  path: string | null;
};
function selectedRange(): SelectedRange | null {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  if (range.collapsed) return null;
  const row = element(range.startContainer)?.closest('.cb-row[data-path]') ?? null;
  return {
    range,
    start: range.startContainer,
    startOffset: range.startOffset,
    startValue: range.startContainer.textContent,
    end: range.endContainer,
    endOffset: range.endOffset,
    endValue: range.endContainer.textContent,
    row,
    path: row?.getAttribute('data-path') ?? null,
  };
}
function sameRange(a: SelectedRange | null, b: SelectedRange | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.start === b.start &&
    a.end === b.end &&
    a.startOffset === b.startOffset &&
    a.endOffset === b.endOffset &&
    a.startValue === b.startValue &&
    a.endValue === b.endValue &&
    a.row === b.row &&
    a.path === b.path
  );
}
function element(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

/** Reveal an existing non-pointer selection, without opening a cell or moving
 * focus. Native/browser Find can select text that ellipsis never paints. The
 * actual selected text stays in place; only its existing scroll boxes move.
 * No query, search index, editor, persisted state or per-row subscription. */
export function useTableSelectionReveal(
  host: RefObject<HTMLElement | null>,
  { entries, vault, scope }: { entries: readonly Entry[]; vault: string | null; scope: string },
): void {
  useEffect(() => {
    const grid = host.current;
    if (grid === null) return;
    const inactive = () =>
      grid.closest('[inert], [data-parked="true"], [data-testid="pane"][data-active="false"]') !==
      null;
    let frame = 0;
    let pointerFrame = 0;
    let pointerDown = false;
    // Persist the completed pointer range too: selectionchange may arrive after
    // pointerup, and normal drag selection must never become a Find reveal.
    let pointerRange: SelectedRange | null = null;
    let blocked = selectedRange();
    let pending: SelectedRange | null = null;
    let current: {
      box: HTMLElement;
      row: HTMLElement;
      path: string;
      value: string | null;
      selected: SelectedRange;
      attribute: string | null;
      scrollLeft: number;
      restingClip: boolean;
      glyphClipAttribute: string | null;
    } | null = null;
    const clear = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      pending = null;
      if (current === null) return;
      // Restore the owned scroll while a resting-clip box is still promoted
      // and scrollable; removing its attribute first would demote it too soon.
      current.box.scrollLeft = current.scrollLeft;
      if (current.restingClip) {
        if (current.glyphClipAttribute === null)
          current.box.removeAttribute('data-selection-reveal-clip');
        else current.box.setAttribute('data-selection-reveal-clip', current.glyphClipAttribute);
      }
      if (current.attribute === null) current.box.removeAttribute('data-selection-reveal');
      else current.box.setAttribute('data-selection-reveal', current.attribute);
      current = null;
    };
    const eligible = (selected: SelectedRange) => {
      if (
        !grid.isConnected ||
        !selected.start.isConnected ||
        !selected.end.isConnected ||
        inactive() ||
        !grid.contains(selected.start) ||
        !grid.contains(selected.end)
      )
        return null;
      const start = element(selected.start);
      const end = element(selected.end);
      const cell = start?.closest<HTMLElement>('.cb-row > [role="gridcell"][data-field-kind]');
      const row = cell?.closest<HTMLElement>('.cb-row[data-path]');
      const path = row?.getAttribute('data-path');
      if (
        !start ||
        !end ||
        !cell ||
        !row ||
        !path ||
        !cell.contains(end) ||
        start.closest('input, textarea, [contenteditable="true"]') ||
        end.closest('input, textarea, [contenteditable="true"]')
      )
        return null;
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        grid.contains(active) &&
        (active.matches('input, textarea') || active.isContentEditable)
      )
        return null;
      // Admit the original hidden-overflow truncators, plus only the exact
      // resting text box that can become scrollable for this one selection.
      for (
        let box: HTMLElement | null = start instanceof HTMLElement ? start : start.parentElement;
        box !== null && box !== cell;
        box = box.parentElement
      ) {
        const style = getComputedStyle(box);
        const restingClip =
          box.matches(RESTING_TEXT_BOX) && style.overflowX === 'clip' && style.overflowY === 'clip';
        if (
          box.contains(end) &&
          (style.overflowX === 'hidden' || restingClip) &&
          (style.textOverflow === 'ellipsis' || box === current?.box)
        ) {
          return { box, cell, row, path, restingClip };
        }
      }
      return null;
    };
    const reveal = (selected: SelectedRange) => {
      if (
        !sameRange(selected, selectedRange()) ||
        sameRange(selected, pointerRange) ||
        sameRange(selected, blocked) ||
        pointerDown
      )
        return;
      const target = eligible(selected);
      if (target === null) {
        clear();
        return;
      }
      if (current?.box !== target.box) {
        clear();
        current = {
          ...target,
          value: target.box.textContent,
          selected,
          attribute: target.box.getAttribute('data-selection-reveal'),
          scrollLeft: target.box.scrollLeft,
          glyphClipAttribute: target.restingClip
            ? target.box.getAttribute('data-selection-reveal-clip')
            : null,
        };
        // A reused scalar starts with ellipsis; preserve any prior marker for clear.
        if (current.restingClip) target.box.removeAttribute('data-selection-reveal-clip');
      } else current.selected = selected;
      target.box.setAttribute('data-selection-reveal', 'true');
      if (current.restingClip) {
        const promoted = getComputedStyle(target.box);
        if (promoted.overflowX !== 'hidden' || promoted.overflowY !== 'hidden') {
          clear();
          return;
        }
      }
      target.cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      // Keep a resting scalar's ellipsis unless this original Range has no
      // glyph rectangle. Legacy truncators keep their existing clip behavior.
      const positiveRects = () => {
        const union = selected.range.getBoundingClientRect();
        return union.width > 0 && union.height > 0
          ? [union]
          : Array.from(selected.range.getClientRects()).filter(
              (rect) => rect.width > 0 && rect.height > 0,
            );
      };
      let rects = positiveRects();
      if (current.restingClip && rects.length === 0) {
        if (!sameRange(selected, selectedRange()) || eligible(selected)?.box !== target.box) {
          clear();
          return;
        }
        target.box.setAttribute('data-selection-reveal-clip', 'true');
        // WebKit may hide ellipsized glyph geometry. Re-read this same Range;
        // never replace the Selection, text, nodes or dimensions to reveal it.
        rects = positiveRects();
      }
      if (rects.length === 0 || !sameRange(selected, selectedRange())) return;
      const left = Math.min(...rects.map((rect) => rect.left));
      const right = Math.max(...rects.map((rect) => rect.right));
      const bounds = target.box.getBoundingClientRect();
      const width = right - left;
      const delta =
        width > bounds.width
          ? left - bounds.left
          : right > bounds.right
            ? right - bounds.right
            : left < bounds.left
              ? left - bounds.left
              : 0;
      target.box.scrollLeft = Math.max(
        0,
        Math.min(target.box.scrollWidth - target.box.clientWidth, target.box.scrollLeft + delta),
      );
    };
    const onSelection = () => {
      const selected = selectedRange();
      if (pointerDown) {
        pointerRange = selected;
        return;
      }
      if (selected === null) {
        blocked = null;
        pointerRange = null;
        clear();
        return;
      }
      if (sameRange(selected, pointerRange) || sameRange(selected, blocked)) return;
      cancelAnimationFrame(frame);
      pending = selected;
      frame = requestAnimationFrame(() => {
        frame = 0;
        pending = null;
        reveal(selected);
      });
    };
    const onPointerDown = () => {
      cancelAnimationFrame(frame);
      pending = null;
      cancelAnimationFrame(pointerFrame);
      pointerDown = true;
      pointerRange = selectedRange();
    };
    const onPointerEnd = () => {
      cancelAnimationFrame(pointerFrame);
      pointerFrame = requestAnimationFrame(() => {
        pointerFrame = 0;
        pointerDown = false;
        pointerRange = selectedRange();
        if (
          pointerRange === null ||
          (current !== null &&
            (!current.box.contains(pointerRange.start) || !current.box.contains(pointerRange.end)))
        )
          clear();
      });
    };
    const onWindowBlur = () => {
      cancelAnimationFrame(pointerFrame);
      pointerFrame = 0;
      pointerDown = false;
      pointerRange = selectedRange();
      cancelAnimationFrame(frame);
      pending = null;
    };
    const invalidate = () => {
      // A parked/inactive pane stays mounted. Its own attributes do not
      // mutate the grid subtree, so observe that one host with this observer.
      if (inactive() && (pending !== null || current !== null)) {
        blocked = selectedRange();
        clear();
        return;
      }
      if (
        (pending !== null && !sameRange(pending, selectedRange())) ||
        (current !== null &&
          (!grid.contains(current.box) ||
            !current.row.isConnected ||
            current.row.getAttribute('data-path') !== current.path ||
            current.box.textContent !== current.value ||
            !sameRange(current.selected, selectedRange())))
      ) {
        blocked = selectedRange();
        clear();
      }
    };
    const observer = new MutationObserver(invalidate);
    observer.observe(grid, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-path'],
    });
    const pane = grid.closest('[data-testid="pane"]');
    if (pane !== null)
      observer.observe(pane, {
        attributes: true,
        attributeFilter: ['data-active', 'data-parked', 'inert'],
      });
    document.addEventListener('selectionchange', onSelection);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerEnd, true);
    document.addEventListener('pointercancel', onPointerEnd, true);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      observer.disconnect();
      document.removeEventListener('selectionchange', onSelection);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerEnd, true);
      document.removeEventListener('pointercancel', onPointerEnd, true);
      window.removeEventListener('blur', onWindowBlur);
      cancelAnimationFrame(pointerFrame);
      clear();
    };
  }, [host, entries, vault, scope]);
}
