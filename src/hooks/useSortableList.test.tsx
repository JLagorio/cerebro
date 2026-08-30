import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ownsEscape, pushLayer, resetLayers } from '@/components/ui/layers';
import { LIST_DRAGGING_CLASS, useSortableList } from '@/hooks/useSortableList';

afterEach(cleanup);
// The layer stack is module state, and a gesture pushes onto it — a case that
// left one behind would silently change who owns Escape in every later case.
afterEach(resetLayers);
// The body class is document state for the same reason.
afterEach(() => document.body.classList.remove(LIST_DRAGGING_CLASS));

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
      style={s.containerStyle}
    >
      {ids.map((id, i) => (
        <div key={id} data-testid={`row-${id}`} style={s.rowStyle(i)}>
          <span {...s.gripProps(id, i)} data-testid={`grip-${id}`} />
          {id}
        </div>
      ))}
    </div>
  );
}

const order = () =>
  Array.from(screen.getByTestId('list').children).map((el) => el.getAttribute('data-testid'));

/**
 * jsdom has no layout: every rect is zero and nothing this hook measures
 * exists. The rows are given a 3 × 20px column and the container the 60px it
 * adds up to, so the geometry has real numbers to work on — the maths itself
 * is tested for real in `sortableGeometry.test.ts`.
 */
const stubRows = (axis: 'y' | 'x' = 'y') => {
  const list = screen.getByTestId('list');
  list.getBoundingClientRect = () =>
    (axis === 'y'
      ? { top: 0, left: 0, width: 100, height: 60 }
      : { top: 0, left: 0, width: 60, height: 100 }) as DOMRect;
  Array.from(list.children).forEach((row, i) => {
    row.getBoundingClientRect = () =>
      (axis === 'y'
        ? { top: i * 20, left: 0, width: 100, height: 20 }
        : { top: 0, left: i * 20, width: 20, height: 100 }) as DOMRect;
  });
};

/**
 * A press with coordinates. `fireEvent.pointerDown` cannot carry any — jsdom
 * implements no PointerEvent — and a drag that tracks the cursor 1:1 has to
 * know where the cursor started.
 */
const press = (id: string, at: number, axis: 'y' | 'x' = 'y') =>
  fireEvent(
    screen.getByTestId(`grip-${id}`),
    new MouseEvent('pointerdown', {
      button: 0,
      bubbles: true,
      cancelable: true,
      ...(axis === 'y' ? { clientY: at } : { clientX: at }),
    }),
  );

const moveTo = (at: number, axis: 'y' | 'x' = 'y') =>
  act(() => {
    window.dispatchEvent(
      new MouseEvent('pointermove', axis === 'y' ? { clientY: at } : { clientX: at }),
    );
  });

const releaseAt = (at: number, axis: 'y' | 'x' = 'y') =>
  act(() => {
    window.dispatchEvent(
      new MouseEvent('pointerup', axis === 'y' ? { clientY: at } : { clientX: at }),
    );
  });

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

/**
 * The commit, under the C-I rule (M46.2 Task 2).
 *
 * The threshold is no longer where the POINTER is — it is where the dragged
 * row's own midpoint is, because the row now moves with the cursor. The two
 * agree only when the row is grabbed dead centre, so these cases say what they
 * grabbed and how far they carried it.
 */
describe('useSortableList pointer', () => {
  it('commits the slot the dragged row landed in', () => {
    const onReorder = vi.fn();
    render(<List onReorder={onReorder} />);
    stubRows();

    // Grabbed at its middle and carried 15px down: the row now spans 15–35 and
    // its midpoint, 25, is past row b's leading edge at 20.
    press('a', 10);
    moveTo(25);
    releaseAt(25);

    expect(onReorder).toHaveBeenCalledWith('a', 1);
    expect(order()).toEqual(['row-b', 'row-a', 'row-c']);
  });

  it('does not fire when the drop lands back where it started', () => {
    const onReorder = vi.fn();
    render(<List onReorder={onReorder} />);
    stubRows();

    press('a', 10);
    moveTo(12);
    releaseAt(12);

    expect(onReorder).not.toHaveBeenCalled();
  });

  it('does not fire for a press that never moved', () => {
    const onReorder = vi.fn();
    render(<List onReorder={onReorder} />);
    stubRows();

    press('a', 10);
    releaseAt(10);

    expect(onReorder).not.toHaveBeenCalled();
    expect(document.body.classList.contains(LIST_DRAGGING_CLASS)).toBe(false);
  });

  it('carries a row up the list too', () => {
    const onReorder = vi.fn();
    render(<List onReorder={onReorder} />);
    stubRows();

    press('c', 50);
    moveTo(5);
    releaseAt(5);

    expect(onReorder).toHaveBeenCalledWith('c', 0);
    expect(order()).toEqual(['row-c', 'row-a', 'row-b']);
  });

  it('reorders a horizontal list along its own axis', () => {
    const onReorder = vi.fn();
    render(<List axis="x" onReorder={onReorder} />);
    stubRows('x');

    press('a', 10, 'x');
    moveTo(25, 'x');
    releaseAt(25, 'x');

    expect(onReorder).toHaveBeenCalledWith('a', 1);
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
 * The C-I lifecycle — GUARDS, not proof (M46.2 Task 2).
 *
 * jsdom has no layout engine: it never computes a transform, never animates a
 * transition, and every rect it reports is zero until `stubRows` feeds it one.
 * So these cases can only check that the right declarations reach the right
 * elements at the right moments — that the list freezes on the first move and
 * not on the press, that the held row is the one without a transition, that a
 * drop strips everything. Whether it LOOKS like Notion is a browser
 * measurement, and the slice's re-measurement pass owns it.
 */
describe('useSortableList C-I lifecycle (guard)', () => {
  const list = () => screen.getByTestId('list');
  const row = (id: string) => screen.getByTestId(`row-${id}`);

  it('changes nothing on the press', () => {
    render(<List />);
    stubRows();

    press('a', 10);

    expect(list().style.position).toBe('');
    expect(row('a').style.position).toBe('');
    expect(row('a').style.transform).toBe('');
    expect(document.body.classList.contains(LIST_DRAGGING_CLASS)).toBe(false);
  });

  it('freezes the list and takes its rows out of flow on the first move', () => {
    render(<List />);
    stubRows();

    press('a', 10);
    moveTo(15);

    expect(list().style.position).toBe('relative');
    // The height its rows have just vacated: 3 × 20px.
    expect(list().style.height).toBe('60px');
    expect(row('a').style.position).toBe('absolute');
    expect(row('b').style.position).toBe('absolute');
    expect(document.body.classList.contains(LIST_DRAGGING_CLASS)).toBe(true);
  });

  it('puts the held row under the cursor, 1:1 and untransitioned', () => {
    render(<List />);
    stubRows();

    press('a', 10);
    moveTo(15);

    // 5px of pointer travel, 5px of row travel.
    expect(row('a').style.transform).toBe('translate(0px, 5px)');
    expect(row('a').style.transition).toBe('none');
    expect(row('a').style.zIndex).toBe('1');
  });

  it('lifts the held row by z-index alone — no dim, no shadow, no scale', () => {
    // What this replaced: the source dimmed to 40% in place and a 2px inset
    // line was painted on the row below it. Both were the block grammar, on
    // the family Notion reflows.
    render(<List />);
    stubRows();

    press('a', 10);
    moveTo(25);

    expect(row('a').style.opacity).toBe('');
    expect(row('a').style.boxShadow).toBe('');
    expect(row('a').style.transform).not.toContain('scale');
    expect(row('a').style.transform).not.toContain('rotate');
    expect(row('a').style.backgroundColor).toBe('');
    // And no row anywhere is wearing an insertion line.
    expect(row('b').style.boxShadow).toBe('');
    expect(row('c').style.boxShadow).toBe('');
  });

  it('slides the neighbour out of the way over 200ms', () => {
    render(<List />);
    stubRows();

    press('a', 10);
    moveTo(25);

    // b takes slot 0 — the gap that opens IS the drop indicator.
    expect(row('b').style.transform).toBe('translate(0px, 0px)');
    expect(row('b').style.transition).toBe('transform 200ms ease');
    // c has not been passed, so it stays in its own slot.
    expect(row('c').style.transform).toBe('translate(0px, 40px)');
  });

  it('clamps the held row to the list, however far the pointer goes', () => {
    render(<List />);
    stubRows();

    press('a', 10);
    moveTo(4000);

    // 60px of list, 20px of row: the furthest its leading edge can go is 40.
    expect(row('a').style.transform).toBe('translate(0px, 40px)');

    moveTo(-4000);
    expect(row('a').style.transform).toBe('translate(0px, 0px)');
  });

  it('runs along the cross axis on a horizontal list', () => {
    render(<List axis="x" />);
    stubRows('x');

    press('a', 10, 'x');
    moveTo(15, 'x');

    expect(row('a').style.transform).toBe('translate(5px, 0px)');
    expect(list().style.width).toBe('60px');
  });

  it('strips every inline position on the drop', () => {
    render(<List />);
    stubRows();

    press('a', 10);
    moveTo(25);
    releaseAt(25);

    expect(list().style.position).toBe('');
    expect(list().style.height).toBe('');
    expect(row('a').style.position).toBe('');
    expect(row('a').style.transform).toBe('');
    expect(document.body.classList.contains(LIST_DRAGGING_CLASS)).toBe(false);
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

  const escape = (on: HTMLElement) => fireEvent.keyDown(on, { key: 'Escape' });

  it('cancels the drag, so the release commits nothing and the order stands', () => {
    const onReorder = vi.fn();
    render(<List onReorder={onReorder} />);
    stubRows();

    press('a', 10);
    moveTo(25);
    escape(screen.getByTestId('grip-a'));
    releaseAt(25);

    // Without the cancel this drop commits ('a', 1) — the measured defect.
    expect(onReorder).not.toHaveBeenCalled();
    expect(order()).toEqual(['row-a', 'row-b', 'row-c']);
  });

  it('strips the drag state: no dragged id, no frozen list, no moved rows', () => {
    render(<List />);
    stubRows();

    press('a', 10);
    moveTo(25);
    expect(screen.getByTestId('list').getAttribute('data-dragging')).toBe('a');
    expect(screen.getByTestId('row-a').style.transform).not.toBe('');

    escape(screen.getByTestId('grip-a'));

    expect(screen.getByTestId('list').getAttribute('data-dragging')).toBe('');
    expect(screen.getByTestId('list').style.position).toBe('');
    expect(screen.getByTestId('row-a').style.transform).toBe('');
    expect(document.body.classList.contains(LIST_DRAGGING_CLASS)).toBe(false);
  });

  it('stops tracking the pointer, so a later move paints nothing', () => {
    render(<List />);
    stubRows();

    press('a', 10);
    moveTo(25);
    escape(screen.getByTestId('grip-a'));
    moveTo(5);

    expect(screen.getByTestId('list').getAttribute('data-dragging')).toBe('');
  });

  it('leaves a later drag able to commit', () => {
    const onReorder = vi.fn();
    render(<List onReorder={onReorder} />);
    stubRows();

    // Cancel a move of `a`…
    press('a', 10);
    moveTo(25);
    escape(screen.getByTestId('grip-a'));
    releaseAt(25);

    // …then move a DIFFERENT row, so the assertion can tell the two worlds
    // apart. Cancelling `a` and then re-dragging `a` the same way lands on the
    // very order an uncancelled first drag would have produced — the fixture
    // was green before the fix until this second gesture was changed.
    stubRows();
    press('c', 50);
    moveTo(5);
    releaseAt(5);

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
      press('a', 10);
      moveTo(25);
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

    press('a', 10);
    moveTo(25);
    expect(ownsEscape('panel')).toBe(false);

    escape(screen.getByTestId('grip-a'));
    expect(ownsEscape('panel')).toBe(true);
  });

  it('hands the layer back on a normal release too', () => {
    render(<List />);
    stubRows();
    pushLayer('panel');

    press('a', 10);
    moveTo(25);
    releaseAt(25);

    expect(ownsEscape('panel')).toBe(true);
  });

  it('hands the layer back — and the body class — when the list unmounts mid-drag', () => {
    const { unmount } = render(<List />);
    stubRows();
    pushLayer('panel');

    press('a', 10);
    moveTo(25);
    unmount();

    // A leaked gesture layer sits on top of the stack forever, and every later
    // Escape in the app finds it there instead of the surface it was aimed at.
    // A leaked body class is the same bug on the document.
    expect(ownsEscape('panel')).toBe(true);
    expect(document.body.classList.contains(LIST_DRAGGING_CLASS)).toBe(false);
  });
});
