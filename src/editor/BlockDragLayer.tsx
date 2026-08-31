/**
 * The editor's block drag (M48.4).
 *
 * BlockNote ships one, built on the browser's HTML5 drag-and-drop. It works,
 * and it is invisible to every test we can write: MEASURED, neither
 * Playwright's `dragTo` nor a hand-stepped mouse drag moves a block or touches
 * the file. So the drag was a thing we could ship changes to and never verify
 * — which is how "it moves, but feels wrong" stays that way.
 *
 * This is a pointer-event drag instead, on the same `useDragGesture` the
 * record canvas, the board, the table and the dashboard already use (M46.2).
 * It is testable end to end, it can paint an insertion line where the block
 * would land, and it can drop INTO a column, which the one it replaces could
 * not do at all.
 *
 * The geometry is in `blockDrop.ts` and is pure. This file is the DOM: what to
 * measure, what to paint, and what to tell the editor when the pointer comes
 * up.
 */

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useDragGesture } from '@/hooks/useDragGesture';
import {
  dropSpotsFrom,
  isNoOpDrop,
  nearestDropSpot,
  type BlockBox,
  type DropSpot,
} from './blockDrop';

/** How far the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD = 4;

/**
 * Every block in the editor, in document order, measured.
 *
 * The dragged block and everything inside it are left out: a block cannot land
 * within itself, and offering the line would be offering to delete the
 * subtree. `depth` is counted rather than declared — the DOM already says how
 * deeply a block is nested, and a second source for it could disagree.
 */
export function measureBlocks(root: HTMLElement, excludeId: string | null): BlockBox[] {
  const boxes: BlockBox[] = [];
  const excluded =
    excludeId === null
      ? null
      : root.querySelector(`[data-node-type="blockOuter"][data-id="${cssEscape(excludeId)}"]`);
  for (const node of root.querySelectorAll('[data-node-type="blockOuter"]')) {
    if (!(node instanceof HTMLElement)) continue;
    const id = node.getAttribute('data-id');
    if (id === null) continue;
    if (excluded !== null && (node === excluded || excluded.contains(node))) continue;
    const rect = node.getBoundingClientRect();
    if (rect.height === 0) continue;
    let depth = 0;
    for (let up = node.parentElement; up !== null && root.contains(up); up = up.parentElement) {
      if (up.matches('[data-node-type="blockOuter"]')) depth += 1;
    }
    boxes.push({
      id,
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      depth,
    });
  }
  return boxes;
}

/** Every block with its parent, in document order — what `isNoOpDrop` reads. */
export function measureParentage(root: HTMLElement): { id: string; parentId: string | null }[] {
  const out: { id: string; parentId: string | null }[] = [];
  for (const node of root.querySelectorAll('[data-node-type="blockOuter"]')) {
    if (!(node instanceof HTMLElement)) continue;
    const id = node.getAttribute('data-id');
    if (id === null) continue;
    const parent = node.parentElement?.closest('[data-node-type="blockOuter"]');
    out.push({ id, parentId: parent?.getAttribute('data-id') ?? null });
  }
  return out;
}

/** Attribute selectors take a quoted value; ids are uuids, but never assume. */
const cssEscape = (value: string): string => value.replace(/["\\]/g, '\\$&');

export interface BlockDragProps {
  /** The block this grip belongs to. */
  blockId: string;
  /** The editor's own host element — what gets measured. */
  hostRef: { current: HTMLElement | null };
  /** Commit: move `blockId` to the spot. */
  onDrop: (spot: DropSpot) => void;
  /** The control the drag is attached to — BlockNote's own handle button. */
  children: React.ReactNode;
}

/**
 * Drag, wrapped around the control that already exists.
 *
 * BlockNote's `DragHandleButton` is a MENU trigger that also happens to be
 * `draggable`. Replacing it outright would mean rebuilding its menu; adding a
 * second grip beside it would mean two controls in a six-pixel gutter that
 * nobody can aim at. So this wraps it: the native drag is switched off in CSS
 * (`-webkit-user-drag: none`, see editor.css) and a pointer drag runs in its
 * place, while a press that never travels stays a click and opens the menu
 * exactly as before.
 *
 * The press is not swallowed and nothing is `preventDefault`ed on pointerdown,
 * because that is what would eat the click the menu needs.
 */
export function BlockGrip({ blockId, hostRef, onDrop, children }: BlockDragProps) {
  const gesture = useDragGesture();
  const [spot, setSpot] = useState<DropSpot | null>(null);

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const root = hostRef.current;
    if (root === null) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let spots: DropSpot[] = [];
    let parentage: { id: string; parentId: string | null }[] = [];
    let current: DropSpot | null = null;

    const onMove = (move: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(move.clientX - startX, move.clientY - startY) < DRAG_THRESHOLD) return;
        dragging = true;
        // Measured ONCE, when the drag actually begins. Re-measuring per move
        // would be a layout read on every pointer event, and nothing under the
        // pointer moves until the drop commits.
        spots = dropSpotsFrom(measureBlocks(root, blockId));
        parentage = measureParentage(root);
        root.classList.add('cb-block-dragging');
      }
      current = nearestDropSpot(spots, move.clientX, move.clientY);
      setSpot(isNoOpDrop(parentage, blockId, current) ? null : current);
    };

    const teardown = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      root.classList.remove('cb-block-dragging');
      setSpot(null);
    };

    function onUp() {
      const landed = current;
      const moved = dragging;
      const noop = isNoOpDrop(parentage, blockId, landed);
      // Ends the gesture (and runs teardown) BEFORE committing: the commit
      // re-renders the document out from under the listeners this installed.
      gesture.end();
      if (moved && landed !== null && !noop) onDrop(landed);
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    gesture.begin(teardown);
  };

  return (
    <span
      data-testid="block-grip"
      data-block={blockId}
      // `display: contents` — no box of its own. BlockNote MEASURES the side
      // menu to position it, so a wrapper that occupies space is a wrapper
      // that changes where the menu sits and, worse, feeds its own size back
      // into the next measurement. Events still reach this handler by
      // bubbling from the button inside; only layout is opted out of.
      className="contents"
      onPointerDown={onPointerDown}
    >
      {children}
      {spot !== null && <DropLine spot={spot} />}
    </span>
  );
}

/**
 * Where the block would land.
 *
 * In a portal, positioned in viewport coordinates: the line has to be able to
 * sit against a block inside a column, and one drawn inside the editor's own
 * scroll box would be clipped by the first ancestor that hides its overflow.
 * The colour and thickness are M46.2's measured values — 4px at 43% of our
 * accent — so the editor's line and the record canvas's are the same line.
 */
function DropLine({ spot }: { spot: DropSpot }) {
  return createPortal(
    <span
      data-testid="block-drop-line"
      data-block={spot.blockId}
      data-placement={spot.placement}
      className="pointer-events-none fixed z-[88] h-1 rounded-none bg-cortex-500/43"
      style={{ top: spot.y - 2, left: spot.left, width: Math.max(0, spot.right - spot.left) }}
    />,
    document.body,
  );
}
