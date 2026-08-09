import { StrictMode, useRef, useState } from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dialog } from '@/components/ui/Dialog';
import { Popover } from '@/components/ui/Popover';
import { hasLayers, resetLayers } from '@/components/ui/layers';

/**
 * The dismissal contract no popover had (M16.1).
 *
 * Every one of these cases was reachable in the shipped app: the
 * add-property surface answered "no" to click-away, and "yes, and it also
 * closes the record panel" to Escape.
 */

/** Wait one animation frame — the window the scroll guard covers. */
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

function Harness({ trapFocus, onClose }: { trapFocus?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  return (
    <div>
      <button type="button" data-testid="outside">
        outside
      </button>
      <span className="relative inline-flex">
        <button type="button" data-testid="trigger" onClick={() => setOpen((v) => !v)}>
          open
        </button>
        {open && (
          <Popover onClose={close} trapFocus={trapFocus} role="menu" ariaLabel="Test menu">
            <button type="button" data-testid="item-a">
              a
            </button>
            <button type="button" data-testid="item-b">
              b
            </button>
          </Popover>
        )}
      </span>
    </div>
  );
}

describe('Popover dismissal contract', () => {
  beforeEach(() => resetLayers());

  it('renders through a portal, escaping any clipping ancestor', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    await user.click(screen.getByTestId('trigger'));

    const menu = screen.getByRole('menu');
    expect(menu).toBeTruthy();
    // The whole point: the panel is not inside the component's own subtree.
    expect(container.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
  });

  it('closes when a press lands outside', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId('trigger'));
    expect(screen.queryByRole('menu')).toBeTruthy();

    await user.click(screen.getByTestId('outside'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('stays open when a press lands inside', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId('trigger'));

    await user.click(screen.getByTestId('item-a'));
    expect(screen.queryByRole('menu')).toBeTruthy();
  });

  it('lets the trigger toggle instead of closing and reopening', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId('trigger'));
    expect(screen.queryByRole('menu')).toBeTruthy();

    // The outside-press handler must ignore the anchor, or this press closes
    // via the document listener and the onClick immediately reopens.
    await user.click(screen.getByTestId('trigger'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId('trigger'));

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps Escape away from listeners behind it', async () => {
    const user = userEvent.setup();
    const behind = vi.fn();
    // Exactly how DetailPanel listens — and why Escape in the add-property
    // surface used to close the whole panel.
    document.addEventListener('keydown', behind);
    try {
      render(<Harness />);
      await user.click(screen.getByTestId('trigger'));
      behind.mockClear();

      await user.keyboard('{Escape}');
      expect(behind).not.toHaveBeenCalled();
      expect(screen.queryByRole('menu')).toBeNull();
    } finally {
      document.removeEventListener('keydown', behind);
    }
  });

  it('registers as a layer only while open', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(hasLayers()).toBe(false);

    await user.click(screen.getByTestId('trigger'));
    expect(hasLayers()).toBe(true);

    await user.keyboard('{Escape}');
    expect(hasLayers()).toBe(false);
  });

  it('sends focus back to the trigger on close', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByTestId('trigger');
    await user.click(trigger);

    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(trigger);
  });

  it('holds Tab inside when asked to trap', async () => {
    const user = userEvent.setup();
    render(<Harness trapFocus />);
    await user.click(screen.getByTestId('trigger'));

    screen.getByTestId('item-b').focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId('item-a'));
  });

  it('closes when a pane behind it scrolls', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await user.click(screen.getByTestId('trigger'));

    // One frame, added in M18.4 — see the test below for why. The contract is
    // unchanged: a scroll the user made still dismisses. What changed is that
    // the scroll the OPENING CLICK caused no longer counts as one, and this
    // test could not tell the two apart because it never waited.
    await frame();
    document.dispatchEvent(new Event('scroll', { bubbles: false }));
    expect(onClose).toHaveBeenCalled();
  });

  it('survives the scroll its own opening click caused', async () => {
    // M18.4, and a real bug rather than a test artifact. Clicking a trigger
    // that is only partly in view makes the browser scroll it into view, and
    // scroll events are dispatched asynchronously — so the scroll caused by
    // OPENING the popover arrived after it had mounted and dismissed it
    // instantly. On screen that reads as a button that does nothing, and it
    // got worse the further down a long form you went.
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await user.click(screen.getByTestId('trigger'));

    // Same turn as the click, before any frame has passed.
    document.dispatchEvent(new Event('scroll', { bubbles: false }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeTruthy();
  });
});

describe('Popover stacking', () => {
  beforeEach(() => resetLayers());

  function Nested() {
    const [outer, setOuter] = useState(false);
    const [inner, setInner] = useState(false);
    const outerAnchor = useRef<HTMLButtonElement>(null);
    return (
      <div>
        <button
          type="button"
          ref={outerAnchor}
          data-testid="trigger"
          onClick={() => setOuter(true)}
        >
          open
        </button>
        {outer && (
          <Popover
            onClose={() => setOuter(false)}
            anchorRef={outerAnchor}
            role="menu"
            ariaLabel="Outer"
          >
            <button type="button" data-testid="open-inner" onClick={() => setInner(true)}>
              deeper
            </button>
            {inner && (
              <Popover onClose={() => setInner(false)} role="listbox" ariaLabel="Inner">
                <button type="button" data-testid="leaf">
                  leaf
                </button>
              </Popover>
            )}
          </Popover>
        )}
      </div>
    );
  }

  it('dismisses one surface per Escape, innermost first', async () => {
    const user = userEvent.setup();
    render(<Nested />);
    await user.click(screen.getByTestId('trigger'));
    await user.click(screen.getByTestId('open-inner'));
    expect(screen.queryByRole('listbox')).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('menu')).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  /**
   * The outside-press check had the gap Escape did not (M16.35).
   *
   * Escape asked the layer stack who owned the keystroke; the pointerdown
   * handler asked only `surfaceRef.contains(target)`. A `Popover` portals to
   * `document.body`, so the inner menu is NOT a descendant of the outer one —
   * every press the user aimed at the inner menu read as "outside" to the
   * outer one and tore it down, taking the inner menu with it.
   *
   * `FilterValueEditor` had already met this and worked around it by writing
   * a non-portalling surface of its own ("pressing a day in a portalled date
   * picker closed the rule editor it was opened from"). The stack answers it
   * for every nesting instead.
   */
  it('leaves the parent open when the press lands in a menu opened from it', async () => {
    const user = userEvent.setup();
    render(<Nested />);
    await user.click(screen.getByTestId('trigger'));
    await user.click(screen.getByTestId('open-inner'));

    await user.click(screen.getByTestId('leaf'));
    expect(screen.queryByRole('listbox')).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeTruthy();
  });

  // A press past both of them still dismisses both — the fix suppresses the
  // parent's dismissal only for nodes a layer ABOVE it claims as its own.
  it('still closes both when the press lands past everything', async () => {
    const user = userEvent.setup();
    render(<Nested />);
    await user.click(screen.getByTestId('trigger'));
    await user.click(screen.getByTestId('open-inner'));

    await user.click(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  // Same gap, same fix: `closeOnScroll` fired on any scroll outside the
  // panel's own subtree, so scrolling a long nested menu dismissed the menu
  // that opened it.
  it('leaves the parent open when a menu opened from it scrolls', async () => {
    const user = userEvent.setup();
    render(<Nested />);
    await user.click(screen.getByTestId('trigger'));
    await user.click(screen.getByTestId('open-inner'));

    fireEvent.scroll(screen.getByRole('listbox'));
    expect(screen.queryByRole('menu')).toBeTruthy();
  });

  /**
   * The app renders under StrictMode, which mounts every effect twice —
   * mount, cleanup, mount. Registration moved into the layout phase (M16.35)
   * and the stack is ORDERED, so a double invoke that re-ordered or duplicated
   * entries would unwind these surfaces backwards or strand one on the stack
   * for every popover opened afterwards to lose its Escape to.
   */
  it('unwinds in the same order under StrictMode, and leaves nothing behind', async () => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <Nested />
      </StrictMode>,
    );
    await user.click(screen.getByTestId('trigger'));
    await user.click(screen.getByTestId('open-inner'));

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('menu')).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(hasLayers()).toBe(false);
  });
});

describe('Popover inside a Dialog (M29.27)', () => {
  beforeEach(() => resetLayers());

  /**
   * A menu opened from inside a Dialog portals to document.body, so it stops
   * being a descendant of the card and competes with the SCRIM in the root
   * stacking context. At `z-50` it lost to the scrim's 1000: the panel was
   * invisible and unclickable, yet still held a dismiss layer — so the next
   * Escape closed the popover nobody could see instead of the dialog, and the
   * click after that was swallowed as its outside-press. Found on M29.27's
   * full-screen block editor, whose toolbar carries the layout menu.
   *
   * Tailwind is not loaded in jsdom, so the panel's z-index is read from its
   * class; the scrim's comes from Dialog's own injected stylesheet. Comparing
   * the two — rather than pinning a literal — fails if either side moves alone.
   */
  it('portals above the scrim of the dialog it was opened from', async () => {
    const user = userEvent.setup();
    render(
      <Dialog open fullscreen title="Full screen">
        <Harness />
      </Dialog>,
    );
    await user.click(screen.getByTestId('trigger'));

    const panel = screen.getByRole('menu').parentElement;
    // Both spellings, so reverting to the bare `z-50` fails on the COMPARISON
    // (50 is not > 1000) rather than on a regex that quietly matched nothing.
    const declared = (panel?.className ?? '').match(/\bz-\[?(\d+)\]?/);
    expect(declared).toBeTruthy();

    const scrim = document.querySelector('.cb-dlg-scrim');
    const scrimZ = Number(window.getComputedStyle(scrim as Element).zIndex);
    expect(scrimZ).toBe(1000);
    expect(Number(declared?.[1])).toBeGreaterThan(scrimZ);
  });
});
