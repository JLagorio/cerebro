import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFocusRestore } from '@/hooks/useFocusRestore';
import type { LayerOptions } from '@/components/ui/layers';
import { isInsideLayerAbove, isTopLayer, ownsEscape, useLayer } from '@/components/ui/layers';

/**
 * The one anchored-surface primitive (M16.1).
 *
 * Nineteen hand-rolled popovers preceded this, each re-deciding how to
 * dismiss, and the ones that forgot are exactly where the bugs were: the
 * add-property surface could only be closed with its Cancel button, and
 * Escape from a kind tile inside it closed the whole record panel.
 *
 * Three things this fixes that the copies could not:
 *
 * - **Dismissal is not optional.** It comes with the component instead of
 *   being a `fixed inset-0` scrim `<button>` the author has to remember, so
 *   there is no version of a popover that lacks it.
 * - **It portals.** The old `FixedBelowAnchor` rendered in place, so a
 *   popover inside `overflow-x-auto` (the view tab strip) was clipped by its
 *   own container. Content now leaves the DOM subtree entirely.
 * - **It flips.** The old wrapper measured once with `deps: []` and only ever
 *   opened downward, so a trigger near the bottom of the window opened a menu
 *   that ran off the screen and clamped into the trigger.
 */

/**
 * "Anything anchored to a moving element should re-measure now."
 *
 * Dispatched on `window` by a host whose layout it moves WITHOUT a resize and
 * without a scroll — a canvas writing a CSS transform on the plane every pan
 * frame and every wheel tick, which is invisible to both signals this file
 * used to listen for.
 */
export const ANCHOR_MOVED_EVENT = 'cerebro:anchor-moved';

const GAP = 4;
const EDGE = 8;

export interface DismissOptions {
  onClose: () => void;
  /** The surface itself. A press inside it is not an outside press. */
  surfaceRef: React.RefObject<HTMLElement | null>;
  /** The trigger, if there is one — see the note in the handler. */
  anchorEl?: () => HTMLElement | null;
  /**
   * What Escape does, when that differs from what click-away does. A
   * multi-step surface steps back rather than discarding the choices made so
   * far, while a click outside it still means "I am done here".
   */
  onEscape?: () => void;
}

/**
 * A surface's place in the layer stack, and the Escape that belongs to it
 * (M16.29).
 *
 * Split out of `useDismiss` for the surfaces that already own their own
 * click-away. `FixedBelowAnchor` — the pre-M16.1 positioner six popovers
 * still mount through, the View settings panel among them — registered no
 * layer at all, so `hasLayers()` answered false with one of them open and the
 * record panel took their Escape: the record closed and the popover was left
 * floating over an empty canvas. They each render their own scrim with their
 * own commit semantics, so `useDismiss` wholesale would silently rewrite what
 * a click away from them does.
 *
 * `onClose` is optional on purpose. Registering is worth doing on its own:
 * a surface the stack cannot see is a surface whose keystrokes land on
 * whatever happens to be behind it.
 *
 * Returns the layer id, so a caller that also needs to know whether it is on
 * top (a focus trap) can reuse it instead of registering a second layer and
 * shadowing itself.
 *
 * `options` describes the layer to the stack — the surface it owns, and its
 * kind for the one non-modal case (a tooltip). See `layers.ts`.
 */
export function useEscapeLayer(onClose: (() => void) | undefined, options?: LayerOptions): string {
  const id = useLayer(options);
  const latest = useRef(onClose);
  latest.current = onClose;

  // Layout phase for the same reason `useLayer` registers there (M16.35): a
  // listener that only exists after the browser has painted is a listener the
  // first keystroke after opening misses, and that keystroke then lands on
  // whatever was already listening — the record panel.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Only the innermost layer reacts, so one keystroke closes one thing.
      if (!ownsEscape(id)) return;
      const close = latest.current;
      // Registered but not listening: swallowing the key here would leave a
      // surface whose Escape belongs to a sibling handler with none at all.
      if (close === undefined) return;
      // stopImmediatePropagation, not stopPropagation: sibling listeners on
      // window would otherwise all still run — stopPropagation only governs
      // travel between nodes, not other handlers on this one.
      e.stopImmediatePropagation();
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [id]);

  return id;
}

/**
 * Click-away and Escape for any dismissable surface (M16.1).
 *
 * Split out of `Popover` because not every surface is anchored — the
 * add-property panel is an inline expander that pushes the layout, and it is
 * precisely the one that shipped with no dismissal at all.
 *
 * Returns the layer id it registered, so a caller that also needs to know
 * whether it is on top (a focus trap) can reuse it instead of registering a
 * second layer and shadowing itself.
 */
export function useDismiss({ onClose, surfaceRef, anchorEl, onEscape }: DismissOptions): string {
  const id = useEscapeLayer(onEscape ?? onClose, {
    // Tell the stack which nodes are this surface's own, so the layers BELOW
    // it can tell a press aimed here from a press aimed past everything.
    contains: (node) => surfaceRef.current?.contains(node) === true,
  });
  const latest = useRef(onClose);
  latest.current = onClose;

  // Outside press. Capture phase on pointerdown, not click: a click fires
  // after mouseup, by which time a drag that started inside and ended outside
  // would read as an outside press and dismiss mid-gesture.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (surfaceRef.current?.contains(target) === true) return;
      // The trigger dismisses through its own onClick toggle. Without this a
      // press on it would close here and reopen there, and the surface would
      // never appear.
      if (anchorEl?.()?.contains(target) === true) return;
      // A press inside a surface stacked ABOVE this one belongs to that
      // surface (M16.35). Escape already asked the stack who owns the
      // keystroke; this asked only its own subtree, and `Popover` portals to
      // `document.body` — so a menu opened from inside this one is not a
      // descendant of it and every click in the child closed the parent out
      // from under the user.
      if (isInsideLayerAbove(id, target)) return;
      // Let an editor inside the surface commit first. Unmounting a subtree
      // never fires blur, so a name typed into a popover's rename box was
      // silently discarded by the very click the user made to accept it.
      // Escape stays destructive — that is what Escape means.
      const active = document.activeElement;
      if (active instanceof HTMLElement && surfaceRef.current?.contains(active) === true) {
        active.blur();
      }
      latest.current();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [surfaceRef, anchorEl, id]);

  return id;
}

export interface PopoverProps {
  onClose: () => void;
  /**
   * What Escape does, when a multi-step surface should step BACK rather than
   * discard the choices made so far. Passed straight to `useDismiss` — a
   * surface must not register its own layer inside this one, because child
   * effects run first and the parent would end up on top of its own child.
   */
  onEscape?: () => void;
  children: React.ReactNode;
  /**
   * The element to anchor to. Omit it and the popover measures the nearest
   * positioned ancestor of where it was rendered, which is what every
   * pre-M16 call site already relies on ("render inside a `relative`
   * wrapper"). Passing a ref is preferred for new code.
   */
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** Keep Tab inside. For menus that own the interaction (property editors). */
  trapFocus?: boolean;
  /** Scrolling the page dismisses. Default true: an anchored surface whose
   * anchor has scrolled away is pointing at nothing. */
  closeOnScroll?: boolean;
  /** Match the trigger's width — for select-like menus. */
  matchAnchorWidth?: boolean;
  className?: string;
  role?: 'menu' | 'listbox' | 'dialog' | 'group';
  ariaLabel?: string;
}

interface Placement {
  left: number;
  top: number;
  width?: number;
}

export function Popover({
  onClose,
  onEscape,
  children,
  anchorRef,
  trapFocus = false,
  closeOnScroll = true,
  matchAnchorWidth = false,
  className,
  role = 'group',
  ariaLabel,
}: PopoverProps) {
  useFocusRestore();

  const markerRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<Placement | null>(null);

  // Latest-ref so the document listeners below can stay mounted once.
  const latestClose = useRef(onClose);
  latestClose.current = onClose;

  const anchorEl = useCallback((): HTMLElement | null => {
    if (anchorRef !== undefined) return anchorRef.current;
    // The marker renders where the popover was written, so its parent is the
    // trigger wrapper — the implicit contract every old call site uses.
    return markerRef.current?.parentElement ?? null;
  }, [anchorRef]);

  const measure = useCallback(() => {
    const anchor = anchorEl();
    const panel = panelRef.current;
    if (anchor === null || panel === null) return;
    const a = anchor.getBoundingClientRect();
    const p = panel.getBoundingClientRect();

    const below = a.bottom + GAP;
    const above = a.top - GAP - p.height;
    // Flip up only when there is genuinely more room up there, so a popover
    // taller than the viewport still opens downward and scrolls rather than
    // opening upward off the top edge.
    const overflowsDown = below + p.height > window.innerHeight - EDGE;
    const fitsUp = above >= EDGE;
    const top =
      overflowsDown && fitsUp ? above : Math.min(below, window.innerHeight - p.height - EDGE);

    setPlace({
      left: Math.max(EDGE, Math.min(a.left, window.innerWidth - p.width - EDGE)),
      top: Math.max(EDGE, top),
      width: matchAnchorWidth ? a.width : undefined,
    });
  }, [anchorEl, matchAnchorWidth]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  // Re-measure when the content changes size — a menu that drills into a
  // submenu grows, and the old wrapper's `deps: []` left it placed for the
  // size it had on the first frame.
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(panel);
    return () => ro.disconnect();
  }, [measure]);

  useEffect(() => {
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    // …and whenever a host says its anchors have moved under it (M29.53). A
    // pan or a wheel-zoom on a canvas moves the anchor by writing a CSS
    // transform on an ancestor, which fires neither `resize` nor the panel's
    // own ResizeObserver — MEASURED on the diagram page: five wheel steps to
    // 161% moved the node by (-358, -214) and left the shape palette at
    // (0, +2.4), still open, hanging over an unrelated part of the diagram.
    // A plain DOM event rather than a context, because this component belongs
    // to the design system and the canvas does not.
    window.addEventListener(ANCHOR_MOVED_EVENT, onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener(ANCHOR_MOVED_EVENT, onResize);
    };
  }, [measure]);

  const layerId = useDismiss({ onClose, surfaceRef: panelRef, anchorEl, onEscape });

  useEffect(() => {
    if (!closeOnScroll) return;
    /**
     * Armed one frame late, and that frame is the whole fix (M18.4).
     *
     * Clicking a trigger that is only partly in view makes the browser scroll
     * it into view, and scroll events are dispatched asynchronously — so the
     * scroll caused by OPENING the popover arrived after it had mounted and
     * dismissed it instantly. On screen that reads as a button that does
     * nothing, and it got worse the further down a long form you went.
     *
     * A user cannot scroll deliberately inside one frame of their own click,
     * so nothing real is lost by waiting for it.
     */
    let armed = false;
    const frame = requestAnimationFrame(() => {
      armed = true;
    });
    const onScroll = (e: Event) => {
      if (!armed) return;
      const target = e.target;
      if (target instanceof Node) {
        if (panelRef.current?.contains(target) === true) return;
        // Same gap as the outside press had (M16.35): scrolling a long menu
        // opened FROM this one is not the page scrolling out from under it,
        // but the nested panel is portalled and so is not inside `panelRef`.
        if (isInsideLayerAbove(layerId, target)) return;
      }
      latestClose.current();
    };
    // Capture: scroll does not bubble, so a scrolling pane deeper in the tree
    // is only observable from above.
    document.addEventListener('scroll', onScroll, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [closeOnScroll, layerId]);

  /**
   * A trapped popover hands focus to its first control ONCE IT IS PLACED
   * (M29.53).
   *
   * `autoFocus` is applied when React inserts the element — and at that moment
   * this panel is still `visibility: hidden`, because `place` is null until the
   * measure below runs. A hidden element cannot take focus, so in a real
   * browser the search box that asked for it never got it: MEASURED on the
   * whiteboard's record picker, `document.activeElement` after opening was the
   * trigger BUTTON, and two ArrowDown presses therefore did nothing at all.
   * jsdom ignores visibility when it decides what is focusable, which is why
   * three unit tests have been asserting the opposite for months.
   *
   * Scoped to `trapFocus`, which is this file's marker for "a surface that
   * expects to own the keyboard" — a bare menu keeps the behaviour it had.
   */
  const placed = place !== null;
  useEffect(() => {
    const panel = panelRef.current;
    if (!trapFocus || !placed || panel === null) return;
    if (panel.contains(document.activeElement)) return;
    const first = panel.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel).focus();
  }, [trapFocus, placed]);

  useEffect(() => {
    if (!trapFocus) return;
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !isTopLayer(layerId)) return;
      const panel = panelRef.current;
      if (panel === null) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const active = document.activeElement;
      const inside = panel.contains(active);
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', onTab, true);
    return () => window.removeEventListener('keydown', onTab, true);
  }, [trapFocus, layerId]);

  const panel = (
    <div
      // z-[1050] sits ABOVE the DS Dialog scrim (z-index 1000) and below the
      // tooltip/toast band (z-[1100]) — the same ordering popovers already
      // have on ordinary surfaces, now preserved inside a dialog too. At
      // z-50 a menu opened from a full-screen Dialog (M29.27's block editor)
      // portalled to document.body and lost the stacking contest to the
      // scrim: invisible, unclickable, and still holding a dismiss layer, so
      // the user's next Escape closed the popover they could not see instead
      // of the dialog. Nothing renders between 50 and 1000 that this needs to
      // stay under, and no popover is ever open while a dialog opens over it
      // (every menu item closes its own surface first).
      className="fixed z-[1050]"
      style={
        place === null
          ? { left: 0, top: 0, visibility: 'hidden' }
          : { left: place.left, top: place.top, width: place.width }
      }
    >
      {/* Animated on an inner wrapper so the entrance transform never skews
          the measurement above (M12.8). */}
      <div
        ref={panelRef}
        role={role}
        aria-label={ariaLabel}
        tabIndex={-1}
        className={`cb-menu-in ${className ?? ''}`}
        style={place?.width !== undefined ? { width: place.width } : undefined}
      >
        {children}
      </div>
    </div>
  );

  return (
    <>
      {anchorRef === undefined && <span ref={markerRef} className="hidden" aria-hidden="true" />}
      {createPortal(panel, document.body)}
    </>
  );
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
