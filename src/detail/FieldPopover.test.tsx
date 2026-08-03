// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FieldPopover, FixedBelowAnchor } from '@/detail/FieldPopover';
import { hasLayers, pushLayer, resetLayers } from '@/components/ui/layers';

afterEach(cleanup);

const OPTIONS = [
  { id: 'todo', label: 'Todo', color: null },
  { id: 'doing', label: 'Doing', color: null },
];

describe('FieldPopover', () => {
  // The multi-value footer promises "Esc or click away to close" and the
  // component had no keydown handler at all — Escape fell through to the
  // record panel's window listener and destroyed the record instead.
  it('closes itself on Escape', () => {
    const onClose = vi.fn();
    render(<FieldPopover options={OPTIONS} activeIds={[]} onPick={() => {}} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // …and it must swallow the keystroke so nothing behind it also acts.
  it('stops Escape from reaching listeners behind it', () => {
    const behind = vi.fn();
    window.addEventListener('keydown', behind);
    try {
      render(
        <FieldPopover options={OPTIONS} activeIds={[]} onPick={() => {}} onClose={() => {}} />,
      );
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(behind).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', behind);
    }
  });

  it('leaves other keys alone', () => {
    const behind = vi.fn();
    window.addEventListener('keydown', behind);
    try {
      render(
        <FieldPopover options={OPTIONS} activeIds={[]} onPick={() => {}} onClose={() => {}} />,
      );
      fireEvent.keyDown(window, { key: 'a' });
      expect(behind).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', behind);
    }
  });

  it('keeps the dismiss scrim out of the tab order', () => {
    render(<FieldPopover options={OPTIONS} activeIds={[]} onPick={() => {}} onClose={() => {}} />);
    expect(screen.getByLabelText('Close popover').getAttribute('tabindex')).toBe('-1');
  });

  // A freshly declared Select has no options; "No matches" told the user
  // nothing about where options come from.
  it('explains an empty option set instead of saying "No matches"', () => {
    render(
      <FieldPopover
        options={[]}
        activeId={null}
        emptyHint="No options yet — add them on the type screen."
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('No options yet — add them on the type screen.')).toBeTruthy();
  });

  it('offers to create a label that matches no option', () => {
    const onCreate = vi.fn();
    render(
      <FieldPopover
        searchable
        options={OPTIONS}
        activeId={null}
        onCreate={onCreate}
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'Blocked' } });
    fireEvent.click(screen.getByText('Blocked').closest('button')!);
    expect(onCreate).toHaveBeenCalledWith('Blocked');
  });
});

/**
 * The positioner six popovers still mount through, and the stack could not
 * see any of them (M16.29).
 *
 * `Popover` (M16.1) registers a layer; this pre-M16.1 wrapper registered
 * nothing, and the View settings panel, the view-tab menus, the chain builder
 * and the sync badge all still render through it. So `hasLayers()` answered
 * false with one of them open on screen, and the record panel's Escape
 * handler — which asked exactly that question — closed the record instead,
 * leaving the popover over an empty canvas.
 *
 * Registration is the fix; taking the keystroke is the caller's choice,
 * because each of these surfaces already owns its own click-away scrim with
 * its own commit semantics and `useDismiss` would rewrite that too.
 */
describe('FixedBelowAnchor', () => {
  beforeEach(() => resetLayers());

  it('registers as a layer for as long as it is mounted', () => {
    const { unmount } = render(
      <FixedBelowAnchor>
        <div>panel</div>
      </FixedBelowAnchor>,
    );
    expect(hasLayers()).toBe(true);
    unmount();
    expect(hasLayers()).toBe(false);
  });

  it('takes Escape when the caller gives it something to close', () => {
    const onClose = vi.fn();
    render(
      <FixedBelowAnchor onClose={onClose}>
        <div>panel</div>
      </FixedBelowAnchor>,
    );
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stands down for whatever opened on top of it', () => {
    const onClose = vi.fn();
    render(
      <FixedBelowAnchor onClose={onClose}>
        <div>panel</div>
      </FixedBelowAnchor>,
    );
    pushLayer('a-dialog-opened-from-inside');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('leaves the keystroke alone when it has no onClose to run', () => {
    const behind = vi.fn();
    document.addEventListener('keydown', behind);
    try {
      render(
        <FixedBelowAnchor>
          <div>panel</div>
        </FixedBelowAnchor>,
      );
      fireEvent.keyDown(document.body, { key: 'Escape' });
      // FieldEditor pairs this wrapper with a sibling `EscapeToClose`; a
      // swallowed keystroke would leave that surface with no Escape at all.
      expect(behind).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', behind);
    }
  });
});
