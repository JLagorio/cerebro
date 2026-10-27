import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { isInsideLayerAbove } from '@/components/ui/layers';
import { useEscapeLayer } from '@/components/ui/Popover';
import { arrivingScale, useGhostOnUnmount } from './motion';
import { readPortalViewport, toPortalRect } from './portalGeometry';
import { SectionBoundary } from './SectionBoundary';

/**
 * A card that opens over a link while the pointer rests on it (M59.7).
 *
 * Macro's HoverCard behaviour, written in Cerebro code: an open delay, one
 * open card per group, ancestors held open while a card opened from inside
 * them is up, and Escape that walks back through the layers one at a time.
 *
 * - **No wrapper node** (Tooltip's rule). The trigger is the caller's own
 *   element, handed a ref through the render prop; the card is a portal.
 * - **Native listeners on the trigger.** Editor chips live in ProseMirror node
 *   views, where React pointer handlers are unreliable (DOM trap 9).
 * - **Only a real move opens it.** A pointermove counts only when its screen
 *   position differs from the last one the window saw, with no button down and
 *   not from touch — so a chip typed into place, or scrolled, under a still
 *   pointer never pops a card (Macro's requirePointerMovement).
 * - **Non-modal.** It owns its Escape through a `'tooltip'` layer, and is never
 *   the innermost surface a focus trap answers to.
 */

export const HOVER_OPEN_MS = 300;
export const HOVER_CLOSE_MS = 150;

const GAP = 6;
const EDGE = 8;

/** Keys that never close a card: Escape has its own layer, Tab moves focus,
 * and a bare modifier is not typing. */
const QUIET_KEYS = new Set(['Escape', 'Tab', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

// --- Module state -----------------------------------------------------------

interface CardEntry {
  parent: CardEntry | null;
  close: () => void;
}

/** The cards open right now, by group. */
const openByGroup = new Map<string, Set<CardEntry>>();

/** Where the window last saw the pointer, and where it was before that. The
 * capture listener runs before the trigger's own, so by the time a trigger
 * reads `previous` it is the position before the event it is handling. */
let previous: { x: number; y: number } | null = null;
let current: { x: number; y: number } | null = null;
let tracking = false;

function track(e: Event): void {
  const m = e as MouseEvent;
  previous = current;
  current = { x: m.screenX, y: m.screenY };
}

function ensureTracker(): void {
  if (tracking || typeof window === 'undefined') return;
  window.addEventListener('pointermove', track, true);
  tracking = true;
}

function movedFor(e: MouseEvent): boolean {
  return previous === null || previous.x !== e.screenX || previous.y !== e.screenY;
}

function isAncestor(candidate: CardEntry, of: CardEntry): boolean {
  for (let p = of.parent; p !== null; p = p.parent) if (p === candidate) return true;
  return false;
}

/** Test seam: the registry and the pointer tracker are module state. */
export function resetHoverCards(): void {
  openByGroup.clear();
  previous = null;
  current = null;
}

/** Test seam: how many cards a group has open. */
export function openHoverCardCount(group: string): number {
  return openByGroup.get(group)?.size ?? 0;
}

// --- Context: the card a nested card or portaled child sits in ---------------

interface HoverCardParent {
  entry: CardEntry;
  hold: () => void;
  release: () => void;
}

const HoverCardContext = createContext<HoverCardParent | null>(null);

/**
 * Keep the card this component sits inside open while `active` — for a menu
 * or picker a card's content portals out of it, which the pointer can reach
 * only by leaving the card.
 */
export function useHoldParentHoverCard(active: boolean): void {
  const parent = useContext(HoverCardContext);
  useEffect(() => {
    if (!active || parent === null) return;
    parent.hold();
    return parent.release;
  }, [active, parent]);
}

// --- The card ----------------------------------------------------------------

export interface HoverCardTriggerProps {
  /** Pass to the trigger element. */
  ref: (el: HTMLElement | null) => void;
  /** Pass as the trigger's aria-describedby: the card's id while it is open. */
  describedBy: string | undefined;
}

export interface HoverCardProps {
  children: (trigger: HoverCardTriggerProps) => React.ReactNode;
  /** The card's body, rendered only while open. `close` shuts it at once. */
  content: (api: { close: () => void }) => React.ReactNode;
  /** The card's accessible name. */
  label: string;
  /** One card per group is open at a time, ancestors aside. */
  group?: string;
  openDelay?: number;
  closeDelay?: number;
  /** Open on keyboard focus too (`:focus-visible` only). */
  openOnFocus?: boolean;
  disabled?: boolean;
}

export function HoverCard({
  children,
  content,
  label,
  group = 'hover-card',
  openDelay = HOVER_OPEN_MS,
  closeDelay = HOVER_CLOSE_MS,
  openOnFocus = true,
  disabled = false,
}: HoverCardProps) {
  const id = useId();
  const parent = useContext(HoverCardContext);
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const [card, setCard] = useState<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  cardRef.current = card;
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; side: 'top' | 'bottom' } | null>(
    null,
  );

  // Latest values, read by native listeners bound once per element.
  const latest = useRef({ parent, group, openDelay, closeDelay, openOnFocus, disabled });
  latest.current = { parent, group, openDelay, closeDelay, openOnFocus, disabled };

  const entry = useRef<CardEntry>({ parent: null, close: () => {} }).current;
  const isOpen = useRef(false);
  const holds = useRef(0);
  const heldParent = useRef<HoverCardParent | null>(null);
  const insideTrigger = useRef(false);
  const insideCard = useRef(false);
  /** Set by a close through Escape or a press; cleared when the pointer
   * leaves the trigger. */
  const quiet = useRef(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelOpen = useCallback(() => {
    if (openTimer.current !== null) clearTimeout(openTimer.current);
    openTimer.current = null;
  }, []);
  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  const close = useCallback(
    (quietAfter = false) => {
      cancelOpen();
      cancelClose();
      if (quietAfter) quiet.current = true;
      if (!isOpen.current) return;
      isOpen.current = false;
      insideCard.current = false;
      const set = openByGroup.get(latest.current.group);
      set?.delete(entry);
      if (set?.size === 0) openByGroup.delete(latest.current.group);
      const held = heldParent.current;
      heldParent.current = null;
      held?.release();
      setOpen(false);
    },
    [cancelClose, cancelOpen, entry],
  );
  entry.close = () => close();

  const show = useCallback(() => {
    openTimer.current = null;
    if (latest.current.disabled || isOpen.current) return;
    const { group: g, parent: p } = latest.current;
    entry.parent = p?.entry ?? null;
    const set = openByGroup.get(g) ?? new Set<CardEntry>();
    for (const other of [...set]) if (other !== entry && !isAncestor(other, entry)) other.close();
    set.add(entry);
    openByGroup.set(g, set);
    if (p !== null) {
      p.hold();
      heldParent.current = p;
    }
    isOpen.current = true;
    setPos(null);
    setOpen(true);
  }, [entry]);

  const armOpen = useCallback(() => {
    if (isOpen.current) {
      cancelClose();
      return;
    }
    if (openTimer.current !== null) return;
    openTimer.current = setTimeout(show, latest.current.openDelay);
  }, [cancelClose, show]);

  const scheduleClose = useCallback(() => {
    cancelOpen();
    if (!isOpen.current || holds.current > 0) return;
    cancelClose();
    closeTimer.current = setTimeout(() => close(), latest.current.closeDelay);
  }, [cancelClose, cancelOpen, close]);

  const hold = useCallback(() => {
    holds.current += 1;
    cancelClose();
  }, [cancelClose]);
  const release = useCallback(() => {
    holds.current = Math.max(0, holds.current - 1);
    if (holds.current === 0 && !insideTrigger.current && !insideCard.current) scheduleClose();
  }, [scheduleClose]);

  const asParent = useMemo<HoverCardParent>(
    () => ({ entry, hold, release }),
    [entry, hold, release],
  );

  // Trigger listeners, bound natively (DOM trap 9).
  useEffect(() => {
    if (trigger === null) return;
    ensureTracker();
    const onMove = (e: Event) => {
      const m = e as PointerEvent;
      const moved = movedFor(m);
      insideTrigger.current = true;
      if (quiet.current || latest.current.disabled) return;
      if (m.buttons !== 0 || m.pointerType === 'touch' || !moved) return;
      armOpen();
    };
    const onEnter = () => {
      insideTrigger.current = true;
      if (isOpen.current) cancelClose();
    };
    const onLeave = () => {
      insideTrigger.current = false;
      quiet.current = false;
      scheduleClose();
    };
    const onDown = () => close(true);
    const onFocusIn = () => {
      if (!latest.current.openOnFocus || quiet.current || latest.current.disabled) return;
      let visible = false;
      try {
        visible = trigger.matches(':focus-visible');
      } catch {
        // An engine without :focus-visible opens on pointer only.
      }
      if (visible) armOpen();
    };
    const onFocusOut = () => {
      if (!insideTrigger.current) scheduleClose();
    };
    trigger.addEventListener('pointermove', onMove);
    trigger.addEventListener('pointerenter', onEnter);
    trigger.addEventListener('pointerleave', onLeave);
    trigger.addEventListener('pointerdown', onDown);
    trigger.addEventListener('focusin', onFocusIn);
    trigger.addEventListener('focusout', onFocusOut);
    return () => {
      trigger.removeEventListener('pointermove', onMove);
      trigger.removeEventListener('pointerenter', onEnter);
      trigger.removeEventListener('pointerleave', onLeave);
      trigger.removeEventListener('pointerdown', onDown);
      trigger.removeEventListener('focusin', onFocusIn);
      trigger.removeEventListener('focusout', onFocusOut);
    };
  }, [armOpen, cancelClose, close, scheduleClose, trigger]);

  // The card's own pointer edges, native for the same reason.
  useEffect(() => {
    if (card === null) return;
    const onEnter = () => {
      insideCard.current = true;
      cancelClose();
    };
    const onLeave = () => {
      insideCard.current = false;
      scheduleClose();
    };
    card.addEventListener('pointerenter', onEnter);
    card.addEventListener('pointerleave', onLeave);
    return () => {
      card.removeEventListener('pointerenter', onEnter);
      card.removeEventListener('pointerleave', onLeave);
    };
  }, [cancelClose, card, scheduleClose]);

  useEffect(() => {
    if (disabled) close();
  }, [close, disabled]);

  // Unmount closes and unregisters it.
  useEffect(() => () => close(), [close]);

  // Below-start, flipped above when it would leave the viewport and fits
  // there, clamped from the edges.
  const measure = useCallback(() => {
    const el = cardRef.current;
    if (trigger === null || el === null) return;
    const viewport = readPortalViewport();
    const a = toPortalRect(trigger.getBoundingClientRect(), viewport.zoom);
    const drawn = toPortalRect(el.getBoundingClientRect(), viewport.zoom);
    // Placed by the size it lands at, though it may still be arriving.
    const grown = arrivingScale(el);
    const b = { width: drawn.width / grown, height: drawn.height / grown };
    const below = a.bottom + GAP;
    const above = a.top - GAP - b.height;
    const fitsBelow = below + b.height <= viewport.height - EDGE;
    const up = !fitsBelow && above >= EDGE;
    const top = up ? above : below;
    const left = Math.max(EDGE, Math.min(a.left, viewport.width - b.width - EDGE));
    const side = up ? 'top' : 'bottom';
    setPos((was) =>
      was !== null && was.left === left && was.top === Math.max(EDGE, top) && was.side === side
        ? was
        : { left, top: Math.max(EDGE, top), side },
    );
  }, [trigger]);

  useLayoutEffect(() => {
    if (!open || card === null) return;
    measure();
    window.addEventListener('resize', measure);
    const observer = new ResizeObserver(() => measure());
    observer.observe(card);
    return () => {
      window.removeEventListener('resize', measure);
      observer.disconnect();
    };
  }, [card, measure, open]);

  const shown = open && !disabled;

  return (
    <>
      {children({ ref: setTrigger, describedBy: shown ? id : undefined })}
      {shown && (
        <HoverCardLayer
          card={cardRef}
          onDismiss={(how) => close(how !== 'other' && insideTrigger.current)}
        />
      )}
      {shown && (
        <HoverCardSurface
          setCard={setCard}
          render={(ref) =>
            createPortal(
              <HoverCardContext.Provider value={asParent}>
                <div
                  ref={ref}
                  id={id}
                  role="group"
                  aria-label={label}
                  data-testid="hover-card"
                  data-side={pos?.side}
                  className={`fixed z-[1100] w-[320px] max-w-[calc(100vw-16px)] rounded-lg border border-n-200 bg-n-0 shadow-[var(--shadow-lg)] ${pos === null ? '' : 'cb-hover-card'}`}
                  style={
                    pos === null
                      ? { left: 0, top: 0, visibility: 'hidden' }
                      : { left: pos.left, top: pos.top }
                  }
                  // A portal still bubbles through the React tree, into the chip
                  // and the editor host's ⌘K handler: the card's events stop here.
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <SectionBoundary label="This card" compact>
                    {content({ close: () => close() })}
                  </SectionBoundary>
                </div>
              </HoverCardContext.Provider>,
              document.body,
            )
          }
        />
      )}
    </>
  );
}

/**
 * The card's own component, so it can leave a fading copy as it goes
 * (components/ui/motion.ts) while the real one unmounts with its layer.
 * Placed, it arrives out of its link (`cb-hover-card`, index.css).
 */
function HoverCardSurface({
  setCard,
  render,
}: {
  setCard: (card: HTMLDivElement | null) => void;
  render: (ref: (card: HTMLDivElement | null) => void) => React.ReactNode;
}) {
  const own = useRef<HTMLDivElement | null>(null);
  useGhostOnUnmount(own, 'cb-popover-leave', { strip: ['cb-hover-card'] });
  const ref = useCallback(
    (card: HTMLDivElement | null) => {
      own.current = card;
      setCard(card);
    },
    [setCard],
  );
  return render(ref);
}

/**
 * Escape, outside presses, scrolling and typing, held while the card is open
 * — a child component, so they live exactly as long as the card does
 * (TooltipEscapeLayer's shape).
 */
function HoverCardLayer({
  card,
  onDismiss,
}: {
  card: React.RefObject<HTMLDivElement | null>;
  onDismiss: (how: 'escape' | 'press' | 'other') => void;
}) {
  const latest = useRef(onDismiss);
  latest.current = onDismiss;
  const inCard = (node: Node) => card.current?.contains(node) === true;
  const layerId = useEscapeLayer(() => latest.current('escape'), {
    kind: 'tooltip',
    contains: inCard,
  });

  useEffect(() => {
    const ours = (target: EventTarget | null) =>
      target instanceof Node &&
      (card.current?.contains(target) === true || isInsideLayerAbove(layerId, target));
    const onDown = (e: PointerEvent) => {
      if (!ours(e.target)) latest.current('press');
    };
    // Armed one frame late, for Popover's M18.4 reason: the scroll a click
    // causes arrives after the surface it opened has mounted.
    let armed = false;
    const frame = requestAnimationFrame(() => {
      armed = true;
    });
    const onScroll = (e: Event) => {
      if (armed && !ours(e.target)) latest.current('other');
    };
    const onKey = (e: KeyboardEvent) => {
      if (QUIET_KEYS.has(e.key) || ours(e.target)) return;
      latest.current('other');
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [card, layerId]);

  return null;
}
