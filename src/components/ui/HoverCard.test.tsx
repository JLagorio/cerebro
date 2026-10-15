// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLayers } from '@/components/ui/layers';
import { useEscapeLayer } from '@/components/ui/Popover';
import {
  HOVER_CLOSE_MS,
  HOVER_OPEN_MS,
  HoverCard,
  openHoverCardCount,
  resetHoverCards,
  useHoldParentHoverCard,
  type HoverCardProps,
} from './HoverCard';

/**
 * The hover card (M59.7): Macro's behaviour in Cerebro code. Pointer events
 * are built as MouseEvents with screen coordinates, because jsdom has no
 * PointerEvent; the card reads only screenX/Y, buttons and pointerType.
 */

let at = 0;
/** A real move: a screen position the window has not seen yet. */
function move(el: Element, init: MouseEventInit & { pointerType?: string } = {}) {
  at += 7;
  const e = new MouseEvent('pointermove', { bubbles: true, screenX: at, screenY: at, ...init });
  if (init.pointerType !== undefined)
    Object.defineProperty(e, 'pointerType', { value: init.pointerType });
  act(() => {
    el.dispatchEvent(e);
  });
}
/** A move to where the pointer already is. */
function still(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, screenX: at, screenY: at }));
  });
}
const edge = (el: Element, type: 'pointerenter' | 'pointerleave') =>
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: false }));
  });
const press = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  });
const tick = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

const cards = () => screen.queryAllByTestId('hover-card');

function Card(props: Partial<HoverCardProps> & { name?: string; body?: React.ReactNode }) {
  const { name = 'Link', body, ...rest } = props;
  return (
    <HoverCard label={`${name} preview`} content={() => body ?? <p>About {name}</p>} {...rest}>
      {({ ref, describedBy }) => (
        <button type="button" ref={ref} aria-describedby={describedBy}>
          {name}
        </button>
      )}
    </HoverCard>
  );
}

const trigger = (name = 'Link') => screen.getByRole('button', { name });

/** Hover `name` until its card is up. */
function openCard(name = 'Link') {
  move(trigger(name));
  tick(HOVER_OPEN_MS);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetHoverCards();
  resetLayers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('opening', () => {
  it('opens 300 ms after a real move, not before', () => {
    render(<Card />);
    move(trigger());
    tick(HOVER_OPEN_MS - 1);
    expect(cards()).toHaveLength(0);
    tick(1);
    expect(cards()).toHaveLength(1);
    expect(screen.getByRole('group', { name: 'Link preview' }).textContent).toBe('About Link');
  });

  it('never opens for a move where the pointer already was', () => {
    render(<Card />);
    const button = trigger();
    // The window saw the pointer here before the chip appeared under it.
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { screenX: 500, screenY: 500 }));
    });
    act(() => {
      button.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, screenX: 500, screenY: 500 }),
      );
    });
    tick(HOVER_OPEN_MS * 2);
    expect(cards()).toHaveLength(0);
  });

  it('never opens with a button pressed, or for touch', () => {
    render(<Card />);
    move(trigger(), { buttons: 1 });
    tick(HOVER_OPEN_MS);
    move(trigger(), { pointerType: 'touch' });
    tick(HOVER_OPEN_MS);
    expect(cards()).toHaveLength(0);
  });

  it('closes 150 ms after the pointer leaves, and entering the card cancels it', () => {
    render(<Card />);
    openCard();
    edge(trigger(), 'pointerleave');
    edge(cards()[0], 'pointerenter');
    tick(HOVER_CLOSE_MS * 2);
    expect(cards()).toHaveLength(1);
    edge(cards()[0], 'pointerleave');
    tick(HOVER_CLOSE_MS - 1);
    expect(cards()).toHaveLength(1);
    tick(1);
    expect(cards()).toHaveLength(0);
  });
});

describe('groups and nesting', () => {
  it('closes the group’s open card at once, and leaves another group’s alone', () => {
    render(
      <>
        <Card name="One" />
        <Card name="Two" />
        <Card name="Other" group="elsewhere" />
      </>,
    );
    openCard('Other');
    openCard('One');
    expect(cards().map((c) => c.textContent)).toEqual(['About Other', 'About One']);
    move(trigger('Two'));
    tick(HOVER_OPEN_MS);
    expect(cards().map((c) => c.textContent)).toEqual(['About Other', 'About Two']);
    expect(openHoverCardCount('hover-card')).toBe(1);
  });

  it('keeps its parent open while a card opened from inside it is up', () => {
    render(<Card name="Parent" body={<Card name="Child" />} />);
    openCard('Parent');
    edge(trigger('Parent'), 'pointerleave');
    edge(cards()[0], 'pointerenter');
    openCard('Child');
    expect(cards()).toHaveLength(2);
    // Into the child's card, out of the parent's.
    edge(trigger('Child'), 'pointerleave');
    edge(cards()[0], 'pointerleave');
    edge(cards()[1], 'pointerenter');
    tick(HOVER_CLOSE_MS * 3);
    expect(cards()).toHaveLength(2);
    // Out of everything: the child goes, then its parent.
    edge(cards()[1], 'pointerleave');
    tick(HOVER_CLOSE_MS);
    tick(HOVER_CLOSE_MS);
    expect(cards()).toHaveLength(0);
  });
});

function Surface({ onClose }: { onClose: () => void }) {
  useEscapeLayer(onClose);
  return null;
}

describe('Escape', () => {
  it('closes the child, then the parent, then the surface below', () => {
    const surfaceClosed = vi.fn();
    render(
      <>
        <Surface onClose={surfaceClosed} />
        <Card name="Parent" body={<Card name="Child" />} />
      </>,
    );
    openCard('Parent');
    openCard('Child');
    expect(cards()).toHaveLength(2);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(cards().map((c) => c.getAttribute('aria-label'))).toEqual(['Parent preview']);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(cards()).toHaveLength(0);
    expect(surfaceClosed).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(surfaceClosed).toHaveBeenCalledOnce();
  });
});

describe('dismissal', () => {
  it('closes on a press outside, but a press inside the child keeps the parent', () => {
    render(
      <>
        <p>Elsewhere</p>
        <Card name="Parent" body={<Card name="Child" body={<span>deep</span>} />} />
      </>,
    );
    openCard('Parent');
    openCard('Child');
    press(screen.getByText('deep'));
    expect(cards()).toHaveLength(2);
    press(screen.getByText('Elsewhere'));
    expect(cards()).toHaveLength(0);
  });

  it('closes on a scroll outside, not on one inside', () => {
    render(
      <>
        <div data-testid="pane" />
        <Card />
      </>,
    );
    openCard();
    tick(20); // the frame that arms the guard
    act(() => {
      cards()[0].dispatchEvent(new Event('scroll'));
    });
    expect(cards()).toHaveLength(1);
    act(() => {
      screen.getByTestId('pane').dispatchEvent(new Event('scroll'));
    });
    expect(cards()).toHaveLength(0);
  });

  it('closes when you type elsewhere, but not on a bare modifier', () => {
    render(<Card />);
    openCard();
    fireEvent.keyDown(document.body, { key: 'Shift' });
    expect(cards()).toHaveLength(1);
    fireEvent.keyDown(document.body, { key: 'a' });
    expect(cards()).toHaveLength(0);
  });

  it('stays closed after Escape until the pointer leaves', () => {
    render(<Card />);
    openCard();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(cards()).toHaveLength(0);
    openCard();
    expect(cards()).toHaveLength(0);
    edge(trigger(), 'pointerleave');
    openCard();
    expect(cards()).toHaveLength(1);
  });

  it('closes on a press on the trigger, and stays quiet until the pointer leaves', () => {
    render(<Card />);
    openCard();
    press(trigger());
    expect(cards()).toHaveLength(0);
    openCard();
    expect(cards()).toHaveLength(0);
  });
});

function Holder() {
  useHoldParentHoverCard(true);
  return <span>holding</span>;
}

describe('the API', () => {
  it('useHoldParentHoverCard holds the card open', () => {
    render(<Card body={<Holder />} />);
    openCard();
    edge(trigger(), 'pointerleave');
    tick(HOVER_CLOSE_MS * 3);
    expect(cards()).toHaveLength(1);
  });

  it('disabled closes it, and keeps it closed', () => {
    const { rerender } = render(<Card />);
    openCard();
    rerender(<Card disabled />);
    expect(cards()).toHaveLength(0);
    move(trigger());
    tick(HOVER_OPEN_MS);
    expect(cards()).toHaveLength(0);
  });

  it('unregisters on unmount', () => {
    const { unmount } = render(<Card />);
    openCard();
    expect(openHoverCardCount('hover-card')).toBe(1);
    unmount();
    expect(openHoverCardCount('hover-card')).toBe(0);
    expect(cards()).toHaveLength(0);
  });

  it('keeps a click in the card from reaching an ancestor’s onClick', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <div onClick={outer}>
        <Card
          body={
            <button type="button" onClick={inner}>
              Inside
            </button>
          }
        />
      </div>,
    );
    openCard();
    fireEvent.click(screen.getByRole('button', { name: 'Inside' }));
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
  });

  it('sets aria-describedby only while open, and adds no wrapper node', () => {
    const { container } = render(<Card />);
    const button = trigger();
    expect(container.firstElementChild).toBe(button);
    expect(container.childNodes).toHaveLength(1);
    expect(button.hasAttribute('aria-describedby')).toBe(false);
    openCard();
    expect(button.getAttribute('aria-describedby')).toBe(cards()[0].id);
    expect(container.childNodes).toHaveLength(1);
    edge(button, 'pointerleave');
    tick(HOVER_CLOSE_MS);
    expect(button.hasAttribute('aria-describedby')).toBe(false);
  });

  it('opens on keyboard focus only when focus is visible', () => {
    render(<Card />);
    const button = trigger();
    const matches = vi.spyOn(button, 'matches').mockReturnValue(false);
    act(() => button.focus());
    tick(HOVER_OPEN_MS);
    expect(cards()).toHaveLength(0);
    act(() => button.blur());
    matches.mockReturnValue(true);
    act(() => button.focus());
    tick(HOVER_OPEN_MS);
    expect(cards()).toHaveLength(1);
  });
});

describe('a still pointer', () => {
  it('never opens on enter alone', () => {
    render(<Card />);
    move(document.body); // where the pointer rests
    edge(trigger(), 'pointerenter');
    still(trigger());
    tick(HOVER_OPEN_MS * 2);
    expect(cards()).toHaveLength(0);
  });
});
