// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type AnimationEvent,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from 'react';
import { LEAVE_CAP_MS, Presence, motionAllowed, whenPlayed } from '@/components/ui/motion';
import './foundation.css';

/**
 * A disclosure: a button that shows and hides a region (M91.7). shadcn's
 * Collapsible, rebuilt on Cerebro's motion rather than Base UI's: the trigger
 * is a native button, so Enter and Space need no listener here, and nothing
 * here touches Escape — a collapsible is not a layer (CV-47).
 *
 * What it reveals drops in from under the trigger as it opens and fades where
 * it was as it closes, kept on screen by `Presence` until that exit has
 * played; reduced motion and jsdom close it in the commit that closed it.
 */

/** Open state: kept here from `defaultOpen`, or the caller's `open` when it
 *  passes one (§3.3: `open?`, `defaultOpen?`, `onOpenChange?`, so a wrapper
 *  can forward its own optional props). A controlled row hears the reader
 *  only through `onOpenChange`. */
export interface CollapsibleOpenProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export type CollapsibleProps = ComponentProps<'div'> &
  CollapsibleOpenProps & {
    /** The trigger ignores the reader. */
    disabled?: boolean;
  };

export type CollapsibleTriggerProps = ComponentProps<'button'>;

export type CollapsibleContentProps = Omit<ComponentProps<'div'>, 'id' | 'ref'> & {
  /** Keep the region in the document while closed, `hidden`, so what is
   *  inside keeps its own state (a nested row's open state, a scroll). */
  keepMounted?: boolean;
};

interface CollapsibleState {
  open: boolean;
  disabled: boolean;
  /** The region's id, which the trigger's `aria-controls` names. */
  contentId: string;
  toggle: () => void;
}

const CollapsibleContext = createContext<CollapsibleState | null>(null);

function useCollapsible(part: string): CollapsibleState {
  const state = useContext(CollapsibleContext);
  if (state === null) throw new Error(`${part} must sit inside a Collapsible`);
  return state;
}

export function Collapsible({
  open: controlled,
  defaultOpen = false,
  onOpenChange,
  disabled = false,
  children,
  ...props
}: CollapsibleProps) {
  const [own, setOwn] = useState(defaultOpen);
  const open = controlled ?? own;
  const contentId = useId();
  const state: CollapsibleState = {
    open,
    disabled,
    contentId,
    toggle: () => {
      if (controlled === undefined) setOwn(!open);
      onOpenChange?.(!open);
    },
  };
  return (
    <CollapsibleContext value={state}>
      <div
        data-slot="collapsible"
        {...props}
        data-open={open ? '' : undefined}
        data-closed={open ? undefined : ''}
      >
        {children}
      </div>
    </CollapsibleContext>
  );
}

/** The button that opens and closes the region. A click its own `onClick`
 *  prevents changes nothing. */
export function CollapsibleTrigger({ onClick, disabled, ...props }: CollapsibleTriggerProps) {
  const state = useCollapsible('CollapsibleTrigger');
  return (
    <button
      data-slot="collapsible-trigger"
      {...props}
      type="button"
      disabled={state.disabled || disabled}
      // Named while closed too, when the region may be out of the document:
      // `aria-expanded="false"` allows a reference that does not resolve.
      aria-controls={state.contentId}
      aria-expanded={state.open}
      data-panel-open={state.open ? '' : undefined}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) state.toggle();
      }}
    />
  );
}

/**
 * The mark an opening region carries while it drops in: taken as `open`
 * turns true — a region drawn open from the start was never opened — and
 * given up when its own entrance ends, or after the cap when nothing reports
 * an end, so a region shown again after `display: none` does not drop in a
 * second time. Its own attribute, so a surface's `[data-arrive]` rule (the
 * chat's) never restyles it.
 */
function useReveal(open: boolean) {
  const [seen, setSeen] = useState(open);
  const [revealing, setRevealing] = useState(false);
  if (open !== seen) {
    setSeen(open);
    setRevealing(open);
  }
  useEffect(() => {
    if (!revealing) return;
    const timer = setTimeout(() => setRevealing(false), LEAVE_CAP_MS);
    return () => clearTimeout(timer);
  }, [revealing]);
  return {
    revealing,
    settle: (event: AnimationEvent<HTMLDivElement>) => {
      // Its own entrance, not a child's ending and bubbling up through it.
      if (event.target === event.currentTarget) setRevealing(false);
    },
  };
}

/** The region. Closed, it leaves the document once its exit has played, or
 *  stays in it `hidden` with `keepMounted`. */
export function CollapsibleContent({
  keepMounted = false,
  className,
  onAnimationEnd,
  ...props
}: CollapsibleContentProps) {
  const { open, contentId } = useCollapsible('CollapsibleContent');
  const { revealing, settle } = useReveal(open);
  const draw = (closing: boolean, ref: RefObject<HTMLDivElement | null>, hidden = false) => (
    <div
      data-slot="collapsible-content"
      {...props}
      ref={ref}
      id={contentId}
      hidden={hidden}
      // A kept region stays closed once hidden, not only while it fades.
      data-state={closing || hidden ? 'closed' : 'open'}
      data-reveal={revealing && !closing ? '' : undefined}
      onAnimationEnd={(event) => {
        onAnimationEnd?.(event);
        settle(event);
      }}
      className={['cb-ai-collapsible-content', className].filter(Boolean).join(' ')}
    />
  );
  if (keepMounted) return <KeptRegion open={open} draw={draw} />;
  return <Presence<HTMLDivElement> open={open} render={({ closing, ref }) => draw(closing, ref)} />;
}

/**
 * `keepMounted`'s region: drawn always, so its subtree is never remounted,
 * and `hidden` once closed and its exit has played. `Presence` cannot keep it
 * — it lets go of what it holds — so it waits on the same exit through
 * motion.ts's `whenPlayed`.
 */
function KeptRegion({
  open,
  draw,
}: {
  open: boolean;
  draw: (closing: boolean, ref: RefObject<HTMLDivElement | null>, hidden: boolean) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(open);
  if (open && !shown) setShown(true);
  const closing = shown && !open;
  useLayoutEffect(() => {
    if (!closing) return;
    const el = ref.current;
    if (el === null || !motionAllowed()) {
      setShown(false);
      return;
    }
    return whenPlayed(el, () => setShown(false));
  }, [closing]);
  return draw(closing, ref, !shown);
}
