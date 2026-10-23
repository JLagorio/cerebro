// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, useLayoutEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerIfAny,
  useMessageScrollerScrollable,
  type MessageScrollerCommands,
  type MessageScrollerDefaultScrollPosition,
} from './MessageScroller';

/**
 * The Message Scroller (M91.8). jsdom has no layout, so these cases lay the
 * transcript out themselves, as a browser would: each row its height, one
 * under another, in a viewport VIEW tall that clamps its scrollTop. Frames,
 * the resize observer and the autoscroll timer run when a case says.
 */

const VIEW = 400;
/** Each row's height, by its message id. */
let heights = new Map<string, number>();
const positions = new WeakMap<Element, number>();
let scrolls: ScrollToOptions[] = [];

let frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
interface Observed {
  callback: ResizeObserverCallback;
  targets: Element[];
  disconnected: boolean;
}
let observers: Observed[] = [];

const isRow = (el: Element): el is HTMLElement =>
  el instanceof HTMLElement && el.dataset.slot === 'message-scroller-item';
const isViewport = (el: Element) =>
  el instanceof HTMLElement && el.dataset.slot === 'message-scroller-viewport';
const heightOf = (row: HTMLElement) => heights.get(row.dataset.messageId ?? '') ?? 50;

function rows(viewport: Element): HTMLElement[] {
  const content = viewport.querySelector('[data-slot="message-scroller-content"]');
  return content === null ? [] : [...content.children].filter(isRow);
}

function spacerHeight(viewport: Element): number {
  const spacer = viewport.querySelector<HTMLElement>('[data-message-scroller-spacer]');
  return spacer === null || spacer.hidden ? 0 : Number.parseFloat(spacer.style.height || '0');
}

function rect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    left: 0,
    right: 320,
    top,
    bottom: top + height,
    width: 320,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function layOut() {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isViewport(this) ? VIEW : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (!isViewport(this)) return 0;
      return rows(this).reduce((sum, row) => sum + heightOf(row), 0) + spacerHeight(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return positions.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      const max = Math.max(0, this.scrollHeight - this.clientHeight);
      positions.set(this, Math.min(max, Math.max(0, value)));
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value(this: HTMLElement, options: ScrollToOptions) {
      scrolls.push(options);
      this.scrollTop = options.top ?? 0;
    },
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (isViewport(this)) return rect(0, VIEW);
    if (!isRow(this)) return rect(0, 0);
    const viewport = this.closest('[data-slot="message-scroller-viewport"]') as HTMLElement;
    let top = 0;
    for (const row of rows(viewport)) {
      if (row === this) break;
      top += heightOf(row);
    }
    return rect(top - viewport.scrollTop, heightOf(this));
  });
}

beforeEach(() => {
  heights = new Map();
  scrolls = [];
  frames = new Map();
  observers = [];
  layOut();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frameId += 1;
    frames.set(frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly entry: Observed;
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: [], disconnected: false };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.push(target);
      }
      unobserve() {}
      disconnect() {
        this.entry.disconnected = true;
      }
    },
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of ['clientHeight', 'scrollHeight', 'scrollTop', 'scrollTo']) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  }
});

/** Runs the frames asked for, and the ones they ask for in turn. */
function flushFrames() {
  act(() => {
    for (let round = 0; round < 10 && frames.size > 0; round++) {
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback(0);
    }
  });
}

/** The content or the viewport changed size, as a resize observer reports
 *  it: a frame later. */
function resize() {
  act(() => {
    for (const observer of observers) {
      if (!observer.disconnected) observer.callback([], {} as ResizeObserver);
    }
  });
  flushFrames();
}

interface Row {
  id: string;
  height: number;
  anchor?: boolean;
}

let commands: ReturnType<typeof useMessageScroller>;
let edges: { start: boolean; end: boolean } = { start: false, end: false };

/** Hands the case the scroll commands and the edges, after each render. */
function Grab() {
  const found = useMessageScroller();
  const scrollable = useMessageScrollerScrollable();
  useLayoutEffect(() => {
    commands = found;
    edges = scrollable;
  });
  return null;
}

function Transcript({
  list,
  autoScroll = true,
  position = 'end',
  busy,
  drawing = 1,
  menu = false,
}: {
  list: Row[];
  autoScroll?: boolean;
  position?: MessageScrollerDefaultScrollPosition;
  busy?: boolean;
  /** A new drawing remounts every row under the same message ids. */
  drawing?: number;
  /** A menu portalled out of the first row, as a row's Popover is. */
  menu?: boolean;
}) {
  for (const row of list) heights.set(row.id, row.height);
  return (
    <MessageScrollerProvider autoScroll={autoScroll} defaultScrollPosition={position}>
      <Grab />
      <MessageScroller data-testid="root">
        <MessageScrollerViewport data-testid="viewport">
          <MessageScrollerContent aria-busy={busy} data-testid="content">
            {list.map((row) => (
              <MessageScrollerItem
                key={`${row.id}:${drawing}`}
                messageId={row.id}
                scrollAnchor={row.anchor}
              >
                <input aria-label={`field ${row.id}`} />
                {menu &&
                  row === list[0] &&
                  createPortal(<div data-testid="menu">Row menu</div>, document.body)}
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton data-testid="jump" />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

const viewport = () => screen.getByTestId('viewport');
const top = () => viewport().scrollTop;
const jump = () => screen.getByTestId('jump') as HTMLButtonElement;

/** Renders the next rows, and lets the content's mutation observer report
 *  them inside the same act. */
async function show(rerender: (ui: ReactNode) => void, ui: ReactNode) {
  await act(async () => {
    rerender(ui);
  });
  flushFrames();
}

const SAVED: Row[] = [
  { id: 'u1', height: 100, anchor: true },
  { id: 'a1', height: 800 },
];

describe('opening a thread', () => {
  it('opens at the end, and the jump button is inert while there is nowhere to go', () => {
    render(<Transcript list={SAVED} />);
    flushFrames();
    expect(top()).toBe(500);
    expect(viewport().hasAttribute('data-pending-scroll')).toBe(false);
    expect(jump().dataset.active).toBe('false');
    expect(jump().hasAttribute('inert')).toBe(true);
    expect(jump().tabIndex).toBe(-1);
    expect(edges).toEqual({ start: true, end: false });
    expect(screen.getByTestId('root').dataset.scrollable).toBe('start');
  });

  it('opens a long last turn at its anchor, the turn before peeking above it', () => {
    render(
      <Transcript
        position="last-anchor"
        list={[
          { id: 'u1', height: 100, anchor: true },
          { id: 'a1', height: 300 },
          { id: 'u2', height: 100, anchor: true },
          { id: 'a2', height: 800 },
        ]}
      />,
    );
    flushFrames();
    // u2 starts at 400; 64px of a1 stays in view above it.
    expect(top()).toBe(336);
  });

  it('opens a short last turn at the end, leaving no gap under it', () => {
    render(
      <Transcript
        position="last-anchor"
        list={[
          { id: 'u1', height: 100, anchor: true },
          { id: 'a1', height: 300 },
          { id: 'u2', height: 100, anchor: true },
          { id: 'a2', height: 100 },
        ]}
      />,
    );
    flushFrames();
    expect(top()).toBe(200);
  });

  it('opens at the start when asked to, and shows an empty thread at once', () => {
    const { unmount } = render(<Transcript list={SAVED} position="start" />);
    expect(top()).toBe(0);
    unmount();
    render(<Transcript list={[]} />);
    expect(viewport().hasAttribute('data-pending-scroll')).toBe(false);
    expect(screen.getByTestId('root').hasAttribute('data-pending-scroll')).toBe(false);
  });

  it('opens at the end under StrictMode, which replays its effects', () => {
    render(
      <StrictMode>
        <Transcript list={SAVED} />
      </StrictMode>,
    );
    flushFrames();
    expect(top()).toBe(500);
  });

  // A Chat holds its provider through its empty state, and draws the
  // scroller only once there are rows: the rows are counted before the
  // viewport they open in is attached, and the provider opened long before.
  describe('a scroller drawn under a provider already there', () => {
    const LAST_TURN_LONG: Row[] = [
      { id: 'u1', height: 100, anchor: true },
      { id: 'a1', height: 300 },
      { id: 'u2', height: 100, anchor: true },
      { id: 'a2', height: 800 },
    ];

    function Late({
      list,
      position,
    }: {
      list: Row[] | null;
      position: MessageScrollerDefaultScrollPosition;
    }) {
      for (const row of list ?? []) heights.set(row.id, row.height);
      return (
        <MessageScrollerProvider autoScroll defaultScrollPosition={position}>
          {list === null ? (
            <p>Nothing yet</p>
          ) : (
            <MessageScroller>
              <MessageScrollerViewport data-testid="viewport">
                <MessageScrollerContent>
                  {list.map((row) => (
                    <MessageScrollerItem
                      key={row.id}
                      messageId={row.id}
                      scrollAnchor={row.anchor}
                    />
                  ))}
                </MessageScrollerContent>
              </MessageScrollerViewport>
            </MessageScroller>
          )}
        </MessageScrollerProvider>
      );
    }

    it('opens its first rows at their last turn', async () => {
      const { rerender } = render(<Late list={null} position="last-anchor" />);
      await show(rerender, <Late list={LAST_TURN_LONG} position="last-anchor" />);
      // u2 starts at 400; 64px of a1 stays in view above it.
      expect(top()).toBe(336);
    });

    it('opens them at the end when asked to', async () => {
      const { rerender } = render(<Late list={null} position="end" />);
      await show(rerender, <Late list={LAST_TURN_LONG} position="end" />);
      expect(top()).toBe(900);
    });

    it('opens them again when the scroller is drawn a second time', async () => {
      const { rerender } = render(<Late list={null} position="last-anchor" />);
      await show(rerender, <Late list={LAST_TURN_LONG} position="last-anchor" />);
      await show(rerender, <Late list={null} position="last-anchor" />);
      await show(rerender, <Late list={LAST_TURN_LONG} position="last-anchor" />);
      expect(top()).toBe(336);
    });
  });
});

describe('a new turn', () => {
  it('settles the person’s turn near the top, and the reply grows into the room under it', async () => {
    const { rerender } = render(<Transcript list={SAVED} />);
    flushFrames();
    const asked: Row[] = [...SAVED, { id: 'u2', height: 100, anchor: true }];
    await show(rerender, <Transcript list={asked} />);
    // u2 starts at 900: it settles 64px down, a1's foot peeking above it,
    // with a spacer making the room the browser needs to scroll that far.
    expect(top()).toBe(836);
    expect(spacerHeight(viewport())).toBe(236);

    await show(rerender, <Transcript list={[...asked, { id: 'a2', height: 100 }]} />);
    resize();
    expect(top()).toBe(836);
    expect(spacerHeight(viewport())).toBe(136);

    // The reply uses up the room: from here it follows the live edge.
    heights.set('a2', 400);
    resize();
    expect(spacerHeight(viewport())).toBe(0);
    expect(top()).toBe(1000);
    heights.set('a2', 600);
    resize();
    expect(top()).toBe(1200);
  });

  it('keeps following the end when several turns arrive at once', async () => {
    const { rerender } = render(<Transcript list={SAVED} />);
    flushFrames();
    await show(
      rerender,
      <Transcript
        list={[
          ...SAVED,
          { id: 'u2', height: 100, anchor: true },
          { id: 'a2', height: 200 },
          { id: 'u3', height: 100, anchor: true },
          { id: 'a3', height: 200 },
        ]}
      />,
    );
    expect(top()).toBe(1500 - VIEW);
    expect(spacerHeight(viewport())).toBe(0);
  });

  it('does not take a turn drawn again by a new element for a new turn', async () => {
    const { rerender } = render(<Transcript list={SAVED} />);
    flushFrames();
    // Every row remounts under its old id: the reader stays at the end
    // rather than being pulled back to u1, the first anchor.
    await show(rerender, <Transcript list={SAVED} drawing={2} />);
    expect(top()).toBe(500);
  });
});

describe('following the live edge', () => {
  it('follows the reply while the reader stays at the end', () => {
    render(<Transcript list={SAVED} />);
    flushFrames();
    heights.set('a1', 1000);
    resize();
    expect(top()).toBe(700);
  });

  it('lets go when the reader scrolls up, and the jump button brings them back', () => {
    render(<Transcript list={SAVED} />);
    flushFrames();
    fireEvent.wheel(viewport());
    viewport().scrollTop = 200;
    fireEvent.scroll(viewport());
    expect(edges).toEqual({ start: true, end: true });
    expect(jump().dataset.active).toBe('true');
    expect(jump().hasAttribute('inert')).toBe(false);
    expect(screen.getByTestId('root').dataset.scrollable).toBe('start end');

    heights.set('a1', 1000);
    resize();
    expect(top()).toBe(200);

    fireEvent.click(jump());
    expect(top()).toBe(700);
    // Reduced motion, as in jsdom: the jump is instant, not smooth.
    expect(scrolls.at(-1)).toEqual({ top: 700, behavior: 'auto' });
    flushFrames();
    expect(jump().dataset.active).toBe('false');
    heights.set('a1', 1200);
    resize();
    expect(top()).toBe(900);
  });

  it('hands a keyboard reader’s focus to the transcript as the jump goes inert, and leaves focus held elsewhere', () => {
    render(<Transcript list={SAVED} />);
    flushFrames();
    fireEvent.wheel(viewport());
    viewport().scrollTop = 200;
    fireEvent.scroll(viewport());
    jump().focus();
    fireEvent.click(jump());
    flushFrames();
    expect(jump().hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(viewport());

    fireEvent.wheel(viewport());
    viewport().scrollTop = 200;
    fireEvent.scroll(viewport());
    const field = screen.getByLabelText('field u1');
    field.focus();
    fireEvent.click(jump());
    expect(top()).toBe(500);
    expect(document.activeElement).toBe(field);
  });

  it('lets go when the scrollbar moves the view up, with no wheel at all', () => {
    render(<Transcript list={SAVED} />);
    flushFrames();
    act(() => vi.advanceTimersByTime(200));
    viewport().scrollTop = 300;
    fireEvent.scroll(viewport());
    heights.set('a1', 1000);
    resize();
    expect(top()).toBe(300);
  });

  it('a scroll key releases it; a key typed into a field inside a row does not', () => {
    render(<Transcript list={SAVED} />);
    flushFrames();
    fireEvent.keyDown(screen.getByLabelText('field a1'), { key: ' ' });
    fireEvent.keyDown(screen.getByLabelText('field a1'), { key: 'PageUp' });
    heights.set('a1', 1000);
    resize();
    expect(top()).toBe(700);

    fireEvent.keyDown(viewport(), { key: 'PageUp' });
    heights.set('a1', 1200);
    resize();
    expect(top()).toBe(700);
  });

  it('keeps following through a wheel over a menu portalled out of a row', () => {
    render(<Transcript list={SAVED} menu />);
    flushFrames();
    fireEvent.wheel(screen.getByTestId('menu'));
    fireEvent.keyDown(screen.getByTestId('menu'), { key: 'PageUp' });
    heights.set('a1', 1000);
    resize();
    expect(top()).toBe(700);
  });

  it('follows when autoScroll is turned on at the end, and not before', () => {
    const { rerender } = render(<Transcript list={SAVED} autoScroll={false} />);
    flushFrames();
    expect(top()).toBe(500);
    heights.set('a1', 1000);
    resize();
    expect(top()).toBe(500);
    rerender(<Transcript list={SAVED} autoScroll />);
    flushFrames();
    heights.set('a1', 1100);
    resize();
    expect(top()).toBe(800);
  });
});

describe('jumps', () => {
  const LONG: Row[] = [
    { id: 'u1', height: 100, anchor: true },
    { id: 'a1', height: 800 },
    { id: 'u2', height: 100, anchor: true },
    { id: 'a2', height: 300 },
  ];

  it('scrollToMessage brings a row to the top and holds it there as the reply grows', () => {
    render(<Transcript list={LONG} />);
    flushFrames();
    expect(top()).toBe(900);
    let found = false;
    act(() => {
      found = commands.scrollToMessage('a1');
    });
    expect(found).toBe(true);
    expect(top()).toBe(100);
    heights.set('a2', 500);
    resize();
    expect(top()).toBe(100);
  });

  it('scrollToElement lands on an element in one settling jump that nothing re-pins (M92.4)', async () => {
    const { rerender } = render(<Transcript list={LONG} />);
    flushFrames();
    expect(top()).toBe(900);
    const a1 = viewport().querySelector('[data-message-id="a1"]') as HTMLElement;
    const before = scrolls.length;
    let moved = false;
    act(() => {
      moved = commands.scrollToElement(a1);
    });
    expect(moved).toBe(true);
    // At its edge, with no peek: a jump, not a new turn held at its line.
    expect(top()).toBe(100);
    expect(scrolls.slice(before)).toEqual([{ top: 100, behavior: 'auto' }]);
    // The reply under it streams on: nothing follows the end or re-anchors
    // against it, so the reader stays where the jump put them.
    heights.set('a2', 600);
    resize();
    await show(rerender, <Transcript list={[...LONG]} />);
    heights.set('a2', 900);
    resize();
    expect(top()).toBe(100);
    expect(scrolls.slice(before)).toHaveLength(1);
  });

  it('scrollToElement refuses an element the transcript does not hold, moving nothing', () => {
    render(<Transcript list={LONG} />);
    flushFrames();
    const stranger = document.createElement('div');
    document.body.append(stranger);
    let moved = true;
    act(() => {
      moved = commands.scrollToElement(stranger);
    });
    expect(moved).toBe(false);
    expect(top()).toBe(900);
    stranger.remove();
  });

  it('refuses a row that is not there once the transcript has rows', () => {
    render(<Transcript list={LONG} />);
    flushFrames();
    let found = true;
    act(() => {
      found = commands.scrollToMessage('missing');
    });
    expect(found).toBe(false);
    expect(top()).toBe(900);
  });

  it('queues a jump asked for before any row, and makes it when the row arrives', async () => {
    const { rerender } = render(<Transcript list={[]} />);
    let queued = false;
    act(() => {
      queued = commands.scrollToMessage('a1');
    });
    expect(queued).toBe(true);
    await show(rerender, <Transcript list={LONG} />);
    expect(top()).toBe(100);
  });

  it('aligns a row to the centre, the end, the nearest edge, or with a margin', () => {
    render(<Transcript list={LONG} />);
    flushFrames();
    act(() => void commands.scrollToMessage('u2', { align: 'center' }));
    expect(top()).toBe(750);
    act(() => void commands.scrollToMessage('u2', { align: 'end' }));
    expect(top()).toBe(600);
    // Already in view: nearest leaves it.
    act(() => void commands.scrollToMessage('u2', { align: 'nearest' }));
    expect(top()).toBe(600);
    act(() => void commands.scrollToMessage('u1', { align: 'nearest' }));
    expect(top()).toBe(0);
    act(() => void commands.scrollToMessage('a2', { align: 'nearest' }));
    expect(top()).toBe(900);
    act(() => void commands.scrollToMessage('u2', { scrollMargin: 20 }));
    expect(top()).toBe(880);
  });

  it('scrollToStart and the start button go to the top', () => {
    render(
      <MessageScrollerProvider autoScroll>
        <Grab />
        <MessageScroller>
          <MessageScrollerViewport data-testid="viewport">
            <MessageScrollerContent>
              {LONG.map((row) => {
                heights.set(row.id, row.height);
                return <MessageScrollerItem key={row.id} messageId={row.id} />;
              })}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton direction="start" data-testid="up" />
        </MessageScroller>
      </MessageScrollerProvider>,
    );
    flushFrames();
    const up = screen.getByTestId('up');
    expect(up.dataset.active).toBe('true');
    expect(up.textContent).toBe('Jump to start');
    fireEvent.click(up);
    expect(top()).toBe(0);
    flushFrames();
    expect(up.dataset.active).toBe('false');
    act(() => void commands.scrollToEnd());
    expect(top()).toBe(900);
    act(() => void commands.scrollToStart());
    expect(top()).toBe(0);
  });

  it('a click the caller prevents moves nothing', () => {
    render(
      <MessageScrollerProvider autoScroll>
        <MessageScroller>
          <MessageScrollerViewport data-testid="viewport">
            <MessageScrollerContent>
              {SAVED.map((row) => {
                heights.set(row.id, row.height);
                return <MessageScrollerItem key={row.id} messageId={row.id} />;
              })}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton
            direction="start"
            data-testid="up"
            onClick={(event) => event.preventDefault()}
          />
        </MessageScroller>
      </MessageScrollerProvider>,
    );
    flushFrames();
    fireEvent.click(screen.getByTestId('up'));
    expect(top()).toBe(500);
  });
});

describe('history added above', () => {
  it('holds the row the reader was on', async () => {
    const list: Row[] = [
      { id: 'a', height: 100 },
      { id: 'b', height: 100 },
      { id: 'c', height: 100 },
      { id: 'd', height: 500 },
    ];
    const { rerender } = render(<Transcript list={list} autoScroll={false} position="start" />);
    viewport().scrollTop = 150;
    fireEvent.scroll(viewport());
    await show(
      rerender,
      <Transcript list={[{ id: 'z', height: 200 }, ...list]} autoScroll={false} position="start" />,
    );
    // b was 50px above the top edge; it still is.
    expect(top()).toBe(350);
  });
});

describe('the parts', () => {
  it('draws a named, focusable region around a log, busy while a turn streams', () => {
    render(<Transcript list={SAVED} busy />);
    const region = screen.getByRole('region', { name: 'Messages' });
    expect(region).toBe(viewport());
    expect(region.tabIndex).toBe(0);
    const log = screen.getByRole('log');
    expect(log.getAttribute('aria-relevant')).toBe('additions');
    expect(log.getAttribute('aria-busy')).toBe('true');
    const spacer = log.querySelector('[data-message-scroller-spacer]') as HTMLElement;
    expect(spacer.getAttribute('aria-hidden')).toBe('true');
    expect(spacer.hidden).toBe(true);
    const item = log.querySelector('[data-message-id="u1"]') as HTMLElement;
    expect(item.dataset.scrollAnchor).toBe('true');
    expect(log.querySelector('[data-message-id="a1"]')?.getAttribute('data-scroll-anchor')).toBe(
      'false',
    );
  });

  it('names the jump in words, and takes a caller’s refs', () => {
    const root = { current: null as HTMLDivElement | null };
    const item = vi.fn();
    render(
      <MessageScrollerProvider>
        <MessageScroller ref={root}>
          <MessageScrollerViewport>
            <MessageScrollerContent>
              <MessageScrollerItem messageId="x" ref={item} />
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>,
    );
    expect(root.current?.dataset.slot).toBe('message-scroller');
    expect(item).toHaveBeenCalledWith(expect.any(HTMLDivElement));
    expect(screen.getByText('Jump to latest')).toBeTruthy();
  });

  it('jumps by scrollTop where the element has no scrollTo, as in jsdom', () => {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTo;
    render(<Transcript list={SAVED} />);
    flushFrames();
    expect(top()).toBe(500);
    expect(scrolls).toEqual([]);
  });

  it('lets go of its observers, frames and timer when it unmounts', () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const { unmount } = render(<Transcript list={SAVED} />);
    expect(observers).toHaveLength(2);
    // A resize leaves a frame pending; unmounting cancels it.
    act(() => observers[0].callback([], {} as ResizeObserver));
    expect(frames.size).toBeGreaterThan(0);
    unmount();
    expect(observers.every((observer) => observer.disconnected)).toBe(true);
    expect(disconnect).toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('says where a part must sit when it is used outside the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<MessageScrollerItem />)).toThrow(
      'MessageScrollerItem must sit inside a MessageScrollerProvider',
    );
  });

  it('answers a part drawn where no transcript scrolls with null, and one inside with its commands (M92.4)', () => {
    let any: MessageScrollerCommands | null | undefined;
    let own: MessageScrollerCommands | undefined;
    function Anywhere() {
      const found = useMessageScrollerIfAny();
      useLayoutEffect(() => {
        any = found;
      });
      return null;
    }
    function Inside() {
      const found = useMessageScroller();
      useLayoutEffect(() => {
        own = found;
      });
      return <Anywhere />;
    }
    render(<Anywhere />);
    expect(any).toBeNull();
    cleanup();
    render(
      <MessageScrollerProvider>
        <Inside />
      </MessageScrollerProvider>,
    );
    expect(any).not.toBeNull();
    expect(any).toEqual(own);
    expect(any?.scrollToElement).toBe(own?.scrollToElement);
  });
});
