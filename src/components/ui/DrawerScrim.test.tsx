// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEscapeLayer } from '@/components/ui/Popover';
import { hasModalLayers } from './layers';
import { DrawerScrim, useDrawerFocus } from './DrawerScrim';

/**
 * M52 — a drawer opened over the reading column could only be closed from
 * the header toggle it was opened with: Escape and a press on the column did
 * nothing.
 */
describe('DrawerScrim', () => {
  afterEach(cleanup);

  const scrim = (onDismiss: () => void) => (
    <DrawerScrim
      onDismiss={onDismiss}
      label="Close the panel"
      testId="scrim"
      className="absolute inset-0"
    />
  );

  it('dismisses on a press on what the drawer covers', () => {
    const onDismiss = vi.fn();
    render(scrim(onDismiss));
    fireEvent.click(screen.getByTestId('scrim'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('can retain page shortcuts without surrendering its own Escape', () => {
    const dismiss = vi.fn();
    render(
      <DrawerScrim
        modal={false}
        onDismiss={dismiss}
        label="Close navigation"
        className="absolute inset-0"
      />,
    );
    expect(hasModalLayers()).toBe(false);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('dismisses on Escape', () => {
    const onDismiss = vi.fn();
    render(scrim(onDismiss));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape to a surface opened above it', () => {
    function Menu({ onClose }: { onClose: () => void }) {
      useEscapeLayer(onClose);
      return null;
    }
    const onDismiss = vi.fn();
    const onClose = vi.fn();
    render(
      <>
        {scrim(onDismiss)}
        <Menu onClose={onClose} />
      </>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('is out of the tab order — Escape is the keyboard way out', () => {
    render(scrim(() => {}));
    expect(screen.getByRole('button', { name: 'Close the panel' }).tabIndex).toBe(-1);
  });

  /** A toggle, and the drawer it opens with the scrim under it. */
  function Harness({
    onCommit = () => {},
    claimsEscape = false,
  }: {
    /** The drawer's field commits on blur, like a loose doc property. */
    onCommit?: (value: string) => void;
    /** The field takes Escape itself, like the record's property editor. */
    claimsEscape?: boolean;
  }) {
    const [open, setOpen] = useState(false);
    const drawerRef = useDrawerFocus<HTMLDivElement>(open);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Show panel
        </button>
        <input aria-label="Outside" />
        {open && (
          <>
            <DrawerScrim
              onDismiss={() => setOpen(false)}
              label="Close the panel"
              testId="scrim"
              className="absolute inset-0"
            />
            <div ref={drawerRef} tabIndex={-1} data-testid="drawer" data-overlay="true">
              <input
                aria-label="Field"
                onBlur={(e) => onCommit(e.target.value)}
                onKeyDown={(e) => {
                  if (claimsEscape && e.key === 'Escape') e.stopPropagation();
                }}
              />
            </div>
          </>
        )}
      </>
    );
  }

  it('takes focus into the drawer as it opens, off the toggle and its tooltip', () => {
    render(<Harness />);
    const toggle = screen.getByRole('button', { name: 'Show panel' });
    toggle.focus();
    fireEvent.click(toggle);
    expect(document.activeElement).toBe(screen.getByTestId('drawer'));
  });

  it('hands focus back to the toggle after Escape', () => {
    render(<Harness />);
    const toggle = screen.getByRole('button', { name: 'Show panel' });
    toggle.focus();
    fireEvent.click(toggle);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('drawer')).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  function RetainedDrawer({ moveFocus = false }: { moveFocus?: boolean }) {
    const [open, setOpen] = useState(false);
    const drawer = useDrawerFocus<HTMLDivElement>(open);
    const outside = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open navigation</button>
        <button ref={outside}>Another action</button>
        {open && (
          <DrawerScrim
            label="Close navigation"
            className="absolute inset-0"
            onDismiss={() => {
              setOpen(false);
              if (moveFocus) outside.current?.focus();
            }}
          />
        )}
        <div
          ref={drawer}
          tabIndex={-1}
          data-testid="retained-drawer"
          data-overlay={open || undefined}
          style={{ display: open ? 'block' : 'none' }}
        />
      </>
    );
  }

  it('restores Escape focus when a retained drawer becomes hidden without losing focus', () => {
    render(<RetainedDrawer />);
    const opener = screen.getByRole('button', { name: 'Open navigation' });
    opener.focus();
    fireEvent.click(opener);
    const drawer = screen.getByTestId('retained-drawer');
    expect(document.activeElement).toBe(drawer);
    fireEvent.keyDown(drawer, { key: 'Escape' });
    expect(drawer.style.display).toBe('none');
    expect(document.activeElement).toBe(opener);
  });

  it('does not reclaim a newer focus when a retained drawer hides', () => {
    render(<RetainedDrawer moveFocus />);
    const opener = screen.getByRole('button', { name: 'Open navigation' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByTestId('retained-drawer'), { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Another action' }));
  });

  it('leaves focus alone after a press — the pointer went somewhere on purpose', () => {
    render(<Harness />);
    const toggle = screen.getByRole('button', { name: 'Show panel' });
    toggle.focus();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('scrim'));
    expect(screen.queryByTestId('drawer')).toBeNull();
    expect(document.activeElement).not.toBe(toggle);
  });

  /**
   * Escape in a field typed into a drawer closed the drawer and took the
   * draft with it; docked, the same keystroke left the value where it was.
   */
  it('lets a field in the drawer have Escape: blurred, so it commits, and the drawer stays', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show panel' }));
    const field = screen.getByRole('textbox', { name: 'Field' });
    field.focus();
    fireEvent.change(field, { target: { value: 'typed' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(onCommit).toHaveBeenCalledWith('typed');
    expect(screen.getByTestId('drawer')).toBe(document.activeElement);
    // The next Escape is the drawer's.
    fireEvent.keyDown(document.activeElement ?? window, { key: 'Escape' });
    expect(screen.queryByTestId('drawer')).toBeNull();
  });

  it('stands down for a field that takes Escape itself', () => {
    render(<Harness claimsEscape />);
    fireEvent.click(screen.getByRole('button', { name: 'Show panel' }));
    const field = screen.getByRole('textbox', { name: 'Field' });
    field.focus();
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.getByTestId('drawer')).toBeTruthy();
    expect(document.activeElement).toBe(field);
  });

  it('still closes on Escape from a field outside the drawer', () => {
    // The assistant's composer, beside a page's drawer: nothing of the
    // drawer's is in hand, so the drawer is what Escape is aimed at.
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Show panel' }));
    const outside = screen.getByRole('textbox', { name: 'Outside' });
    outside.focus();
    fireEvent.keyDown(outside, { key: 'Escape' });
    expect(screen.queryByTestId('drawer')).toBeNull();
  });
});
