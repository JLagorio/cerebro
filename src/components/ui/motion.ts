import {
  cloneElement,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type AnimationEvent,
  type ReactNode,
  type RefObject,
} from 'react';

/**
 * How things arrive and leave (owner, 2026-10-19: "add more animations …
 * feel like Notion and ChatGPT"). Arriving is CSS's job — a keyframe on the
 * surface, timed by the arrival pairs (styles/tokens/spacing.css) — and the
 * marks here say when an arrival should play at all. Leaving needs the
 * surface on screen after its host has let go of it, and there are two ways
 * to keep it, one for each kind of host:
 *
 * - `Presence`: the host holds the surface mounted, marked
 *   `data-state="closed"`, until the exit that state names has played. For
 *   panels that take room in a layout — the page's side panel keeps its
 *   column while it slides away, and the page widens after it.
 * - `leaveGhost`: the surface goes at once and a copy of it plays the exit.
 *   For menus, tooltips, dialogs and rows: holding the real one would hold
 *   its layer, its Escape and its focus return too, all of which belong to
 *   the moment it closed.
 *
 * Neither plays where motion does not: jsdom has no Web Animations, and a
 * reader who asked for less motion gets the surface gone in the commit that
 * closed it — which is also what keeps the tests' timing exact.
 */
export function motionAllowed(): boolean {
  if (typeof window === 'undefined' || typeof Element === 'undefined') return false;
  if (typeof Element.prototype.getAnimations !== 'function') return false;
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches !== true;
}

/**
 * How much smaller than its size an arriving surface is drawn right now
 * (`cb-pop-in` scales it up from its anchor's side), so a surface that places
 * itself by its measured size works from the size it lands at. 1 where
 * nothing scales it.
 */
export function arrivingScale(el: Element): number {
  const scale = Number.parseFloat(getComputedStyle(el).scale);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** The longest anything here waits on an exit, so an exit that never ends —
 *  cancelled, or paused in a hidden pane — strands nothing. */
export const LEAVE_CAP_MS = 1000;

/** What is still to play on `el` (and under it), short of anything that
 *  loops. */
function playing(el: Element, subtree = false): Animation[] {
  return el.getAnimations({ subtree }).filter((a) => {
    if (a.playState === 'finished') return false;
    const iterations = a.effect?.getComputedTiming().iterations;
    return iterations !== Infinity;
  });
}

/** Runs `done` once every animation in `animations` has ended, or after the
 *  cap, whichever comes first. Returns what calls it off. */
function whenEnded(animations: Animation[], done: () => void): () => void {
  let live = true;
  const finish = () => {
    if (!live) return;
    live = false;
    clearTimeout(timer);
    done();
  };
  const timer = setTimeout(finish, LEAVE_CAP_MS);
  void Promise.allSettled(animations.map((a) => a.finished)).then(finish);
  return () => {
    live = false;
    clearTimeout(timer);
  };
}

// --- Staying to leave --------------------------------------------------------

/**
 * A surface its host keeps mounted while it animates out: `present` stays
 * true while it closes, until the animation its closed state names has
 * played. Opened again before then, it simply stays. With nothing to play it
 * goes in the commit that closed it.
 */
function usePresence<T extends Element>(
  open: boolean,
): { ref: RefObject<T | null>; present: boolean; closing: boolean } {
  const ref = useRef<T | null>(null);
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);
  const closing = present && !open;
  useLayoutEffect(() => {
    if (!closing) return;
    const el = ref.current;
    const exit = el !== null && motionAllowed() ? playing(el) : [];
    if (exit.length === 0) {
      setPresent(false);
      return;
    }
    return whenEnded(exit, () => setPresent(false));
  }, [closing]);
  return { ref, present, closing };
}

/**
 * A surface its host renders inline, kept while it leaves: `render` draws
 * it, handed whether it is closing and the ref to put on it — mark it
 * `data-state={closing ? 'closed' : 'open'}` and let CSS name the exit.
 * While it closes, the last `render` it was drawn with while open draws it,
 * so it leaves as it was — a drawer stays a drawer on its way out, whatever
 * the page has decided since.
 */
export function Presence<T extends Element>({
  open,
  render,
}: {
  open: boolean;
  render: (state: { closing: boolean; ref: RefObject<T | null> }) => ReactNode;
}): ReactNode {
  const { ref, present, closing } = usePresence<T>(open);
  const last = useRef(render);
  // Kept from the last open render: what it closes as (a ref, not state —
  // remembering it must not render again).
  if (open) last.current = render;
  if (!present) return null;
  return (open ? render : last.current)({ closing, ref });
}

// --- Arriving ----------------------------------------------------------------

/** What an arriving element carries; nothing once it has arrived. */
export interface ArrivalProps {
  'data-arrive'?: '';
  onAnimationEnd?: (event: AnimationEvent<HTMLElement>) => void;
}

const SETTLED: ArrivalProps = {};

/**
 * The mark for an element that arrives, if `when` held as it mounted — a
 * message a send appends, a comment posted while the panel is open, a panel
 * opening. CSS draws the entrance, keyed on `data-arrive`; what was there
 * first is simply there.
 *
 * The mark comes off when its own entrance ends, which keeps an entrance to
 * one play: `display: none` lifting (a folded conversation opened again, a
 * pane shown again) restarts every animation under it, and an element still
 * marked would arrive all over again each time. An entrance cut short —
 * hidden mid-way, which React reports no event for — is let go after the
 * cap all the same.
 */
export function useArrival(when: boolean): ArrivalProps {
  const [arriving, setArriving] = useState(when);
  useEffect(() => {
    if (!arriving) return;
    const timer = setTimeout(() => setArriving(false), LEAVE_CAP_MS);
    return () => clearTimeout(timer);
  }, [arriving]);
  if (!arriving) return SETTLED;
  return {
    'data-arrive': '',
    onAnimationEnd: (event) => {
      // Its own entrance, not a child's ending and bubbling up through it.
      if (event.target === event.currentTarget) setArriving(false);
    },
  };
}

/** `useArrival` for an element its parent draws: the mark goes on the one
 *  element it wraps, which keeps its own type, place and handlers. */
export function Arrival({ when, children }: { when: boolean; children: ReactNode }) {
  const arrival = useArrival(when);
  if (arrival === SETTLED || !isValidElement<ArrivalProps>(children)) return children;
  const own = children.props;
  return cloneElement(children, {
    'data-arrive': '',
    onAnimationEnd: (event: AnimationEvent<HTMLElement>) => {
      own.onAnimationEnd?.(event);
      arrival.onAnimationEnd?.(event);
    },
  });
}

/**
 * Whether this component was on screen before this render: what it adds from
 * then on arrives, what it was first drawn with does not. Read off a ref its
 * first commit sets, so knowing costs no render of its own, and set in that
 * commit's layout pass, so no later render can still read it unset.
 */
export function useDrawn(): boolean {
  const drawn = useRef(false);
  useLayoutEffect(() => {
    drawn.current = true;
  }, []);
  return drawn.current;
}

/** What a view that swaps its content in place carries while its new
 *  content arrives; nothing once it has. */
export interface PageTurnProps {
  'data-page-turn'?: 'a' | 'b';
  onAnimationEnd?: (event: AnimationEvent<HTMLElement>) => void;
}

/**
 * The fade a view plays as each new `key` arrives in it — DocPage's column
 * on each page, the Inbox's reader on each capture — without remounting the
 * editor inside. Its two turns name one fade twice over
 * (components/pageFrame.css), so a key that comes while the last fade still
 * plays starts it again; the mark comes off once a fade has played, so
 * showing the view again (a pane back from the assistant's canvas) replays
 * nothing.
 */
export function usePageTurn(key: string): PageTurnProps {
  const [turn, setTurn] = useState({ key, b: false, played: false });
  if (turn.key !== key) setTurn({ key, b: !turn.b, played: false });
  useEffect(() => {
    if (turn.played) return;
    const timer = setTimeout(() => setTurn((t) => ({ ...t, played: true })), LEAVE_CAP_MS);
    return () => clearTimeout(timer);
  }, [turn.played, turn.key]);
  if (turn.played) return {};
  return {
    'data-page-turn': turn.b ? 'b' : 'a',
    onAnimationEnd: (event) => {
      if (event.target === event.currentTarget) setTurn((t) => ({ ...t, played: true }));
    },
  };
}

// --- Leaving as a copy -------------------------------------------------------

/** Attributes a copy must not carry: it names nothing, is nobody's target,
 *  takes no focus, and is no drawer for DrawerScrim to find. */
const UNNAMED = [
  'id',
  'role',
  'data-testid',
  'tabindex',
  'name',
  'for',
  'autofocus',
  'title',
  'data-overlay',
];

export interface CopyOptions {
  /** Classes the copy drops, where one would outrank the class it leaves
   *  under (an entrance named on the same element, say). */
  strip?: string[];
  /** Every `data-` attribute goes too — a row its list finds by one. */
  dropData?: boolean;
}

/**
 * An inert copy of `el` as it is drawn now: nameless, out of the
 * accessibility tree, taking no pointer or focus, and keeping what
 * `cloneNode` loses (typed values). Put it in the document, then call
 * `settle`: it scrolls the copy's boxes to where the original's were (a
 * detached element cannot scroll), and finishes anything inside it that was
 * still arriving — a copy cloned mid-entrance would otherwise play it again
 * on its way out. Then add the class it leaves under.
 */
export function inertCopy(
  el: HTMLElement,
  options: CopyOptions = {},
): { copy: HTMLElement; settle: () => void } {
  const copy = el.cloneNode(true) as HTMLElement;
  const from = [el, ...el.querySelectorAll('*')];
  const to = [copy, ...copy.querySelectorAll<HTMLElement>('*')];
  const scrolled: [Element, number, number][] = [];
  for (let i = 0; i < from.length && i < to.length; i++) {
    const source = from[i];
    const twin = to[i];
    if (source.scrollTop !== 0 || source.scrollLeft !== 0) {
      scrolled.push([twin, source.scrollTop, source.scrollLeft]);
    }
    // A file input's value cannot be set (it throws), and a copy of one
    // shows nothing worth carrying anyway.
    if (
      (source instanceof HTMLInputElement || source instanceof HTMLTextAreaElement) &&
      (twin instanceof HTMLInputElement || twin instanceof HTMLTextAreaElement) &&
      !(source instanceof HTMLInputElement && source.type === 'file')
    ) {
      twin.value = source.value;
    }
  }
  for (const node of to) {
    for (const { name } of [...node.attributes]) {
      if (
        UNNAMED.includes(name) ||
        name.startsWith('aria-') ||
        (options.dropData === true && name.startsWith('data-'))
      ) {
        node.removeAttribute(name);
      }
    }
    for (const name of options.strip ?? []) node.classList.remove(name);
  }
  copy.setAttribute('aria-hidden', 'true');
  copy.setAttribute('inert', '');
  copy.setAttribute('data-ghost', '');
  copy.style.pointerEvents = 'none';
  const settle = () => {
    for (const [box, top, left] of scrolled) {
      box.scrollTop = top;
      box.scrollLeft = left;
    }
    for (const animation of playing(copy, true)) {
      try {
        animation.finish();
      } catch {
        // A paused timeline (DevTools holding every animation) cannot be
        // finished; the copy plays on with it, and the cap still clears it.
      }
    }
  };
  return { copy, settle };
}

/** Runs `done` once what `el` plays — and, with `subtree`, what plays
 *  under it — has ended (after the cap at most), or at once when nothing
 *  does. Returns what calls it off. */
export function whenPlayed(el: Element, done: () => void, subtree = false): () => void {
  const running = playing(el, subtree);
  if (running.length === 0) {
    done();
    return () => undefined;
  }
  return whenEnded(running, done);
}

/** Removes a placed copy once what it plays has ended (after the cap at
 *  most), or at once when it plays nothing. */
export function removeAfterExit(copy: HTMLElement): void {
  whenPlayed(copy, () => copy.remove(), true);
}

/**
 * Leaves a copy of `el` where it was, playing `exitClass`'s animation, and
 * removes it when that ends. Call it as the surface goes — a layout effect's
 * cleanup, while `el` is still drawn. `animated` names the element in the
 * copy the class goes on (the surface's own animated box), when that is not
 * the copy itself; `float` lifts the copy out of a stack (a toast among
 * toasts), so the rest close up at once.
 *
 * The copy is taken now and placed only once `left` says the surface has
 * really gone — by default, once it is out of the document: React's
 * development mode unmounts and remounts every component once on mount, and
 * a surface still in the document after this commit never left. A surface
 * that leaves by changing shape in place (the sidebar's drawer folding back
 * into the nav) says so itself, and its copy goes in after it.
 */
export function leaveGhost(
  el: HTMLElement | null,
  exitClass: string,
  options: CopyOptions & {
    animated?: string;
    float?: 'top' | 'bottom';
    left?: (el: HTMLElement) => boolean;
  } = {},
): void {
  if (el === null || !el.isConnected || !motionAllowed()) return;
  const parent = el.parentNode;
  if (parent === null) return;
  const next = el.nextSibling;
  const left = options.left ?? ((gone: HTMLElement) => !gone.isConnected);
  const { copy, settle } = inertCopy(el, options);
  if (options.float !== undefined) {
    // Held at the edge of the stack that stays put as the rest close up: a
    // stack pinned to the window's bottom (the toasts) moves its top edge
    // down as one leaves, so its copies measure from the bottom.
    copy.style.position = 'absolute';
    copy.style.left = `${el.offsetLeft}px`;
    copy.style.width = `${el.offsetWidth}px`;
    copy.style.margin = '0';
    if (options.float === 'top') copy.style.top = `${el.offsetTop}px`;
    else {
      const stack = el.offsetParent instanceof HTMLElement ? el.offsetParent.offsetHeight : 0;
      copy.style.bottom = `${stack - el.offsetTop - el.offsetHeight}px`;
    }
  }
  // After the commit, before the frame it would be painted in.
  queueMicrotask(() => {
    if (!left(el) || !parent.isConnected) return;
    // A surface still in the document (it left by changing shape) draws over
    // its copy, so one reopened at once is not covered by its last leaving.
    const before = el.parentNode === parent ? el : next?.parentNode === parent ? next : null;
    parent.insertBefore(copy, before);
    try {
      settle();
      const target =
        options.animated === undefined
          ? copy
          : (copy.querySelector<HTMLElement>(options.animated) ?? copy);
      target.classList.add(exitClass);
    } finally {
      // Placed, it always goes: whatever happened above, nothing strands it.
      removeAfterExit(copy);
    }
  });
}

/**
 * `leaveGhost` for a surface that unmounts with its component: the copy is
 * left as the component lets go, from the element `ref` held while it was
 * mounted.
 */
export function useGhostOnUnmount(
  ref: RefObject<HTMLElement | null>,
  exitClass: string,
  options?: { animated?: string; strip?: string[]; float?: 'top' | 'bottom'; when?: boolean },
): void {
  const when = options?.when ?? true;
  const animated = options?.animated;
  const float = options?.float;
  const strip = options?.strip?.join(' ');
  useLayoutEffect(() => {
    if (!when) return;
    const el = ref.current;
    return () =>
      leaveGhost(el, exitClass, {
        animated,
        float,
        strip: strip === undefined ? undefined : strip.split(' '),
      });
  }, [ref, exitClass, animated, float, strip, when]);
}
