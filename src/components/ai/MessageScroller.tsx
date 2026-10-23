// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { Icon } from '@/components/ui/Icon';
import { motionAllowed } from '@/components/ui/motion';
import { useMergedRefs } from './mergeRefs';
import './conversation.css';

/**
 * A chat transcript's scroll (M91.8): shadcn's Message Scroller, with the
 * behaviour of its headless @shadcn/react parts ported onto plain React (no
 * Base UI, no `useRender`). It moves only when the reader asked it to:
 *
 * - A row marked `scrollAnchor` (the person's turn) settles near the top as
 *   it arrives, with a peek of the row before it, and the reply grows into
 *   the room below it.
 * - While the reader is at the live edge, `autoScroll` follows the reply as
 *   it streams. A wheel, a touch, a scroll key or the scrollbar releases it,
 *   and new content then arrives without moving anything.
 * - `MessageScrollerButton` jumps to the latest row and follows again.
 * - `useMessageScroller().scrollToMessage(id)` jumps to a row by its
 *   `messageId`, queuing the jump while the transcript mounts, and
 *   `scrollToElement(el)` to anything inside a row: a step, a card's button.
 *
 * Where the reader is lives in one object per provider, mirrored to `data-*`
 * attributes, so a scroll or a streamed chunk re-renders no row. Not ported:
 * visibility tracking (`useMessageScrollerVisibility`), which nothing reads,
 * and `content-visibility` on rows, whose paint containment would clip a
 * focus ring at a row's edge.
 */

/** How near an edge still counts as at it: absorbs engines that round
 *  `scrollTop` differently. */
const EDGE = 8;
/** How much of the previous row stays in view above a new anchor. */
const PEEK = 64;
/** Two scroll positions this close are one. */
const EPSILON = 0.5;
/** How long `data-autoscrolling` marks a programmatic scroll to the end. */
const AUTOSCROLLING_MS = 180;

/** The keys that scroll the transcript, which a reader presses to read. */
const SCROLL_KEYS = new Set(['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp', ' ']);

/** Controls that keep every scroll key: text entry moves its caret, a radio
 *  group its pick, a menu or a list its highlight. */
const KEY_KEEPERS = [
  'input',
  'textarea',
  'select',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[role="radio"]',
  '[role="radiogroup"]',
  '[role="slider"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="listbox"]',
  '[role="option"]',
].join(', ');

/** Controls that keep Space: it presses them. Their arrows still scroll. */
const PRESSABLE = 'button, summary, [role="button"], [role="switch"], [role="tab"]';

/** How the transcript reacts to content and size right now. */
type Mode =
  /** Following the latest row (`autoScroll`, at the end). */
  | 'following-bottom'
  /** The reader scrolled away: positions are left alone. */
  | 'free-scrolling'
  /** Holding a new turn at its line while the reply streams below it. */
  | 'anchored-to-message'
  /** A jump to a row is under way; nothing re-pins against it. */
  | 'settling-jump';

/** Where a transcript opens on its first rows: the top, the bottom, or the
 *  last anchored turn with its reply below it. */
export type MessageScrollerDefaultScrollPosition = 'start' | 'end' | 'last-anchor';
export type MessageScrollerButtonDirection = 'start' | 'end';
export type MessageScrollerScrollAlign = 'start' | 'center' | 'end' | 'nearest';

export interface MessageScrollerScrollOptions {
  /** The edge, or the centre, of the viewport to align the row to. */
  align?: MessageScrollerScrollAlign;
  behavior?: ScrollBehavior;
  /** Room on the aligned edge, in pixels; the provider's `scrollMargin`. */
  scrollMargin?: number;
}

/** Which way the viewport can still scroll. */
export interface MessageScrollerScrollable {
  start: boolean;
  end: boolean;
}

/** The scroll commands a control inside the provider, or a host handed them
 *  (Chat's `scrollerRef`), moves the transcript with. Each says whether it
 *  moved, or queued, the jump. */
export interface MessageScrollerCommands {
  scrollToEnd: (options?: MessageScrollerScrollOptions) => boolean;
  scrollToMessage: (messageId: string, options?: MessageScrollerScrollOptions) => boolean;
  scrollToStart: (options?: MessageScrollerScrollOptions) => boolean;
  scrollToElement: (element: HTMLElement, options?: MessageScrollerScrollOptions) => boolean;
}

export interface MessageScrollerProviderProps {
  children?: ReactNode;
  /** Follow new content while the reader is at the end. */
  autoScroll?: boolean;
  /** Where the first rows open, applied once. */
  defaultScrollPosition?: MessageScrollerDefaultScrollPosition;
  /** How near an edge counts as at it. */
  scrollEdgeThreshold?: number;
  /** How much of the previous row stays above a new anchor. */
  scrollPreviousItemPeek?: number;
  /** Room on the aligned edge for jumps. */
  scrollMargin?: number;
}

export type MessageScrollerViewportProps = ComponentProps<'div'> & {
  /** Hold the reader's row still when rows are added above it. */
  preserveScrollOnPrepend?: boolean;
};

export type MessageScrollerContentProps = ComponentProps<'div'> & {
  /** A class for the spacer that makes room under a new anchor. */
  spacerClassName?: string;
};

export type MessageScrollerItemProps = ComponentProps<'div'> & {
  /** The row's stable id, for `scrollToMessage` and to keep its place. */
  messageId?: string;
  /** The row starts a turn: it settles near the top as it arrives. */
  scrollAnchor?: boolean;
};

export type MessageScrollerButtonProps = Omit<ComponentProps<'button'>, 'type'> & {
  direction?: MessageScrollerButtonDirection;
  /** Smooth unless the reader asked for less motion. */
  behavior?: ScrollBehavior;
};

const NOWHERE: MessageScrollerScrollable = { start: false, end: false };

// --- A value its readers subscribe to -----------------------------------------

interface Store<T> {
  get: () => T;
  set: (next: T) => void;
  subscribe: (listener: () => void) => () => void;
}

function createStore<T>(initial: T, same: (a: T, b: T) => boolean): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (same(value, next)) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// --- Geometry ------------------------------------------------------------------

/** The rows: the content's children, less the spacer. */
function itemsOf(content: HTMLElement, spacer: HTMLElement | null): HTMLElement[] {
  return [...content.children].filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child !== spacer,
  );
}

const isAnchor = (item: HTMLElement) => item.dataset.scrollAnchor === 'true';

function px(value: string | undefined): number {
  const number = Number.parseFloat(value ?? '');
  return Number.isFinite(number) ? number : 0;
}

function blockPadding(element: HTMLElement): { start: number; end: number } {
  const style = getComputedStyle(element);
  return {
    start: px(style.paddingBlockStart || style.paddingTop),
    end: px(style.paddingBlockEnd || style.paddingBottom),
  };
}

/** The bottom of the last row (its content's padding after it), in the
 *  viewport's scroll coordinates: the spacer does not count. */
function contentBottom(content: HTMLElement, spacer: HTMLElement | null, viewport: HTMLElement) {
  const padding = blockPadding(content);
  const top = viewport.getBoundingClientRect().top;
  let bottom = padding.start + padding.end;
  for (const item of itemsOf(content, spacer)) {
    bottom = Math.max(
      bottom,
      item.getBoundingClientRect().bottom - top + viewport.scrollTop + padding.end,
    );
  }
  return bottom;
}

/** An element's top in the viewport's scroll coordinates. */
function elementTop(element: HTMLElement, viewport: HTMLElement): number {
  return (
    element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop
  );
}

/** An element's top as the reader sees it, from the viewport's top edge. */
function viewportTopOf(element: HTMLElement, viewport: HTMLElement): number {
  return element.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
}

const maxScrollTop = (viewport: HTMLElement) =>
  Math.max(0, viewport.scrollHeight - viewport.clientHeight);

function scrollableOf(
  content: HTMLElement | null,
  spacer: HTMLElement | null,
  viewport: HTMLElement | null,
  edge: number,
): MessageScrollerScrollable {
  if (content === null || viewport === null) return NOWHERE;
  const bottom = contentBottom(content, spacer, viewport);
  return {
    start: viewport.scrollTop > edge,
    end: bottom - viewport.scrollTop - viewport.clientHeight > edge,
  };
}

/** Where to scroll so `element` meets the `align` edge, `margin` from it. */
function scrollTopFor(
  element: HTMLElement,
  align: MessageScrollerScrollAlign,
  margin: number,
  content: HTMLElement,
  viewport: HTMLElement,
): number {
  const top = elementTop(element, viewport);
  const height = element.getBoundingClientRect().height;
  const padding = blockPadding(content);
  switch (align) {
    case 'center': {
      const inset = Math.max(0, viewport.clientHeight - padding.start - padding.end);
      return top - padding.start - (inset - height) / 2 - margin;
    }
    case 'end':
      return top - viewport.clientHeight + height + padding.end + margin;
    case 'nearest': {
      const seenTop = viewport.scrollTop + padding.start;
      const seenBottom = viewport.scrollTop + viewport.clientHeight - padding.end;
      if (top >= seenTop && top + height <= seenBottom) return viewport.scrollTop;
      if (top < seenTop) return top - padding.start - margin;
      return top + height - viewport.clientHeight + padding.end + margin;
    }
    default:
      return top - padding.start - margin;
  }
}

function rowGap(element: HTMLElement | null): number {
  if (element === null) return 0;
  const style = getComputedStyle(element);
  return px(style.rowGap === 'normal' ? style.gap : style.rowGap);
}

function firstVisibleRow(
  content: HTMLElement,
  spacer: HTMLElement | null,
  viewport: HTMLElement,
): HTMLElement | null {
  const view = viewport.getBoundingClientRect();
  for (const item of itemsOf(content, spacer)) {
    if (item.dataset.messageId === undefined) continue;
    const rect = item.getBoundingClientRect();
    if (rect.bottom > view.top && rect.top < view.bottom) return item;
  }
  return null;
}

// --- The scroller --------------------------------------------------------------

/**
 * One transcript's position and the rules that move it. Its fields are the
 * reader's place, mutated in place: a scroll, a streamed chunk or a resize
 * changes no React state, and only `scrollable` and `pendingDefault` have
 * subscribers.
 */
class Scroller {
  autoScroll: boolean;
  edge = EDGE;
  peek = PEEK;
  margin = 0;
  private preserveOnPrepend = true;
  defaultPosition: MessageScrollerDefaultScrollPosition;
  defaultApplied = false;
  mode: Mode;

  root: HTMLElement | null = null;
  viewport: HTMLElement | null = null;
  content: HTMLElement | null = null;
  spacer: HTMLElement | null = null;
  private spacerGap = 0;
  private spacerHeight = 0;

  itemCount = 0;
  private firstItem: HTMLElement | null = null;
  /** The anchors already placed or passed over, by message id where a row
   *  has one: a row that remounts is not a new turn. */
  private readonly seenIds = new Set<string>();
  private readonly seenRows = new WeakSet<HTMLElement>();
  private lastScrollTop = 0;
  private autoscrolling = false;
  private autoscrollTimer: ReturnType<typeof setTimeout> | null = null;
  /** The turn held at its line while its reply streams. */
  private streamingTurn: HTMLElement | null = null;
  private readonly messages = new Map<string, HTMLElement>();
  private pendingJump: { messageId: string; options?: MessageScrollerScrollOptions } | null = null;
  /** The row to hold still when rows are added above it. */
  private prependAnchor: { element: HTMLElement; viewportTop: number } | null = null;
  private stateFrame: number | null = null;
  private jumpFrame: number | null = null;

  readonly scrollable = createStore<MessageScrollerScrollable>(
    NOWHERE,
    (a, b) => a.start === b.start && a.end === b.end,
  );
  /** While true the viewport waits, unseen, for its opening position. */
  readonly pendingDefault: Store<boolean>;

  constructor(autoScroll: boolean, defaultPosition: MessageScrollerDefaultScrollPosition) {
    this.autoScroll = autoScroll;
    this.defaultPosition = defaultPosition;
    this.mode = autoScroll ? 'following-bottom' : 'free-scrolling';
    this.pendingDefault = createStore(defaultPosition !== 'start', (a, b) => a === b);
  }

  // Elements, as their parts attach them.

  attachRoot = (element: HTMLElement | null) => {
    this.root = element;
    if (element !== null) this.mirror(this.scrollable.get());
  };

  attachViewport = (element: HTMLElement | null) => {
    this.viewport = element;
    if (element !== null) this.mirror(this.scrollable.get());
  };

  attachContent = (element: HTMLElement | null) => {
    this.content = element;
    if (element === null) this.forget();
  };

  /** The transcript went: the next one opens as a new one does. Queued
   *  jumps and the ids of turns already placed are kept. */
  private forget() {
    this.itemCount = 0;
    this.firstItem = null;
    this.spacerHeight = 0;
    this.lastScrollTop = 0;
    this.streamingTurn = null;
    this.prependAnchor = null;
    this.defaultApplied = false;
    this.mode = this.autoScroll ? 'following-bottom' : 'free-scrolling';
  }

  attachSpacer = (element: HTMLElement | null) => {
    this.spacer = element;
    this.spacerGap = rowGap(element?.parentElement ?? null);
  };

  /** Whether rows added above the reader's row hold it still. */
  holdOnPrepend(on: boolean) {
    this.preserveOnPrepend = on;
  }

  register = (messageId: string, element: HTMLElement): (() => void) => {
    this.messages.set(messageId, element);
    if (this.pendingJump?.messageId === messageId) this.scheduleJumpFlush();
    return () => {
      if (this.messages.get(messageId) === element) this.messages.delete(messageId);
    };
  };

  // State: which way the viewport can scroll, published and mirrored.

  private mirror(state: MessageScrollerScrollable) {
    const edges = [state.start && 'start', state.end && 'end'].filter(Boolean).join(' ');
    for (const element of [this.root, this.viewport]) {
      if (element === null) continue;
      if (edges === '') element.removeAttribute('data-scrollable');
      else element.setAttribute('data-scrollable', edges);
      element.toggleAttribute('data-autoscrolling', this.autoscrolling);
    }
  }

  /**
   * Arms following at the end, and releases it on any scroll up — a
   * scrollbar drag included — but never during a scroll of its own, and
   * never while a new turn is held: the spacer under it reads as the end,
   * and following there would pull the reader off the turn at the first
   * chunk. Content growing past the edge is not a scroll up: only a smaller
   * `scrollTop` is.
   */
  private reconcileFollow(next: MessageScrollerScrollable) {
    const scrollTop = this.viewport?.scrollTop ?? 0;
    const scrolledUp = scrollTop < this.lastScrollTop - EPSILON;
    this.lastScrollTop = scrollTop;
    if (
      this.autoScroll &&
      !next.end &&
      this.mode !== 'settling-jump' &&
      this.mode !== 'anchored-to-message'
    ) {
      this.mode = 'following-bottom';
    } else if (this.mode === 'following-bottom' && next.end && scrolledUp && !this.autoscrolling) {
      this.mode = 'free-scrolling';
    }
  }

  commit = () => {
    const next = scrollableOf(this.content, this.spacer, this.viewport, this.edge);
    this.reconcileFollow(next);
    // While following, the gap a chunk just opened is already being closed:
    // publishing it would strobe the jump button once per chunk.
    const published = this.mode === 'following-bottom' ? { ...next, end: false } : next;
    this.mirror(published);
    this.scrollable.set(published);
  };

  private scheduleCommit() {
    if (this.stateFrame !== null) return;
    this.stateFrame = requestAnimationFrame(() => {
      this.stateFrame = null;
      this.commit();
    });
  }

  private setAutoscrolling(on: boolean) {
    if (this.autoscrollTimer !== null) clearTimeout(this.autoscrollTimer);
    this.autoscrollTimer = null;
    if (this.autoscrolling !== on) {
      this.autoscrolling = on;
      this.commit();
    }
    if (!on) return;
    this.autoscrollTimer = setTimeout(() => {
      this.autoscrollTimer = null;
      this.autoscrolling = false;
      this.commit();
    }, AUTOSCROLLING_MS);
  }

  /** The room under the last row that lets a new turn reach its line. */
  private setSpacer(height: number) {
    const spacer = this.spacer;
    if (spacer === null) return;
    const next = Math.max(0, Math.ceil(height));
    if (next === this.spacerHeight) return;
    this.spacerHeight = next;
    spacer.hidden = next === 0;
    spacer.style.height = `${next}px`;
    // It sits in the content's flex column: cancel the gap before it.
    spacer.style.marginTop = next > 0 ? `${-this.spacerGap}px` : '';
  }

  // Moves.

  private scrollTo(top: number, behavior: ScrollBehavior = 'auto', autoscrolling = false) {
    const viewport = this.viewport;
    if (viewport === null) return;
    const next = Math.max(0, top);
    if (Math.abs(viewport.scrollTop - next) <= EPSILON) {
      viewport.scrollTop = next;
      this.commit();
      return;
    }
    if (autoscrolling) this.setAutoscrolling(true);
    // Element.scrollTo is missing where there is no layout (jsdom): a
    // scrollTop write is the same jump, at once.
    if (typeof viewport.scrollTo === 'function') viewport.scrollTo({ top: next, behavior });
    else viewport.scrollTop = next;
    this.scheduleCommit();
  }

  scrollToStart = ({ behavior = 'auto' }: MessageScrollerScrollOptions = {}): boolean => {
    if (this.viewport === null) return false;
    this.setSpacer(0);
    this.streamingTurn = null;
    this.mode = 'free-scrolling';
    this.scrollTo(0, behavior);
    return true;
  };

  scrollToEnd = ({ behavior = 'auto' }: MessageScrollerScrollOptions = {}): boolean => {
    const viewport = this.viewport;
    if (viewport === null) return false;
    this.setSpacer(0);
    this.streamingTurn = null;
    this.mode = this.autoScroll ? 'following-bottom' : 'free-scrolling';
    this.scrollTo(maxScrollTop(viewport), behavior, true);
    return true;
  };

  /** Brings `element` to its edge; `keepPeek` holds it there as a new turn,
   *  with the previous row peeking above it. */
  private bring(
    element: HTMLElement,
    {
      align = 'start',
      behavior = 'auto',
      scrollMargin = this.margin,
    }: MessageScrollerScrollOptions = {},
    keepPeek = false,
  ): boolean {
    const { content, viewport } = this;
    if (content === null || viewport === null || !content.contains(element)) return false;
    const top = scrollTopFor(
      element,
      align,
      keepPeek ? scrollMargin + this.peek : scrollMargin,
      content,
      viewport,
    );
    this.setSpacer(top + viewport.clientHeight - contentBottom(content, this.spacer, viewport));
    // The target is the row to hold through rows added above it before
    // this jump settles; the next scroll captures the first visible one.
    this.prependAnchor = { element, viewportTop: viewportTopOf(element, viewport) };
    this.mode = keepPeek ? 'anchored-to-message' : 'settling-jump';
    this.streamingTurn = keepPeek ? element : null;
    this.scrollTo(top, behavior);
    return true;
  }

  /** Places the held turn again, for the content's new size under it. */
  private reanchor(): boolean {
    const element = this.streamingTurn;
    if (element === null || !element.isConnected || this.mode !== 'anchored-to-message') {
      return false;
    }
    return this.bring(element, { align: 'start' }, true);
  }

  /**
   * Jumps to the row with `messageId`. Asked before any row mounted, the
   * jump waits for it (true: queued); asked for a row that is not there
   * once rows have mounted, it is refused (false) rather than guessed at.
   */
  scrollToMessage = (messageId: string, options?: MessageScrollerScrollOptions): boolean => {
    const element = this.messages.get(messageId);
    if (element === undefined) {
      if (this.itemCount > 0) return false;
      this.pendingJump = { messageId, options };
      this.markDefaultApplied();
      return true;
    }
    this.markDefaultApplied();
    if (this.bring(element, options)) {
      this.pendingJump = null;
      return true;
    }
    this.pendingJump = { messageId, options };
    return true;
  };

  /**
   * Jumps to `element`, anywhere inside a row (a step, a card's button), in
   * a settling jump: nothing follows the end or holds a turn against it
   * until the reader scrolls, so content that arrives after it never moves
   * the reader off it. False, moving nothing, when the element is not in
   * the transcript. It never waits: an element to jump to is already drawn.
   */
  scrollToElement = (element: HTMLElement, options?: MessageScrollerScrollOptions): boolean => {
    if (!this.bring(element, options)) return false;
    this.pendingJump = null;
    this.markDefaultApplied();
    return true;
  };

  private flushPendingJump(): boolean {
    const pending = this.pendingJump;
    if (pending === null) return false;
    const element = this.messages.get(pending.messageId);
    if (element === undefined || !this.bring(element, pending.options)) return false;
    this.pendingJump = null;
    this.markDefaultApplied();
    return true;
  }

  private scheduleJumpFlush() {
    if (this.jumpFrame !== null) return;
    this.jumpFrame = requestAnimationFrame(() => {
      this.jumpFrame = null;
      if (this.flushPendingJump()) this.capturePrependAnchor();
    });
  }

  private markDefaultApplied() {
    this.defaultApplied = true;
    this.pendingDefault.set(false);
  }

  /** Opens the first rows where `defaultPosition` says, once. */
  applyDefault(): boolean {
    if (this.defaultApplied || this.itemCount === 0) return false;
    const { content, viewport } = this;
    let handled: boolean;
    if (this.defaultPosition !== 'last-anchor') {
      handled = this.defaultPosition === 'end' ? this.scrollToEnd() : this.scrollToStart();
    } else {
      const anchors = content === null ? [] : itemsOf(content, this.spacer).filter(isAnchor);
      const anchor = anchors.at(-1);
      if (content === null || viewport === null || anchor === undefined) {
        handled = this.scrollToEnd();
      } else {
        // A short last turn fits under its anchor: the end shows all of it,
        // with no gap left below.
        const fits =
          contentBottom(content, this.spacer, viewport) - elementTop(anchor, viewport) <=
          viewport.clientHeight;
        handled = fits ? this.scrollToEnd() : this.bring(anchor, { align: 'start' }, true);
      }
    }
    if (handled) this.markDefaultApplied();
    return handled;
  }

  /** The opening position, or none to wait for: an empty transcript shows
   *  at once. */
  settleOpening() {
    if (!this.applyDefault() && this.itemCount === 0) this.pendingDefault.set(false);
  }

  /** `autoScroll` was turned on or off. */
  autoScrollChanged() {
    if (this.autoScroll && this.mode === 'following-bottom' && this.itemCount > 0) {
      this.scrollToEnd();
      return;
    }
    this.commit();
  }

  // Rows held still through history added above them.

  private restorePrepended(): boolean {
    const anchor = this.prependAnchor;
    const viewport = this.viewport;
    if (anchor === null || viewport === null || !anchor.element.isConnected) return false;
    // Measured from the viewport, so this does nothing where the browser's
    // own scroll anchoring already held the row, and corrects only where it
    // did not.
    const delta = viewportTopOf(anchor.element, viewport) - anchor.viewportTop;
    if (Math.abs(delta) <= EPSILON) return false;
    viewport.scrollTop += delta;
    anchor.viewportTop = viewportTopOf(anchor.element, viewport);
    this.scheduleCommit();
    return true;
  }

  private capturePrependAnchor() {
    const { content, viewport } = this;
    const row =
      content === null || viewport === null
        ? null
        : firstVisibleRow(content, this.spacer, viewport);
    this.prependAnchor =
      row === null || viewport === null
        ? null
        : { element: row, viewportTop: viewportTopOf(row, viewport) };
  }

  private seen(item: HTMLElement): boolean {
    const id = item.dataset.messageId;
    return id === undefined ? this.seenRows.has(item) : this.seenIds.has(id);
  }

  private see(item: HTMLElement) {
    const id = item.dataset.messageId;
    if (id === undefined) this.seenRows.add(item);
    else this.seenIds.add(id);
  }

  // What changed.

  /** Rows were added, removed or replaced. */
  contentChanged = () => {
    const content = this.content;
    if (content === null) return;
    const items = itemsOf(content, this.spacer);
    const before = this.itemCount;
    const firstBefore = this.firstItem;
    this.itemCount = items.length;
    this.firstItem = items[0] ?? null;
    const fresh = items.filter((item) => isAnchor(item) && !this.seen(item));
    for (const item of fresh) this.see(item);
    this.reconcile(items, before, firstBefore, fresh);
    this.capturePrependAnchor();
  };

  /** Order matters: the first rows, history added above, a new turn, then
   *  anything else. */
  private reconcile(
    items: HTMLElement[],
    before: number,
    firstBefore: HTMLElement | null,
    fresh: HTMLElement[],
  ) {
    if (this.flushPendingJump()) return;
    if (before === 0) {
      if (this.applyDefault()) return;
      if (items.length > 0 && this.autoScroll && this.scrollToEnd()) return;
      this.commit();
      return;
    }
    if (this.preserveOnPrepend && firstBefore !== null && items.indexOf(firstBefore) > 0) {
      this.restorePrepended();
      return;
    }
    const anchor = fresh[0];
    if (anchor !== undefined) {
      // Several turns arriving at once while the reader follows the end:
      // keep following it, rather than jump back to the first of them.
      if (this.autoScroll && this.mode === 'following-bottom' && fresh.length > 1) {
        this.scrollToEnd();
        return;
      }
      this.bring(anchor, { align: 'start' }, true);
      return;
    }
    if (this.mode === 'following-bottom' && this.autoScroll) this.scrollToEnd();
    else this.commit();
  }

  /** The viewport or the content changed size. */
  resized = () => {
    if (this.mode === 'following-bottom' && this.autoScroll) {
      this.scrollToEnd();
      return;
    }
    // Hold the new turn at its line as the content under it changes size,
    // or the browser clamps scrollTop and the turn drops.
    const spacerBefore = this.spacerHeight;
    if (this.reanchor()) {
      // The reply has used up the room under its turn, so the reader is at
      // the live edge: follow it from here. Only a change from some room to
      // none does this, so a turn taller than the viewport stays held.
      if (this.autoScroll && spacerBefore > 0 && this.spacerHeight === 0) this.scrollToEnd();
      return;
    }
    this.scheduleCommit();
  };

  /** The viewport scrolled, by anyone. */
  scrolled = () => {
    this.commit();
    this.capturePrependAnchor();
  };

  /** The reader scrolled on purpose: following, the held turn and a jump in
   *  flight all let go, so nothing re-pins against them. */
  released = () => {
    if (this.mode === 'free-scrolling') return;
    this.streamingTurn = null;
    this.mode = 'free-scrolling';
  };

  dispose = () => {
    if (this.stateFrame !== null) cancelAnimationFrame(this.stateFrame);
    if (this.jumpFrame !== null) cancelAnimationFrame(this.jumpFrame);
    if (this.autoscrollTimer !== null) clearTimeout(this.autoscrollTimer);
    // Cleared, so a remount (StrictMode replays effects) schedules afresh.
    this.stateFrame = null;
    this.jumpFrame = null;
    this.autoscrollTimer = null;
  };
}

const ScrollerContext = createContext<Scroller | null>(null);

function useScroller(part: string): Scroller {
  const scroller = useContext(ScrollerContext);
  if (scroller === null) throw new Error(`${part} must sit inside a MessageScrollerProvider`);
  return scroller;
}

function usePendingDefault(scroller: Scroller): boolean {
  const { pendingDefault } = scroller;
  return useSyncExternalStore(pendingDefault.subscribe, pendingDefault.get, pendingDefault.get);
}

/** Runs `run` a frame after `element` changes size: `run` resizes the
 *  spacer inside what is observed, and a resize while the observer delivers
 *  is a ResizeObserver loop error. */
function observeResize(element: Element, run: () => void): () => void {
  if (typeof ResizeObserver === 'undefined') return () => undefined;
  let frame = 0;
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(run);
  });
  observer.observe(element);
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
  };
}

/** Whether an event came from inside the element in the DOM, and not from
 *  a surface portalled out of a row (a menu, a card), which React bubbles
 *  here all the same: scrolling that is not reading the transcript. */
function fromInside(event: SyntheticEvent<HTMLElement>): boolean {
  const target = event.target;
  return target instanceof Node && event.currentTarget.contains(target);
}

/** A scroll key pressed to read, not one a control inside a row keeps. */
function readsOn(event: KeyboardEvent<HTMLElement>): boolean {
  if (!SCROLL_KEYS.has(event.key)) return false;
  const target = event.target;
  if (target === event.currentTarget || !(target instanceof Element)) return true;
  if (target.closest(KEY_KEEPERS) !== null) return false;
  return !(event.key === ' ' && target.closest(PRESSABLE) !== null);
}

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

// --- Parts -----------------------------------------------------------------------

/** The scroll state and its rules, for the parts inside. It draws nothing. */
export function MessageScrollerProvider({
  children,
  autoScroll = false,
  defaultScrollPosition = 'end',
  scrollEdgeThreshold = EDGE,
  scrollPreviousItemPeek = PEEK,
  scrollMargin = 0,
}: MessageScrollerProviderProps) {
  const held = useRef<Scroller | null>(null);
  held.current ??= new Scroller(autoScroll, defaultScrollPosition);
  const scroller = held.current;
  // The latest props, read by callbacks made once.
  scroller.autoScroll = autoScroll;
  scroller.edge = scrollEdgeThreshold;
  scroller.peek = scrollPreviousItemPeek;
  scroller.margin = scrollMargin;
  if (scroller.defaultPosition !== defaultScrollPosition) {
    // A new opening position applies again. The hold that keeps the first
    // one unseen is mount-only.
    scroller.defaultPosition = defaultScrollPosition;
    scroller.defaultApplied = false;
  }

  useLayoutEffect(() => {
    scroller.settleOpening();
  }, [scroller, defaultScrollPosition]);

  useLayoutEffect(() => {
    scroller.autoScrollChanged();
  }, [scroller, autoScroll]);

  useEffect(() => scroller.dispose, [scroller]);

  return <ScrollerContext value={scroller}>{children}</ScrollerContext>;
}

/** The frame: the viewport and its jump button sit in it. It fills its
 *  parent, so give it a parent with a height. */
export function MessageScroller({ className, ref, ...props }: ComponentProps<'div'>) {
  const scroller = useScroller('MessageScroller');
  const pending = usePendingDefault(scroller);
  const attach = useMergedRefs(scroller.attachRoot, ref);
  return (
    <div
      data-slot="message-scroller"
      {...props}
      ref={attach}
      data-pending-scroll={pending ? '' : undefined}
      className={classes('cb-ai-message-scroller', className)}
    />
  );
}

/** The scrolling region: a named, focusable region, so a keyboard can
 *  scroll the transcript. */
export function MessageScrollerViewport({
  preserveScrollOnPrepend = true,
  onScroll,
  onWheel,
  onTouchMove,
  onKeyDown,
  className,
  ref,
  ...props
}: MessageScrollerViewportProps) {
  const scroller = useScroller('MessageScrollerViewport');
  const pending = usePendingDefault(scroller);
  const attach = useMergedRefs(scroller.attachViewport, ref);

  useLayoutEffect(() => {
    scroller.holdOnPrepend(preserveScrollOnPrepend);
  }, [scroller, preserveScrollOnPrepend]);

  // The rows inside are counted before this viewport is attached (a child's
  // layout effects run before its parent's ref is set), so none of them
  // could be placed then. A provider mounted with them opens them after
  // this; one already there — a Chat whose empty state gives way to its
  // first rows, or to them again — never would, so they open here.
  useLayoutEffect(() => {
    scroller.settleOpening();
  }, [scroller]);

  useEffect(() => {
    const viewport = scroller.viewport;
    return viewport === null ? undefined : observeResize(viewport, scroller.resized);
  }, [scroller]);

  return (
    <div
      data-slot="message-scroller-viewport"
      role="region"
      aria-label="Messages"
      tabIndex={0}
      {...props}
      ref={attach}
      data-pending-scroll={pending ? '' : undefined}
      onScroll={(event) => {
        scroller.scrolled();
        onScroll?.(event);
      }}
      onWheel={(event) => {
        if (fromInside(event)) scroller.released();
        onWheel?.(event);
      }}
      onTouchMove={(event) => {
        if (fromInside(event)) scroller.released();
        onTouchMove?.(event);
      }}
      onKeyDown={(event) => {
        if (fromInside(event) && readsOn(event)) scroller.released();
        onKeyDown?.(event);
      }}
      className={classes('cb-ai-message-scroller-viewport', className)}
    />
  );
}

/**
 * The transcript: a log, so a screen reader hears each new row, and not
 * every streamed chunk (`aria-relevant="additions"`; pass `aria-busy` while
 * a turn streams to hold even that until it lands). Every direct child is a
 * MessageScrollerItem.
 */
export function MessageScrollerContent({
  spacerClassName,
  children,
  className,
  ref,
  ...props
}: MessageScrollerContentProps) {
  const scroller = useScroller('MessageScrollerContent');
  const attach = useMergedRefs(scroller.attachContent, ref);

  useLayoutEffect(() => {
    const content = scroller.content;
    if (content === null) return;
    scroller.contentChanged();
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(scroller.contentChanged);
    observer.observe(content, { childList: true });
    return () => observer.disconnect();
  }, [scroller]);

  useEffect(() => {
    const content = scroller.content;
    return content === null ? undefined : observeResize(content, scroller.resized);
  }, [scroller]);

  return (
    <div
      data-slot="message-scroller-content"
      role="log"
      aria-relevant="additions"
      {...props}
      ref={attach}
      className={classes('cb-ai-message-scroller-content', className)}
    >
      {children}
      <div
        ref={scroller.attachSpacer}
        aria-hidden="true"
        data-message-scroller-spacer=""
        hidden
        className={spacerClassName}
      />
    </div>
  );
}

/** One row: a message, a marker, a card. */
export function MessageScrollerItem({
  messageId,
  scrollAnchor = false,
  className,
  ref,
  ...props
}: MessageScrollerItemProps) {
  const scroller = useScroller('MessageScrollerItem');
  const register = useCallback(
    (element: HTMLDivElement | null) =>
      element === null || messageId === undefined
        ? undefined
        : scroller.register(messageId, element),
    [scroller, messageId],
  );
  const attach = useMergedRefs(register, ref);
  return (
    <div
      data-slot="message-scroller-item"
      {...props}
      ref={attach}
      data-message-id={messageId}
      data-scroll-anchor={scrollAnchor ? 'true' : 'false'}
      className={classes('cb-ai-message-scroller-item', className)}
    />
  );
}

/**
 * Jumps to the latest row (or the first) and, for the latest, follows again.
 * It is there only while there is somewhere to go: otherwise it is inert,
 * out of the tab order and faded out, so it is never a focus stop that does
 * nothing.
 */
export function MessageScrollerButton({
  direction = 'end',
  behavior,
  children,
  onClick,
  tabIndex,
  className,
  ...props
}: MessageScrollerButtonProps) {
  const scroller = useScroller('MessageScrollerButton');
  const { scrollable } = scroller;
  const active = useSyncExternalStore(
    scrollable.subscribe,
    () => scrollable.get()[direction],
    () => scrollable.get()[direction],
  );
  return (
    <button
      type="button"
      data-slot="message-scroller-button"
      {...props}
      data-direction={direction}
      data-active={active ? 'true' : 'false'}
      inert={!active}
      tabIndex={active ? tabIndex : -1}
      onClick={(event) => {
        if (!active) return;
        onClick?.(event);
        if (event.defaultPrevented) return;
        // It goes inert once there is nowhere to go: a reader whose focus is
        // on it lands in the transcript, not on the page's body. A press
        // that left focus elsewhere (WebKit focuses no pressed button, so
        // the composer keeps it) leaves it there.
        const button = event.currentTarget;
        if (button.ownerDocument.activeElement === button) {
          scroller.viewport?.focus({ preventScroll: true });
        }
        const how = behavior ?? (motionAllowed() ? 'smooth' : 'auto');
        if (direction === 'start') scroller.scrollToStart({ behavior: how });
        else scroller.scrollToEnd({ behavior: how });
      }}
      className={classes('cb-ai-message-scroller-button', className)}
    >
      {children ?? (
        <>
          <Icon name={direction === 'start' ? 'arrow-up' : 'arrow-down'} size={14} />
          <span>{direction === 'start' ? 'Jump to start' : 'Jump to latest'}</span>
        </>
      )}
    </button>
  );
}

function commandsOf(scroller: Scroller): MessageScrollerCommands {
  return {
    scrollToEnd: scroller.scrollToEnd,
    scrollToMessage: scroller.scrollToMessage,
    scrollToStart: scroller.scrollToStart,
    scrollToElement: scroller.scrollToElement,
  };
}

/** The scroll commands, for a control anywhere inside the provider: a
 *  search result, a permalink, an outline. */
export function useMessageScroller(): MessageScrollerCommands {
  const scroller = useScroller('useMessageScroller');
  return useMemo(() => commandsOf(scroller), [scroller]);
}

/** The scroll commands where a provider holds the caller, else null: for a
 *  part drawn both in a transcript and where none scrolls (a run's
 *  replayed turn draws the same steps), which must not throw outside one. */
export function useMessageScrollerIfAny(): MessageScrollerCommands | null {
  const scroller = useContext(ScrollerContext);
  return useMemo(() => (scroller === null ? null : commandsOf(scroller)), [scroller]);
}

/** Which way the viewport can still scroll: at the end is `!end`. */
export function useMessageScrollerScrollable(): MessageScrollerScrollable {
  const { scrollable } = useScroller('useMessageScrollerScrollable');
  return useSyncExternalStore(scrollable.subscribe, scrollable.get, scrollable.get);
}
