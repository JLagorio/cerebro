import { commandDef } from '@/app/commands';
import { Keycaps } from './Keycaps';
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeLayer } from '@/components/ui/Popover';
import { useGhostOnUnmount } from './motion';
import { tooltipsWarm, warmTooltips } from './tooltipWarmth';
import { readPortalViewport, toPortalRect } from './portalGeometry';

/**
 * A tooltip that shows up (M16.5).
 *
 * There was no primitive: 124 sites used the native `title` attribute, which
 * has three problems this fixes.
 *
 * - **It does not render on a disabled control.** `IconButton` puts `title` on
 *   the `<button>` and disables that same button, so every explanation of why
 *   a control is unavailable — exactly when a user needs one — was invisible.
 *   Handlers are cloned onto the control, and pointerenter still fires on a
 *   disabled button even though click does not.
 * - **It cannot be styled or read.** No token colours, no delay control, and
 *   on touch it never appears at all.
 * - **It is invisible to keyboard users.** `title` only responds to hover;
 *   this responds to focus too.
 *
 * `aria-describedby` rather than `aria-label`: the accessible NAME still comes
 * from the control's own label, and the tooltip is supplementary. Doubling it
 * into the name makes a screen reader say everything twice.
 */

const DELAY_MS = 400;
const GAP = 6;
const EDGE = 8;

/**
 * A visible tooltip is a layer too — the one non-modal kind (M16.35).
 *
 * Escape used to be a bubble-phase `window` listener that stopped nothing and
 * registered nothing, so one keystroke over a header button dismissed the
 * tooltip AND the record panel behind it. The panel was not at fault: it asks
 * the stack who owns the key, the stack had never heard of the tooltip, and so
 * it was told the keystroke was unclaimed.
 *
 * `kind: 'tooltip'` because a bubble must not pass for the innermost SURFACE.
 * Tab inside a focus-trapped popover moves focus, focus shows a tooltip, and a
 * tooltip counted as a surface would take that popover's own `Tab` handling
 * away from it on the next keypress.
 *
 * The cost is that Escape over a visible tooltip dismisses only the tooltip,
 * and the surface underneath needs a second one. That is the point: the old
 * behaviour was one keystroke closing two things, and this is the same rule
 * every other layer already follows.
 *
 * A child component, so the layer lives exactly as long as the bubble does —
 * the shape `DropdownEscapeLayer` established in M16.34.
 */
function TooltipEscapeLayer({ onClose }: { onClose: () => void }) {
  useEscapeLayer(onClose, { kind: 'tooltip' });
  return null;
}

export interface TooltipProps {
  /** The text. Nothing renders when this is empty. */
  label: string;
  /** The catalog row whose keys follow the label. */
  command?: string;
  /**
   * A single element. Handlers are cloned onto it rather than onto a wrapper,
   * so the tooltip adds NO node to the tree — a wrapper, even
   * `display: contents`, is still a DOM node, and the row-action tests that
   * walk `closest('span').parentElement` found it instead of the real one.
   * 124 call sites and their `group-hover` CSS depend on this shape.
   */
  children: React.ReactElement;
  /** Preferred side; flips when it would leave the viewport. */
  side?: 'top' | 'bottom';
  /** Hold off before showing. 0 for controls whose meaning is urgent. */
  delayMs?: number;
  /**
   * Suppress it entirely, e.g. while a menu is already open over the trigger.
   * The trigger keeps its node either way (M52): answering `disabled` with the
   * bare child changed the tree's shape, React remounted the trigger, and a
   * drawer that handed focus back to it on close handed it to a detached one.
   */
  disabled?: boolean;
}

export function Tooltip({
  label,
  command,
  children,
  side = 'top',
  delayMs = DELAY_MS,
  disabled = false,
}: TooltipProps) {
  if (command !== undefined) commandDef(command);
  const id = useId();
  const anchorRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  openRef.current = open;
  const [pos, setPos] = useState<{ left: number; top: number; side: 'top' | 'bottom' } | null>(
    null,
  );

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  // The anchor comes from the event, not from a cloned ref: composing a ref
  // onto the child means writing through a prop, and it would clobber any ref
  // the caller already passed. `currentTarget` is the element the handler is
  // bound to, which is exactly the anchor.
  const show = useCallback(
    (e: { currentTarget: unknown; type?: string }) => {
      if (disabled || label === '') return;
      if (e.currentTarget instanceof HTMLElement) anchorRef.current = e.currentTarget;
      cancel();
      // Warm only for the pointer (tooltipWarmth.ts): focus waits its delay.
      const warm = e.type === 'pointerenter' && tooltipsWarm();
      timer.current = setTimeout(() => setOpen(true), warm ? 0 : delayMs);
    },
    [cancel, delayMs, disabled, label],
  );

  const hide = useCallback(
    (_e?: { currentTarget: unknown }) => {
      cancel();
      if (openRef.current) warmTooltips();
      setOpen(false);
      // Placed afresh next time, measured before it is drawn arriving (its
      // entrance scales it), so it lands centred on its anchor.
      setPos(null);
    },
    [cancel],
  );

  useEffect(() => cancel, [cancel]);

  // Disabled while it is up, or while its delay is running, it goes and
  // stays gone (M52). `shown` drops it in the same render; this clears what
  // would bring it back the moment it is enabled again, over whatever the
  // pointer has moved on to.
  useEffect(() => {
    if (disabled) hide();
  }, [disabled, hide]);
  const shown = open && !disabled;

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const bubble = bubbleRef.current;
    if (anchor === null || bubble === null) return;
    const viewport = readPortalViewport();
    const a = toPortalRect(anchor.getBoundingClientRect(), viewport.zoom);
    const b = toPortalRect(bubble.getBoundingClientRect(), viewport.zoom);
    const above = a.top - GAP - b.height;
    const below = a.bottom + GAP;
    const wantAbove = side === 'top';
    const fitsAbove = above >= EDGE;
    const fitsBelow = below + b.height <= viewport.height - EDGE;
    const top = wantAbove ? (fitsAbove ? above : below) : fitsBelow ? below : above;
    setPos({
      left: Math.max(
        EDGE,
        Math.min(a.left + a.width / 2 - b.width / 2, viewport.width - b.width - EDGE),
      ),
      top: Math.max(EDGE, top),
      side: top === above ? 'top' : 'bottom',
    });
  }, [open, side]);

  if (label === '') return children;

  const child = children as React.ReactElement<Record<string, unknown>>;
  const childProps = child.props;
  type Handler = (e: { currentTarget: unknown; type?: string }) => void;
  const chain =
    (own: Handler, theirs: unknown): Handler =>
    (e) => {
      own(e);
      if (typeof theirs === 'function') (theirs as Handler)(e);
    };

  return (
    <>
      {/* Escape dismisses without moving the pointer — otherwise a tooltip can
          sit over the thing you are trying to read — and it dismisses ONLY
          this. */}
      {shown && <TooltipEscapeLayer onClose={hide} />}
      {React.cloneElement(child, {
        onPointerEnter: chain(show, childProps.onPointerEnter),
        onPointerLeave: chain(hide, childProps.onPointerLeave),
        onPointerDown: chain(hide, childProps.onPointerDown),
        onFocus: chain(show, childProps.onFocus),
        onBlur: chain(hide, childProps.onBlur),
        'aria-describedby': shown ? id : childProps['aria-describedby'],
      })}
      {shown && (
        <TooltipBubble id={id} label={label} command={command} pos={pos} bubbleRef={bubbleRef} />
      )}
    </>
  );
}

/**
 * The bubble, its own component so it can leave a fading copy as it goes
 * (components/ui/motion.ts) — the real one unmounts with its layer. Placed,
 * it arrives from the anchor's side (`cb-tooltip`, index.css).
 */
function TooltipBubble({
  id,
  label,
  command,
  pos,
  bubbleRef,
}: {
  id: string;
  label: string;
  command?: string;
  pos: { left: number; top: number; side: 'top' | 'bottom' } | null;
  bubbleRef: React.RefObject<HTMLDivElement | null>;
}) {
  useGhostOnUnmount(bubbleRef, 'cb-tooltip-leave', { strip: ['cb-tooltip'] });
  return createPortal(
    <div
      ref={bubbleRef}
      id={id}
      role="tooltip"
      data-side={pos?.side}
      className={`pointer-events-none fixed z-[1100] max-w-[260px] rounded-sm bg-n-900 px-2 py-1 text-xs leading-[1.4] text-n-0 shadow-[var(--shadow-lg)] ${pos === null ? '' : 'cb-tooltip'}`}
      style={
        pos === null ? { left: 0, top: 0, visibility: 'hidden' } : { left: pos.left, top: pos.top }
      }
    >
      <span className="inline-flex items-center gap-2">
        {label}
        {command !== undefined && <Keycaps command={command} className="text-n-200" />}
      </span>
    </div>,
    document.body,
  );
}
