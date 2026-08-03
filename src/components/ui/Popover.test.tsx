import { useRef, useState } from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Popover } from '@/components/ui/Popover';
import { hasLayers, resetLayers } from '@/components/ui/layers';

/**
 * The dismissal contract no popover had (M16.1).
 *
 * Every one of these cases was reachable in the shipped app: the
 * add-property surface answered "no" to click-away, and "yes, and it also
 * closes the record panel" to Escape.
 */

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

    document.dispatchEvent(new Event('scroll', { bubbles: false }));
    expect(onClose).toHaveBeenCalled();
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
                <button type="button">leaf</button>
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
});
