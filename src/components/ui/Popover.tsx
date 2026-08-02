import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFocusRestore } from '@/hooks/useFocusRestore';
import { isTopLayer, useLayer } from '@/components/ui/layers';

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
  const id = useLayer();
  const latest = useRef(onClose);
  latest.current = onClose;
  const latestEscape = useRef(onEscape ?? onClose);
  latestEscape.current = onEscape ?? onClose;

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
      latest.current();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [surfaceRef, anchorEl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Only the innermost surface reacts, so one keystroke closes one thing.
      if (!isTopLayer(id)) return;
      // stopImmediatePropagation, not stopPropagation: sibling listeners on
      // window would otherwise all still run — stopPropagation only governs
      // travel between nodes, not other handlers on this one.
      e.stopImmediatePropagation();
      e.preventDefault();
      latestEscape.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [id]);

  return id;
}

export interface PopoverProps {
  onClose: () => void;
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
    return () => window.removeEventListener('resize', onResize);
  }, [measure]);

  const layerId = useDismiss({ onClose, surfaceRef: panelRef, anchorEl });

  useEffect(() => {
    if (!closeOnScroll) return;
    const onScroll = (e: Event) => {
      const target = e.target;
      if (target instanceof Node && panelRef.current?.contains(target) === true) return;
      latestClose.current();
    };
    // Capture: scroll does not bubble, so a scrolling pane deeper in the tree
    // is only observable from above.
    document.addEventListener('scroll', onScroll, true);
    return () => document.removeEventListener('scroll', onScroll, true);
  }, [closeOnScroll]);

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
      className="fixed z-50"
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
