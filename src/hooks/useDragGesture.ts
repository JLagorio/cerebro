import { useCallback, useEffect, useId, useMemo, useRef } from 'react';
import { popLayer, pushLayer } from '@/components/ui/layers';

/**
 * A live drag owns Escape (M46.2).
 *
 * Task 1 established the mechanism inside `useSortableList`; the audit found
 * the same class of defect on five more surfaces, so it lives here now instead
 * of being retyped per drag loop. Two shapes, because our drags come in two:
 *
 * - `useDragGesture` — the hand-written pointer loops (the table's column
 *   reorder and column resize, the panel resize handles, the dashboard seam
 *   and row edge, the editor's pane splitter, the time views' bar drag). They
 *   have no cancel of their own, so this both CLAIMS the key and swallows it.
 * - `useDndGesture` — the dnd-kit surfaces (the layout canvas, the board, the
 *   dashboard). dnd-kit already cancels correctly on Escape, so this claims
 *   the key WITHOUT swallowing it. See that hook's own note: swallowing here
 *   would cancel nothing at all.
 *
 * Both push a `'gesture'` layer, and the surfaces a drag is drawn inside — the
 * record panel, a dialog, a popover — all defer through the `ownsEscape` they
 * already ask. `'gesture'` and not `'surface'`: nothing opened, so a focus trap
 * must not think it has been superseded, and a global handler must not stand
 * down for `hasLayers()` for the length of a drag it has nothing to do with.
 */

export interface DragGesture {
  /**
   * Claim Escape for a gesture that has just begun, and say what ends it.
   *
   * - `teardown` — everything the gesture installed: its window listeners and
   *   whatever it painted. Run by `end()`, by an Escape with no `cancel` of
   *   its own, and by an unmount that catches the gesture still live. It must
   *   never commit; a commit belongs to the release path alone.
   * - `cancel` — optional. Given, Escape runs THIS instead of `teardown`, and
   *   `teardown` stays armed for the release and for an unmount. One caller
   *   needs it: the table's column drag, whose release still has to swallow
   *   the click it produces on a header that is also a menu trigger, so its
   *   `pointerup` listener has to outlive the cancel.
   *
   * A `begin` over a gesture already in flight ends that one first. Two live
   * loops over one surface would each fire on the same release.
   */
  begin: (teardown: () => void, cancel?: () => void) => void;
  /**
   * The release path: unclaims Escape and runs the teardown. Idempotent, and
   * a no-op when nothing is in flight.
   */
  end: () => void;
}

export function useDragGesture(): DragGesture {
  const layerId = useId();
  /**
   * The live gesture's teardown, held outside React state because a gesture
   * outlives the render that began it — and because the listeners it must
   * remove are closures a later render could never match.
   */
  const teardown = useRef<(() => void) | null>(null);
  /** Removes only what this hook installed, leaving the site's own listeners. */
  const unclaim = useRef<(() => void) | null>(null);

  const end = useCallback(() => {
    unclaim.current?.();
    unclaim.current = null;
    const run = teardown.current;
    teardown.current = null;
    run?.();
  }, []);

  const begin = useCallback(
    (onTeardown: () => void, onCancel?: () => void) => {
      end();
      teardown.current = onTeardown;
      /**
       * Capture on `window` — the node the pointer listeners already use and
       * the first one every keystroke reaches, so nothing nested sees the key
       * at all. `stopImmediatePropagation`, not `stopPropagation`: the
       * surfaces a drag sits inside listen on `window` themselves
       * (`DetailPanel`) and the latter governs only travel BETWEEN nodes,
       * never siblings on one.
       *
       * The layer is what settles PRECEDENCE, which listener order cannot:
       * ordering between `window` listeners is only whoever registered first.
       */
      const onEscape = (ev: KeyboardEvent) => {
        if (ev.key !== 'Escape') return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        if (onCancel === undefined) {
          end();
          return;
        }
        unclaim.current?.();
        unclaim.current = null;
        onCancel();
      };
      unclaim.current = () => {
        window.removeEventListener('keydown', onEscape, true);
        popLayer(layerId);
      };
      pushLayer(layerId, { kind: 'gesture' });
      window.addEventListener('keydown', onEscape, true);
    },
    [end, layerId],
  );

  // A gesture caught by an unmount leaks in two directions at once: its window
  // listeners stay attached to a component that no longer exists, and its
  // layer sits on top of the stack forever, so every later Escape in the app
  // finds it there instead of the surface it was aimed at.
  useEffect(() => () => end(), [end]);

  // Memoised: call sites hold this inside a `useCallback` that starts the
  // gesture, and a fresh object every render would rebuild that callback —
  // and with it every header the drag is bound to — on every render.
  return useMemo(() => ({ begin, end }), [begin, end]);
}

/**
 * The same claim for a dnd-kit `DndContext`, wired through its own lifecycle
 * events (M46.2).
 *
 * dnd-kit's `handleKeydown` calls `handleCancel()` from a `document` BUBBLE
 * listener with no `preventDefault` and no `stopPropagation`, so on our
 * surfaces one Escape cancelled the drag AND closed the layout editor dialog
 * behind it. The fix is NOT a capture listener that swallows the key — that
 * would stop the event before dnd-kit's own handler ever ran, and cancel
 * nothing. It is the layer alone: the dialog, the panel and the popover all
 * defer through `ownsEscape`, and dnd-kit's cancel still runs.
 *
 * `onDragCancel` and `onDragStart` are the reason this is a hook and not three
 * copies: none of the three call sites declared either before this.
 */
export interface DndGestureProps<E> {
  onDragStart: () => void;
  onDragEnd: (event: E) => void;
  onDragCancel: () => void;
}

export function useDndGesture<E>(onDragEnd: (event: E) => void): DndGestureProps<E> {
  const layerId = useId();
  const live = useRef(false);
  // Latest-ref: the handler is a fresh closure every render, and the props
  // this returns are read by dnd-kit at drag time, not at render time.
  const latest = useRef(onDragEnd);
  latest.current = onDragEnd;

  const release = useCallback(() => {
    if (!live.current) return;
    live.current = false;
    popLayer(layerId);
  }, [layerId]);

  useEffect(() => () => release(), [release]);

  return {
    onDragStart: useCallback(() => {
      live.current = true;
      pushLayer(layerId, { kind: 'gesture' });
    }, [layerId]),
    // Released BEFORE the handler runs: a commit may open a toast or a dialog,
    // and that surface has to land on a stack the finished drag has left.
    onDragEnd: useCallback(
      (event: E) => {
        release();
        latest.current(event);
      },
      [release],
    ),
    onDragCancel: release,
  };
}
