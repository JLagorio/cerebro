// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ColumnGutter } from './ColumnGutter';

/**
 * The gutter handle's wiring (M48.5).
 *
 * The arithmetic is `resizeColumnPair` and is tested where it lives. What is
 * tested here is everything between a pointer and that arithmetic: reading the
 * pair out of the DOM, computing from where the drag STARTED rather than
 * accumulating, and putting the ratios back when the drag is abandoned.
 *
 * `pointerdown` is dispatched as a NATIVE event because that is how the
 * component listens — MEASURED in a browser, React's `onPointerDown` never
 * fires inside a custom block, because ProseMirror stops the event before it
 * reaches the React root.
 */

const rect = (left: number, width: number): DOMRect =>
  ({
    left,
    right: left + width,
    width,
    top: 0,
    bottom: 100,
    height: 100,
    x: left,
    y: 0,
    toJSON: () => '',
  }) as DOMRect;

/**
 * Two column outers side by side, the handle living in the second — the shape
 * BlockNote renders and `pair()` walks.
 */
function twoColumns(
  leftWidth: number | null,
  rightWidth: number | null,
  leftPx = 200,
  rightPx = 400,
) {
  const group = document.createElement('div');
  const outer = (declared: number | null, px: number, offset: number) => {
    const node = document.createElement('div');
    node.setAttribute('data-node-type', 'blockOuter');
    const content = document.createElement('div');
    content.setAttribute('data-content-type', 'column');
    if (declared !== null) content.setAttribute('data-width', String(declared));
    node.appendChild(content);
    vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(rect(offset, px));
    return { node, content };
  };
  const first = outer(leftWidth, leftPx, 0);
  const second = outer(rightWidth, rightPx, leftPx);
  group.append(first.node, second.node);
  document.body.appendChild(group);
  return second.content;
}

/* jsdom has no `PointerEvent`. A `MouseEvent` dispatched under the pointer
   type reaches the same listeners with the same `clientX` and `button`, which
   is everything this component reads off it. */
const pointer = (type: string, init: MouseEventInit) => new MouseEvent(type, init);

const press = (at: number, button = 0) =>
  screen
    .getByTestId('column-gutter')
    .dispatchEvent(pointer('pointerdown', { bubbles: true, button, clientX: at }));

const moveTo = (at: number) =>
  window.dispatchEvent(pointer('pointermove', { bubbles: true, clientX: at }));

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('the gutter handle', () => {
  it('is a separator, so it is announced and reachable', () => {
    const host = twoColumns(1, 2);
    render(<ColumnGutter id="c2" onResize={vi.fn()} />, { container: host });
    const handle = screen.getByRole('separator', { name: 'Resize column' });
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
  });

  it('reads the pair out of the DOM and re-proportions it as the pointer moves', () => {
    const host = twoColumns(1, 2);
    const onResize = vi.fn();
    render(<ColumnGutter id="c2" onResize={onResize} />, { container: host });
    press(200);
    moveTo(320); // 120px right: the left column grows from 200 to 320 of 600
    expect(onResize).toHaveBeenCalledWith(1.6, 1.4);
  });

  /* From where the drag STARTED, not accumulated per event — the lesson
     ResizeHandle has carried since M11. Accumulating, a fast drag drifts away
     from the cursor and never comes back. */
  it('computes from the grab, so two moves are not added together', () => {
    const host = twoColumns(1, 1, 300, 300);
    const onResize = vi.fn();
    render(<ColumnGutter id="c2" onResize={onResize} />, { container: host });
    press(300);
    moveTo(360);
    moveTo(420);
    // 120px from the grab, not 60 then another 60 from wherever it had got to.
    expect(onResize).toHaveBeenLastCalledWith(1.4, 0.6);
  });

  /* A column with no `width=` on disk is a column at the default, never a
     column of unknown width. */
  it('treats a missing width as the default rather than as nothing', () => {
    const host = twoColumns(null, null, 300, 300);
    const onResize = vi.fn();
    render(<ColumnGutter id="c2" onResize={onResize} />, { container: host });
    press(300);
    moveTo(420);
    // The same answer a declared 1:1 gives. Read as anything else — nothing,
    // NaN, zero — the pair would have no total and the drag would do nothing.
    expect(onResize).toHaveBeenCalledWith(1.4, 0.6);
  });

  it('does nothing at all when there is no column to its left', () => {
    const lone = document.createElement('div');
    lone.setAttribute('data-node-type', 'blockOuter');
    document.body.appendChild(lone);
    const onResize = vi.fn();
    render(<ColumnGutter id="only" onResize={onResize} />, { container: lone });
    press(100);
    moveTo(300);
    expect(onResize).not.toHaveBeenCalled();
  });

  /* Escape abandons. On a handle that paints by WRITING, putting it back is a
     write of its own rather than the absence of one. */
  it('writes the original ratios back when the drag is abandoned', () => {
    const host = twoColumns(1, 2);
    const onResize = vi.fn();
    render(<ColumnGutter id="c2" onResize={onResize} />, { container: host });
    press(200);
    moveTo(320);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onResize).toHaveBeenLastCalledWith(1, 2);
  });

  it('ignores a press that is not the primary button', () => {
    const host = twoColumns(1, 2);
    const onResize = vi.fn();
    render(<ColumnGutter id="c2" onResize={onResize} />, { container: host });
    press(200, 2);
    moveTo(320);
    expect(onResize).not.toHaveBeenCalled();
  });
});
