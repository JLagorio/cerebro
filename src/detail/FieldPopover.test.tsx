// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
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
 * The app's universal option picker had no keyboard route at all (M16.35):
 * every status, select, person and relation value could only be set by mouse.
 */
describe('FieldPopover keyboard', () => {
  const open = (props: Partial<ComponentProps<typeof FieldPopover>> = {}) => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      <FieldPopover
        options={OPTIONS}
        activeId={null}
        {...props}
        onPick={onPick}
        onClose={onClose}
      />,
    );
    return { onPick, onClose, list: screen.getByRole('listbox') };
  };

  it('takes focus when there is no search box to hold it', () => {
    const { list } = open();
    // Otherwise no keystroke ever reaches the handler: focus sits on the
    // trigger, outside this subtree.
    expect(document.activeElement).toBe(list);
  });

  it('arrows down the list and Enter picks the highlighted option', () => {
    const { onPick, onClose, list } = open();
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('doing');
    // Single-value fields commit and close, exactly as a click does.
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('starts on the first row, so Enter alone picks it', () => {
    const { onPick, list } = open();
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('todo');
  });

  it('clamps at both ends and Home/End jump', () => {
    const { onPick, list } = open();
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    fireEvent.keyDown(list, { key: 'End' });
    fireEvent.keyDown(list, { key: 'ArrowDown' }); // already last — stays
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('doing');

    fireEvent.keyDown(list, { key: 'Home' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith('todo');
  });

  it('names the highlighted row with aria-activedescendant', () => {
    const { list } = open();
    const todo = screen.getByRole('option', { name: 'Todo' });
    const doing = screen.getByRole('option', { name: 'Doing' });
    expect(list.getAttribute('aria-activedescendant')).toBe(todo.id);
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(list.getAttribute('aria-activedescendant')).toBe(doing.id);
  });

  it('keeps a multi-value popover open so several values land in one visit', () => {
    const { onPick, onClose, list } = open({ activeIds: [], activeId: undefined });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('todo');
    expect(onClose).not.toHaveBeenCalled();
  });

  // The Create row is the last stop on the same route as the options, which is
  // how it reads on screen — arrowing past the final match lands on it.
  it('falls through to the Create row past the last match', () => {
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
    const list = screen.getByRole('listbox');
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'Do' } });
    // One match ("Doing") plus the create row: End lands on Create.
    fireEvent.keyDown(list, { key: 'End' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onCreate).toHaveBeenCalledWith('Do');
  });

  // Filtering shrinks the list under the cursor; a stale index would arm Enter
  // on whichever row inherited it.
  it('re-homes the highlight when the filter changes', () => {
    const onPick = vi.fn();
    render(
      <FieldPopover
        searchable
        options={OPTIONS}
        activeId={null}
        onPick={onPick}
        onClose={() => {}}
      />,
    );
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'End' });
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'Todo' } });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('todo');
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

  /**
   * Six popovers mount through here and every one of them used to leave focus
   * on `<body>` when it closed, so the next Tab restarted from the top of the
   * document (M16.35).
   */
  it('hands focus back to whatever opened it', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    try {
      const { unmount } = render(
        <FixedBelowAnchor>
          <input aria-label="Inside" autoFocus />
        </FixedBelowAnchor>,
      );
      // The surface takes focus for itself first — the case that defeats a
      // hook reading `document.activeElement` from an effect.
      expect(document.activeElement).toBe(screen.getByLabelText('Inside'));
      unmount();
      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
    }
  });

  it('returns focus when a whole FieldPopover closes', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    try {
      const { unmount } = render(
        <FieldPopover options={OPTIONS} activeId={null} onPick={() => {}} onClose={() => {}} />,
      );
      expect(document.activeElement).toBe(screen.getByRole('listbox'));
      unmount();
      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
    }
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
