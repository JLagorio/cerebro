import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ownsEscape, pushLayer, resetLayers } from '@/components/ui/layers';
import { useSortableList } from '@/hooks/useSortableList';

afterEach(cleanup);
// The layer stack is module state, and a gesture pushes onto it — a case that
// left one behind would silently change who owns Escape in every later case.
afterEach(resetLayers);

/**
 * The keyboard path is the point (M16.2). Of the three drag systems this
 * replaces, only ResizeHandle could be driven without a pointer.
 */

function List({
  axis = 'y',
  disabled,
  onReorder,
  initial = ['a', 'b', 'c'],
}: {
  axis?: 'y' | 'x';
  disabled?: boolean;
  onReorder?: (id: string, to: number) => void;
  initial?: string[];
}) {
  const [ids, setIds] = useState(initial);
  const reorder = (id: string, to: number) => {
    onReorder?.(id, to);
    setIds((cur) => {
      const next = cur.filter((x) => x !== id);
      next.splice(to, 0, id);
      return next;
    });
  };
  const s = useSortableList({ ids, onReorder: reorder, axis, disabled });
  return (
    <div
      ref={s.containerRef as React.RefObject<HTMLDivElement>}
      data-testid="list"
      data-dragging={s.dragging ?? ''}
    >
      {ids.map((id, i) => (
        <div key={id} data-testid={`row-${id}`} style={s.dropIndicator(i)}>
          <span {...s.gripProps(id, i)} data-testid={`grip-${id}`} />
          {id}
        </div>
      ))}
    </div>
  );
}

const order = () =>
  Array.from(screen.getByTestId('list').children).map((el) => el.getAttribute('data-testid'));

describe('useSortableList keyboard', () => {
  it('moves an item down one slot per ArrowDown', async () => {
    const user = userEvent.setup();
    render(<List />);
    screen.getByTestId('grip-a').focus();

    await user.keyboard('{ArrowDown}');
    expect(order()).toEqual(['row-b', 'row-a', 'row-c']);
  });

  it('moves an item up one slot per ArrowUp', async () => {
    const user = userEvent.setup();
    render(<List />);
    screen.getByTestId('grip-c').focus();

    await user.keyboard('{ArrowUp}');
    expect(order()).toEqual(['row-a', 'row-c', 'row-b']);
  });

  it('keeps focus on the grip so a second press keeps moving', async () => {
    const user = userEvent.setup();
    render(<List />);
    screen.getByTestId('grip-a').focus();

    await user.keyboard('{ArrowDown}');
    // Focus rides the row to its new index; without that it lands on <body>
    // and the list can only be reordered one step per tab-back.
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('grip-a')));
    await user.keyboard('{ArrowDown}');
    expect(order()).toEqual(['row-b', 'row-c', 'row-a']);
  });

  it('refuses to move the first item up or the last item down', async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    render(<List onReorder={onReorder} />);

    screen.getByTestId('grip-a').focus();
    await user.keyboard('{ArrowUp}');
    screen.getByTestId('grip-c').focus();
    await user.keyboard('{ArrowDown}');

    expect(onReorder).not.toHaveBeenCalled();
    expect(order()).toEqual(['row-a', 'row-b', 'row-c']);
  });

  it('uses left and right on a horizontal list', async () => {
    const user = userEvent.setup();
    render(<List axis="x" />);
    screen.getByTestId('grip-a').focus();

    await user.keyboard('{ArrowDown}');
    expect(order()).toEqual(['row-a', 'row-b', 'row-c']);

    await user.keyboard('{ArrowRight}');
    expect(order()).toEqual(['row-b', 'row-a', 'row-c']);
  });

  it('does nothing while disabled', async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    render(<List disabled onReorder={onReorder} />);
    screen.getByTestId('grip-a').focus();

    await user.keyboard('{ArrowDown}');
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('names the grip with its position so a screen reader can follow', () => {
    render(<List />);
    expect(screen.getByTestId('grip-b').getAttribute('aria-label')).toBe(
      'Reorder b, position 2 of 3',
    );
  });

  it('is reachable by Tab', async () => {
    const user = userEvent.setup();
    render(<List />);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId('grip-a'));
  });
});

describe('useSortableList pointer', () => {
  it('commits a drop past a later row', () => {
    const onReorder = vi.fn();
    render(<List onReorder={onReorder} />);
    const rows = Array.from(screen.getByTestId('list').children) as HTMLElement[];
    // jsdom has no layout, so give the rows heights to measure against.
    rows.forEach((r, i) => {
      r.getBoundingClientRect = () => ({ top: i * 20, height: 20, left: 0, width: 100 }) as DOMRect;
    });

    fireEvent.pointerDown(screen.getByTestId('grip-a'), { button: 0 });
    // The drag listeners are native window handlers, and jsdom implements no
    // PointerEvent — testing-library's synthetic one carries no coordinates.
    // MouseEvent does, and the handler only ever reads clientX/clientY.
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 45 }));
      window.dispatchEvent(new MouseEvent('pointerup', { clientY: 45 }));
    });

    // Past the midpoints of rows 0 and 1 → slot 2; dragging from 0 means the
    // target index is one less, because the row itself leaves the list.
    expect(onReorder).toHaveBeenCalledWith('a', 1);
  });

  it('does not fire when the drop lands back where it started', () => {
    const onReorder = vi.fn();
    render(<List onReorder={onReorder} />);
    const rows = Array.from(screen.getByTestId('list').children) as HTMLElement[];
    rows.forEach((r, i) => {
      r.getBoundingClientRect = () => ({ top: i * 20, height: 20, left: 0, width: 100 }) as DOMRect;
    });

    fireEvent.pointerDown(screen.getByTestId('grip-a'), { button: 0 });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 5 }));
      window.dispatchEvent(new MouseEvent('pointerup', { clientY: 5 }));
    });

    expect(onReorder).not.toHaveBeenCalled();
  });

  it('ignores a non-primary button', () => {
    const onReorder = vi.fn();
    render(<List onReorder={onReorder} />);
    // A real MouseEvent, because React reads `button` as null off the
    // synthetic one jsdom produces — so `{ button: 2 }` would never arrive
    // and this would pass for the wrong reason.
    screen
      .getByTestId('grip-a')
      .dispatchEvent(new MouseEvent('pointerdown', { button: 2, bubbles: true }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientY: 100 }));
    expect(onReorder).not.toHaveBeenCalled();
  });
});

/**
 * Escape cancels the gesture (M46.2 Task 1).
 *
 * Measured against the running app before this existed: on the view tab strip
 * a real `Escape` mid-drag left the gesture tracking the pointer and the
 * RELEASE COMMITTED the reorder; on the record panel the same keystroke closed
 * the panel and left the drag live. Both halves are asserted here — the drag
 * must cancel, and the keystroke must not reach anything behind it.
 */
describe('useSortableList Escape', () => {
  beforeEach(() => resetLayers());

  /** jsdom has no layout; the slot maths needs measurable rows. */
  const stubRows = () => {
    const rows = Array.from(screen.getByTestId('list').children) as HTMLElement[];
    rows.forEach((r, i) => {
      r.getBoundingClientRect = () => ({ top: i * 20, height: 20, left: 0, width: 100 }) as DOMRect;
    });
  };

  const escape = (on: HTMLElement) => fireEvent.keyDown(on, { key: 'Escape' });

  it('cancels the drag, so the release commits nothing and the order stands', () => {
    const onReorder = vi.fn();
    render(<List onReorder={onReorder} />);
    stubRows();

    fireEvent.pointerDown(screen.getByTestId('grip-a'), { button: 0 });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 45 }));
    });
    escape(screen.getByTestId('grip-a'));
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', { clientY: 45 }));
    });

    // Without the cancel this drop commits ('a', 1) — the measured defect.
    expect(onReorder).not.toHaveBeenCalled();
    expect(order()).toEqual(['row-a', 'row-b', 'row-c']);
  });

  it('strips the drag state: no dragged id, no drop indicator', () => {
    render(<List />);
    stubRows();

    fireEvent.pointerDown(screen.getByTestId('grip-a'), { button: 0 });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 45 }));
    });
    expect(screen.getByTestId('list').getAttribute('data-dragging')).toBe('a');
    expect(screen.getByTestId('row-c').style.boxShadow).not.toBe('');

    escape(screen.getByTestId('grip-a'));

    expect(screen.getByTestId('list').getAttribute('data-dragging')).toBe('');
    expect(screen.getByTestId('row-c').style.boxShadow).toBe('');
  });

  it('stops tracking the pointer, so a later move paints nothing', () => {
    render(<List />);
    stubRows();

    fireEvent.pointerDown(screen.getByTestId('grip-a'), { button: 0 });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 45 }));
    });
    escape(screen.getByTestId('grip-a'));
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 5 }));
    });

    expect(screen.getByTestId('list').getAttribute('data-dragging')).toBe('');
  });

  it('leaves a later drag able to commit', () => {
    const onReorder = vi.fn();
    render(<List onReorder={onReorder} />);
    stubRows();

    // Cancel a move of `a`…
    fireEvent.pointerDown(screen.getByTestId('grip-a'), { button: 0 });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 45 }));
    });
    escape(screen.getByTestId('grip-a'));
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', { clientY: 45 }));
    });

    // …then move a DIFFERENT row, so the assertion can tell the two worlds
    // apart. Cancelling `a` and then re-dragging `a` the same way lands on the
    // very order an uncancelled first drag would have produced — the fixture
    // was green before the fix until this second gesture was changed.
    stubRows();
    fireEvent.pointerDown(screen.getByTestId('grip-c'), { button: 0 });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 5 }));
      window.dispatchEvent(new MouseEvent('pointerup', { clientY: 5 }));
    });

    // Exactly once: the cancelled gesture must have committed nothing, and the
    // fresh one must not have inherited a second set of live listeners.
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith('c', 0);
    expect(order()).toEqual(['row-c', 'row-a', 'row-b']);
  });

  it('keeps the keystroke away from an ancestor while a drag is live', () => {
    const ancestor = vi.fn();
    const onWindow = vi.fn();
    render(
      <div onKeyDown={ancestor} data-testid="ancestor">
        <List />
      </div>,
    );
    stubRows();
    window.addEventListener('keydown', onWindow);

    try {
      fireEvent.pointerDown(screen.getByTestId('grip-a'), { button: 0 });
      act(() => {
        window.dispatchEvent(new MouseEvent('pointermove', { clientY: 45 }));
      });
      escape(screen.getByTestId('grip-a'));

      // The measured leak: one Escape cancelled nothing AND closed the panel.
      expect(ancestor).not.toHaveBeenCalled();
      expect(onWindow).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onWindow);
    }
  });

  it('lets Escape through when no drag is live', () => {
    const ancestor = vi.fn();
    render(
      <div onKeyDown={ancestor} data-testid="ancestor">
        <List />
      </div>,
    );

    escape(screen.getByTestId('grip-a'));

    expect(ancestor).toHaveBeenCalledTimes(1);
  });

  it('takes Escape off the surface underneath for the length of the gesture', () => {
    render(<List />);
    stubRows();
    // What DetailPanel and Dialog both register. Their handlers ask the stack
    // who owns the keystroke, so a live drag has to outrank them there.
    pushLayer('panel');
    expect(ownsEscape('panel')).toBe(true);

    fireEvent.pointerDown(screen.getByTestId('grip-a'), { button: 0 });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 45 }));
    });
    expect(ownsEscape('panel')).toBe(false);

    escape(screen.getByTestId('grip-a'));
    expect(ownsEscape('panel')).toBe(true);
  });

  it('hands the layer back on a normal release too', () => {
    render(<List />);
    stubRows();
    pushLayer('panel');

    fireEvent.pointerDown(screen.getByTestId('grip-a'), { button: 0 });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 45 }));
      window.dispatchEvent(new MouseEvent('pointerup', { clientY: 45 }));
    });

    expect(ownsEscape('panel')).toBe(true);
  });

  it('hands the layer back when the list unmounts mid-drag', () => {
    const { unmount } = render(<List />);
    stubRows();
    pushLayer('panel');

    fireEvent.pointerDown(screen.getByTestId('grip-a'), { button: 0 });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 45 }));
    });
    unmount();

    // A leaked gesture layer sits on top of the stack forever, and every later
    // Escape in the app finds it there instead of the surface it was aimed at.
    expect(ownsEscape('panel')).toBe(true);
  });
});
