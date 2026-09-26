// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlockGrip } from './BlockDragLayer';

/**
 * The grip's pointer loop (M48.4).
 *
 * The geometry it consults is `blockDrop` and is tested where it lives; what
 * is tested here is the loop around it — when a press becomes a drag, what
 * gets painted while it is one, and what is committed when the pointer comes
 * up. Every one of these is a claim the drag it replaced could not make: the
 * browser's HTML5 drag cannot be driven from a test at all.
 */

const rect = (top: number, height: number): DOMRect =>
  ({
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 600,
    width: 600,
    x: 0,
    y: top,
    toJSON: () => '',
  }) as DOMRect;

/** Three stacked blocks, 40px each with a 10px gap. */
function editorDom(): HTMLElement {
  const root = document.createElement('div');
  ['a', 'b', 'c'].forEach((id, i) => {
    const outer = document.createElement('div');
    outer.setAttribute('data-node-type', 'blockOuter');
    outer.setAttribute('data-id', id);
    outer.appendChild(document.createElement('div'));
    vi.spyOn(outer, 'getBoundingClientRect').mockReturnValue(rect(i * 50, 40));
    root.appendChild(outer);
  });
  document.body.appendChild(root);
  return root;
}

/* jsdom has no `PointerEvent`; a `MouseEvent` under the pointer type reaches
   the same listeners carrying the same coordinates. */
const pointer = (type: string, init: MouseEventInit) => new MouseEvent(type, init);

const grab = (x: number, y: number, button = 0) =>
  screen
    .getByTestId('block-grip')
    .dispatchEvent(pointer('pointerdown', { bubbles: true, button, clientX: x, clientY: y }));

/* Wrapped in `act`: the loop's listeners are on the WINDOW, so the state they
   set lands outside React's own event handling and is not flushed until React
   is given the chance. */
const moveTo = (x: number, y: number) =>
  act(() => {
    window.dispatchEvent(pointer('pointermove', { bubbles: true, clientX: x, clientY: y }));
  });

const release = () =>
  act(() => {
    window.dispatchEvent(pointer('pointerup', { bubbles: true }));
  });

function mount(onDrop = vi.fn()) {
  const root = editorDom();
  render(
    <BlockGrip blockId="c" hostRef={{ current: root }} onDrop={onDrop}>
      <button type="button">menu</button>
    </BlockGrip>,
  );
  return { root, onDrop };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('the block grip', () => {
  it('renders whatever control it was given, and adds no second one', () => {
    mount();
    expect(screen.getByRole('button', { name: 'menu' })).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  /* A press that never travels is a CLICK, and the click belongs to the menu.
     That is what keeps this one control instead of two. */
  it('does not become a drag until the pointer has travelled', () => {
    const { onDrop } = mount();
    grab(10, 200);
    moveTo(12, 201);
    expect(screen.queryByTestId('block-drop-line')).toBeNull();
    release();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('paints a line where the block would land, once the press is a drag', () => {
    mount();
    grab(10, 200);
    moveTo(40, 2); // up to the top of the first block
    const line = screen.getByTestId('block-drop-line');
    expect(line.getAttribute('data-block')).toBe('a');
    expect(line.getAttribute('data-placement')).toBe('before');
  });

  it('commits where the line said, and stops painting', () => {
    const { onDrop } = mount();
    grab(10, 200);
    moveTo(40, 2);
    release();
    expect(onDrop).toHaveBeenCalledWith(
      expect.objectContaining({ blockId: 'a', placement: 'before' }),
    );
    expect(screen.queryByTestId('block-drop-line')).toBeNull();
  });

  /* Picking a block up and putting it back is the commonest gesture there is.
     Committing it would push an undo entry and dirty the file for nothing. */
  it('paints nothing and commits nothing for a drop that changes nothing', () => {
    const { onDrop } = mount();
    grab(10, 200);
    moveTo(40, 100); // the gap above 'c' — which is where 'c' already is
    expect(screen.queryByTestId('block-drop-line')).toBeNull();
    release();
    expect(onDrop).not.toHaveBeenCalled();
  });

  /* Escape abandons a drag in flight (M46.2). The block stays where it was. */
  it('abandons on Escape without committing', () => {
    const { onDrop } = mount();
    grab(10, 200);
    moveTo(40, 2);
    expect(screen.getByTestId('block-drop-line')).toBeTruthy();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(screen.queryByTestId('block-drop-line')).toBeNull();
    release();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('ignores a press that is not the primary button', () => {
    const { onDrop } = mount();
    grab(10, 200, 2);
    moveTo(40, 2);
    release();
    expect(onDrop).not.toHaveBeenCalled();
  });
});
