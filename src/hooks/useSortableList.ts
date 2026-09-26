import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useDragGesture } from '@/hooks/useDragGesture';
import {
  clampMain,
  measureRows,
  offsetByRow,
  slotFor,
  slotOffsets,
  orderWith,
  type ListMetrics,
} from '@/hooks/sortableGeometry';

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
 * per press without a pointer ever being involved. Notion's own property rows
 * have no keyboard reorder at all, so this is a place we are AHEAD of the
 * reference and M46.2 kept it that way deliberately.
 *
 * **The drag itself is Notion's C-I grammar** (M46.2 Task 2, measured in
 * `docs/superpowers/specs/2026-08-29-notion-drag-and-row-reference.md`): the
 * press changes nothing, the first movement freezes the list and takes every
 * row out of flow, the REAL row then follows the cursor while its neighbours
 * slide 200ms out of the way, and the opened gap is the only indicator there
 * is. What this used to do — dim the source in place and paint a 2px inset
 * line on the row below — was the other grammar (C-II, for blocks) at half
 * strength, on the family Notion reflows. The line is gone, not restyled, and
 * nothing dims: `dropIndicator` was retired with it.
 *
 * The one thing it does share with the rest of the app is `useDragGesture`
 * (M46.2), and only to say that a drag in flight owns Escape. That is not a
 * drag context either: the layer stack it pushes onto knows nothing about
 * gestures beyond who a keystroke belongs to, so a list inside a `DndContext`
 * still sees neither.
 */

/**
 * The state hook a live list reorder puts on the document root, so other
 * surfaces can suppress hover affordances while a row is in the air.
 *
 * Notion's is `body.is-dragging` and carries no CSS rules at all — measured,
 * not assumed. Ours carries none either yet; it is here so a surface that
 * needs to know has something to ask, and it follows the teardown discipline
 * `cb-resizing` and `cb-col-dragging` already keep: added on the first move,
 * removed by the teardown that Escape, the release and an unmount all run.
 */
export const LIST_DRAGGING_CLASS = 'cb-dragging';

export interface SortableList {
  /**
   * Put this on the element whose children are the rows, in order.
   *
   * It must be a real box: a drag freezes it to its measured size and takes
   * its rows out of flow, and `display: contents` has nothing to freeze.
   */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Spread onto the grip. It is a button so it can be tabbed to. */
  gripProps: (id: string, index: number) => GripProps;
  /**
   * The id currently being dragged. NOT for dimming — the dragged row keeps
   * `opacity: 1` and is lifted by `z-index` alone (§C-I.3) — but a row may
   * have its own reason to know.
   */
  dragging: string | null;
  /** Spread onto the container. Freezes it for the length of the drag. */
  containerStyle: React.CSSProperties | undefined;
  /** Spread onto row `index`. Its slot, or the cursor for the dragged row. */
  rowStyle: (index: number) => React.CSSProperties | undefined;
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

/** The live gesture, as everything the rows have to be drawn with. */
interface DragState {
  id: string;
  /** The dragged row's index in the order that was measured. */
  from: number;
  /** The slot a release would land it in. */
  slot: number;
  /** Its leading edge right now, following the cursor. */
  pos: number;
  metrics: ListMetrics;
  box: { width: number; height: number };
  /**
   * Whether the freeze frame has been PAINTED, and so whether the siblings may
   * animate yet.
   *
   * The freeze takes every row out of flow and places it at its slot in one
   * commit. A row's computed transform before that commit is `none`, so a
   * `transition: transform` declared in the same commit interpolates from the
   * identity — every row slides in from the container's origin over 200ms the
   * instant a drag begins. Measured in the re-measurement pass (M46.2 Task 8)
   * on a three-row list: the third row rendered 56px above its slot on the
   * first frame and crawled back over eight, and the artifact grows with the
   * list. So the freeze frame declares no transition at all, and the movement
   * token arrives on the frame after the one that painted it.
   */
  primed: boolean;
}

const px = (value: string): number => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Where `top: 0` lands for an out-of-flow child, and the size the container
 * has to be told to keep once every row has left the flow.
 *
 * The origin is the PADDING edge, which is where an absolutely positioned box
 * with `top: 0; left: 0` sits — not the border box `getBoundingClientRect`
 * reports. A bordered container would otherwise shift every row by its border.
 */
function readContainer(el: HTMLElement) {
  const box = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const top = px(style.borderTopWidth);
  const left = px(style.borderLeftWidth);
  // `width`/`height` mean the border box under Tailwind's preflight, which
  // sets `box-sizing: border-box` on everything, and the content box without
  // it. Freezing the wrong one would grow the list by its own padding.
  const bordered = style.boxSizing === 'border-box';
  const cut = (a: number, b: number) => (bordered ? 0 : a + b);
  return {
    origin: { top: box.top + top, left: box.left + left },
    box: {
      width:
        box.width -
        cut(left + px(style.borderRightWidth), px(style.paddingLeft) + px(style.paddingRight)),
      height:
        box.height -
        cut(top + px(style.borderBottomWidth), px(style.paddingTop) + px(style.paddingBottom)),
    },
  };
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
  const [drag, setDrag] = useState<DragState | null>(null);

  // Latest-ref: the pointer listeners below are attached once per gesture and
  // must not close over a stale `ids` if a render lands mid-drag.
  const latest = useRef({ ids, onReorder });
  latest.current = { ids, onReorder };

  /**
   * The drag's claim on Escape, its supersede-the-last-press rule, and the
   * teardown an unmount runs — all three the shared hook's (M46.2 Task 1b,
   * which found five more loops needing exactly this and lifted it out).
   */
  const gesture = useDragGesture();

  const startDrag = useCallback(
    (id: string) => (e: React.PointerEvent) => {
      // `?? 0`: an event that reports no button is a primary press. jsdom
      // implements no PointerEvent at all, so a bare `!== 0` rejects every
      // synthetic drag — which is why the one pre-M16 pointer drag, carrying
      // this same guard, has no test.
      if (disabled || (e.button ?? 0) !== 0) return;
      const container = containerRef.current;
      if (container === null) return;
      const rows = Array.from(container.children) as HTMLElement[];
      const from = latest.current.ids.indexOf(id);
      // A list whose rows on screen are not its ids has no honest slot to drop
      // into, and freezing it would place rows against the wrong rects.
      if (from === -1 || rows.length !== latest.current.ids.length) return;
      e.preventDefault();

      /**
       * Measured at grab time, and the press itself changes nothing on screen
       * (§C-I.1) — so these are the rects of a list at rest, which is the only
       * moment they can be read without the drag's own painting in them.
       */
      const { origin, box } = readContainer(container);
      const metrics = measureRows(
        rows.map((r) => r.getBoundingClientRect()),
        origin,
        axis,
      );
      const n = metrics.sizes.length;
      const pressedAt = axis === 'y' ? e.clientY : e.clientX;
      /**
       * The point the cursor holds the row by. It is the PRESS, which is what
       * keeps the grab offset exact — but jsdom implements no PointerEvent, so
       * a synthetic press carries no coordinates at all and the first movement
       * has to be the anchor there. Same 1:1 tracking either way; only the few
       * pixels between the press and the first move differ.
       */
      let grabbedAt = Number.isFinite(pressedAt) ? pressedAt : null;
      // The freeze is drawn with the same layout function the drag is, so the
      // rows land exactly where they already were and nothing twitches.
      const startPos = slotOffsets(metrics, orderWith(n, from, from))[from];

      let slot = from;
      let pos = startPos;
      let started = false;
      /** See `DragState.primed`. False until the freeze frame has painted. */
      let primed = false;
      let priming: number | null = null;

      const track = (ev: PointerEvent) => {
        const along = axis === 'y' ? ev.clientY : ev.clientX;
        grabbedAt ??= along;
        // 1:1 with the cursor, grab offset preserved, clamped to the list.
        pos = clampMain(metrics, from, startPos + (along - grabbedAt));
        slot = slotFor(metrics, from, slot, pos + metrics.sizes[from] / 2);
      };
      const move = (ev: PointerEvent) => {
        track(ev);
        if (!started) {
          started = true;
          document.body.classList.add(LIST_DRAGGING_CLASS);
          // Two frames, not one: a callback registered here runs BEFORE the
          // paint of the frame React commits the freeze in, so priming from it
          // would land the transition in that same paint and animate the very
          // thing it exists to stop. The second frame is the first one that
          // can see the rows already at their slots.
          priming = requestAnimationFrame(() => {
            priming = requestAnimationFrame(() => {
              priming = null;
              primed = true;
              setDrag((cur) => (cur === null || cur.primed ? cur : { ...cur, primed: true }));
            });
          });
        }
        setDrag((cur) =>
          cur !== null && cur.pos === pos && cur.slot === slot && cur.primed === primed
            ? cur
            : { id, from, slot, pos, metrics, box, primed },
        );
      };
      const teardown = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        // A drag shorter than two frames would otherwise prime the NEXT one.
        if (priming !== null) cancelAnimationFrame(priming);
        priming = null;
        document.body.classList.remove(LIST_DRAGGING_CLASS);
        setDrag(null);
      };
      const up = (ev: PointerEvent) => {
        if (started) track(ev);
        // Ends the gesture BEFORE committing: the teardown strips every inline
        // transform in the same frame the new order renders in, so the list
        // lands in static flow already reordered (§C-I.6) instead of settling.
        gesture.end();
        if (!started || slot === from) return;
        if (latest.current.ids.indexOf(id) === -1) return;
        latest.current.onReorder(id, slot);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      /**
       * Escape abandons the gesture (M46.2). Measured before this existed: the
       * key did not cancel, the gesture kept tracking, and the RELEASE THEN
       * COMMITTED the move — the opposite of what the user asked for, and the
       * app has no undo.
       *
       * Cancelling is exactly the teardown without the commit. Everything the
       * drag has moved on screen is drawn from `drag` and from nothing else —
       * the freeze, the slots, the row under the cursor — so dropping that
       * state IS the restore, and the rows fall back into their original flow
       * in the same frame.
       */
      gesture.begin(teardown);
    },
    [axis, disabled, gesture],
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

  /**
   * The list, frozen (§C-I.2): an explicit size holds the space its rows have
   * just left, and `position: relative` makes it what they are placed against.
   */
  const containerStyle = useMemo(
    (): React.CSSProperties | undefined =>
      drag === null
        ? undefined
        : {
            position: 'relative',
            width: `${drag.box.width}px`,
            height: `${drag.box.height}px`,
          },
    [drag],
  );

  /** Every row's resting slot, recomputed when the dragged one changes slot. */
  const slots = useMemo(
    () => (drag === null ? null : offsetByRow(drag.metrics, drag.from, drag.slot)),
    [drag],
  );

  const rowStyle = useCallback(
    (index: number): React.CSSProperties | undefined => {
      if (drag === null || slots === null) return undefined;
      const { metrics } = drag;
      if (index < 0 || index >= metrics.sizes.length) return undefined;
      const held = index === drag.from;
      const main = held ? drag.pos : slots[index];
      const cross = metrics.cross[index];
      const size = metrics.sizes[index];
      const crossSize = metrics.crossSizes[index];
      return {
        position: 'absolute',
        top: 0,
        left: 0,
        // The rows carry their own margins in flow (`-mx-1` on a property row);
        // out of flow those would displace the box that `cross` already
        // measured, so the measurement is the only thing positioning them.
        margin: 0,
        width: `${axis === 'y' ? crossSize : size}px`,
        height: `${axis === 'y' ? size : crossSize}px`,
        transform: `translate(${axis === 'y' ? cross : main}px, ${axis === 'y' ? main : cross}px)`,
        // The row under the cursor must not lag it, and the ones getting out
        // of its way must not teleport (§C-I.3). The 200ms is spelled as the
        // movement token (M46.2 Task 3) rather than as a literal, so this and
        // every other sliding thing stay one number — and so a reader who has
        // asked for reduced motion gets the reflow without the slide.
        //
        // Nobody transitions on the freeze frame: see `DragState.primed`.
        transition: held || !drag.primed ? 'none' : 'transform var(--motion-move)',
        // Lifted by this ALONE: no shadow, no scale, no dimming. What tells you
        // which row you are holding is that it is the one moving.
        zIndex: held ? 1 : undefined,
        cursor: 'grabbing',
      };
    },
    [axis, drag, slots],
  );

  return { containerRef, gripProps, dragging: drag?.id ?? null, containerStyle, rowStyle };
}
