import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeLayer } from '@/components/ui/Popover';

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
  /** Suppress it entirely, e.g. while a menu is already open over the trigger. */
  disabled?: boolean;
}

export function Tooltip({
  label,
  children,
  side = 'top',
  delayMs = DELAY_MS,
  disabled = false,
}: TooltipProps) {
  const id = useId();
  const anchorRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  // The anchor comes from the event, not from a cloned ref: composing a ref
  // onto the child means writing through a prop, and it would clobber any ref
  // the caller already passed. `currentTarget` is the element the handler is
  // bound to, which is exactly the anchor.
  const show = useCallback(
    (e: { currentTarget: unknown }) => {
      if (disabled || label === '') return;
      if (e.currentTarget instanceof HTMLElement) anchorRef.current = e.currentTarget;
      cancel();
      timer.current = setTimeout(() => setOpen(true), delayMs);
    },
    [cancel, delayMs, disabled, label],
  );

  const hide = useCallback(
    (_e?: { currentTarget: unknown }) => {
      cancel();
      setOpen(false);
    },
    [cancel],
  );

  useEffect(() => cancel, [cancel]);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const bubble = bubbleRef.current;
    if (anchor === null || bubble === null) return;
    const a = anchor.getBoundingClientRect();
    const b = bubble.getBoundingClientRect();
    const above = a.top - GAP - b.height;
    const below = a.bottom + GAP;
    const wantAbove = side === 'top';
    const fitsAbove = above >= EDGE;
    const fitsBelow = below + b.height <= window.innerHeight - EDGE;
    const top = wantAbove ? (fitsAbove ? above : below) : fitsBelow ? below : above;
    setPos({
      left: Math.max(
        EDGE,
        Math.min(a.left + a.width / 2 - b.width / 2, window.innerWidth - b.width - EDGE),
      ),
      top: Math.max(EDGE, top),
    });
  }, [open, side]);

  if (label === '' || disabled) return children;

  const child = children as React.ReactElement<Record<string, unknown>>;
  const childProps = child.props;
  type Handler = (e: { currentTarget: unknown }) => void;
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
      {open && <TooltipEscapeLayer onClose={hide} />}
      {React.cloneElement(child, {
        onPointerEnter: chain(show, childProps.onPointerEnter),
        onPointerLeave: chain(hide, childProps.onPointerLeave),
        onPointerDown: chain(hide, childProps.onPointerDown),
        onFocus: chain(show, childProps.onFocus),
        onBlur: chain(hide, childProps.onBlur),
        'aria-describedby': open ? id : childProps['aria-describedby'],
      })}
      {open &&
        createPortal(
          <div
            ref={bubbleRef}
            id={id}
            role="tooltip"
            className="pointer-events-none fixed z-[1100] max-w-[260px] rounded-[6px] bg-[var(--n-900)] px-2 py-1 text-[12px] leading-[1.4] text-[var(--n-0)] shadow-[var(--shadow-lg)]"
            style={
              pos === null
                ? { left: 0, top: 0, visibility: 'hidden' }
                : { left: pos.left, top: pos.top }
            }
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  );
}
