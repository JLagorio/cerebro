import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DndContext, KeyboardSensor, useDraggable, useSensor, useSensors } from '@dnd-kit/core';
import { ownsEscape, resetLayers, useLayer } from '@/components/ui/layers';
import { useDndGesture, useDragGesture } from '@/hooks/useDragGesture';

/**
 * The shared drag gesture (M46.2 Task 1b).
 *
 * Everything here is asserted against a REAL listener rather than against the
 * layer stack's state. The state around a keystroke and what a listener sees
 * DURING one are different questions, and the second is where the defects
 * live: a `pushLayer` plus an `ownsEscape` assertion passes happily over a
 * layer that is popped mid-dispatch.
 */

afterEach(cleanup);
afterEach(resetLayers);

/**
 * `DetailPanel`'s `DetailEscapeLayer`, to the letter: a layer, a `window`
 * listener in the BUBBLE phase, and a deference through `ownsEscape`.
 *
 * The phase is the whole point. `window` bubble is the LAST thing a keystroke
 * reaches — after `window` capture (`Popover`) and after `document` bubble
 * (`Dialog`, and dnd-kit's own cancel).
 */
function PanelLike({ onClose }: { onClose: () => void }) {
  const id = useLayer();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!ownsEscape(id)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id, onClose]);
  return null;
}

const settle = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};
const escape = (on: Element) => fireEvent.keyDown(on, { key: 'Escape', code: 'Escape' });

// ---------------------------------------------------------------------------
// useDndGesture — the layer alone, with dnd-kit doing its own cancelling.

function Canvas({ onDragEnd = vi.fn() }: { onDragEnd?: () => void }) {
  const sensors = useSensors(
    useSensor(KeyboardSensor, {
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
    }),
  );
  const gesture = useDndGesture(onDragEnd);
  return (
    <DndContext sensors={sensors} {...gesture}>
      <Block />
    </DndContext>
  );
}

function Block() {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: 'block' });
  return <span ref={setNodeRef} data-testid="grip" {...attributes} {...listeners} />;
}

const announced = () =>
  [...document.querySelectorAll('[role="status"]')].map((n) => n.textContent).join(' ');

/**
 * The keyboard sensor's pick-up. The await is not optional: `attach` adds its
 * own keydown listener inside a `setTimeout(0)`, so a synchronous Escape after
 * the pick-up never reaches dnd-kit at all.
 */
const pickUp = async () => {
  const grip = screen.getByTestId('grip');
  grip.focus();
  fireEvent.keyDown(grip, { key: ' ', code: 'Space' });
  // Vacuity guard: with no drag in flight every case below is about nothing.
  expect(announced()).toContain('Picked up draggable item');
  await settle();
  return grip;
};

function mount(onClose: () => void) {
  render(
    <>
      <PanelLike onClose={onClose} />
      <Canvas />
    </>,
  );
}

describe('useDndGesture', () => {
  beforeEach(() => resetLayers());

  /**
   * dnd-kit cancels from a `document` BUBBLE listener and runs `onDragCancel`
   * synchronously inside it — one phase before `window` bubble, where the
   * record panel listens. A pop that ran there handed the panel an empty stack
   * DURING the very keystroke the drag was cancelling with, so the panel
   * closed: one press, two dismissals, which is the case this hook exists to
   * end. Reachable wherever a board or dashboard stands beside an open record.
   */
  it('keeps the keystroke from a window-BUBBLE surface for the whole dispatch', async () => {
    const onClose = vi.fn();
    mount(onClose);
    const grip = await pickUp();

    escape(grip);

    // dnd-kit's own cancel still runs — this hook must never swallow the key.
    expect(announced()).toContain('Dragging was cancelled');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('hands the key back to that surface once the cancel has settled', async () => {
    const onClose = vi.fn();
    mount(onClose);
    const grip = await pickUp();
    escape(grip);
    await settle();

    // A hold that outlived its gesture would leave the panel no way out but
    // the mouse.
    escape(grip);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hands the key back on a drop, with no wait at all', async () => {
    const onClose = vi.fn();
    mount(onClose);
    const grip = await pickUp();
    // Space again is the sensor's DROP, and the release path stays synchronous:
    // a commit may open a toast or a dialog, and that surface has to land on a
    // stack the finished drag has already left. Nothing in this dispatch is
    // aimed at Escape, so there is nothing to hold the layer for.
    fireEvent.keyDown(grip, { key: ' ', code: 'Space' });

    escape(grip);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a fresh drag inside the settle window keeps the key', async () => {
    const onClose = vi.fn();
    mount(onClose);
    const grip = await pickUp();
    escape(grip);
    // Picked up again before the cancelled gesture's hold expires. The
    // deferred release must not take the NEW gesture's layer with it.
    fireEvent.keyDown(grip, { key: ' ', code: 'Space' });
    await settle();

    escape(grip);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('hands the key back when the canvas unmounts mid-drag', async () => {
    const onClose = vi.fn();
    render(<Canvas />);
    render(<PanelLike onClose={onClose} />);
    await pickUp();

    cleanup();
    await settle();
    render(<PanelLike onClose={onClose} />);
    escape(document.body);

    // A leaked gesture layer sits on the stack forever, and every later Escape
    // in the app finds it there instead of the surface it was aimed at.
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// useDragGesture — the hand-written loops, which claim the key themselves.

/** One pointer loop, the shape all six share. */
function Loop({
  onTeardown,
  onCancel,
  withCancelArm = false,
}: {
  onTeardown: () => void;
  onCancel?: () => void;
  withCancelArm?: boolean;
}) {
  const gesture = useDragGesture();
  return (
    <span
      data-testid="handle"
      onPointerDown={() => {
        const move = () => {};
        const up = () => gesture.end();
        const teardown = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          onTeardown();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        gesture.begin(teardown, withCancelArm ? onCancel : undefined);
      }}
    />
  );
}

describe('useDragGesture when the release never arrives', () => {
  beforeEach(() => resetLayers());
  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
  });

  const grab = () => fireEvent.pointerDown(screen.getByTestId('handle'), { button: 0 });

  /**
   * The layer is pushed at pointerdown and the loops listen for `pointermove`,
   * `pointerup` and `pointercancel` and nothing else. Lose the release — the
   * button let go outside the window, a tab switch, an OS focus steal — and
   * before this the `'gesture'` layer sat on the stack until the component
   * unmounted, so `ownsEscape` answered "the drag" for every surface in the
   * app and Escape stopped closing dialogs, popovers and the panel.
   *
   * A NEW consequence of the layer: the pre-M46.2 loops stranded local state
   * in the same scenario, which was invisible. dnd-kit guards exactly this.
   */
  it('a window blur abandons the gesture and hands the key back', () => {
    const onClose = vi.fn();
    const onTeardown = vi.fn();
    render(
      <>
        <PanelLike onClose={onClose} />
        <Loop onTeardown={onTeardown} />
      </>,
    );
    grab();
    // No Escape first — that would end the gesture and leave the blur nothing
    // to do, which is how this case passed against the broken code on its
    // first draft. The gesture has to still be live when focus is lost.
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(onTeardown).toHaveBeenCalledTimes(1);
    escape(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the document going hidden does the same', () => {
    const onClose = vi.fn();
    const onTeardown = vi.fn();
    render(
      <>
        <PanelLike onClose={onClose} />
        <Loop onTeardown={onTeardown} />
      </>,
    );
    grab();

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(onTeardown).toHaveBeenCalledTimes(1);
    escape(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a visibilitychange back to VISIBLE abandons nothing', () => {
    const onTeardown = vi.fn();
    render(<Loop onTeardown={onTeardown} />);
    grab();

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(onTeardown).not.toHaveBeenCalled();
  });

  it('runs the cancel arm where there is one, so the release still has its listener', () => {
    const onTeardown = vi.fn();
    const onCancel = vi.fn();
    render(<Loop onTeardown={onTeardown} onCancel={onCancel} withCancelArm />);
    grab();

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    // The table's column drag needs this: its release still has to swallow the
    // click it produces on a header that is also a menu trigger.
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onTeardown).not.toHaveBeenCalled();
  });

  it('takes its blur and visibility listeners back off with the gesture', () => {
    const onTeardown = vi.fn();
    render(<Loop onTeardown={onTeardown} />);
    grab();
    act(() => {
      window.dispatchEvent(new Event('pointerup'));
    });
    expect(onTeardown).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    // A guard left armed past its gesture would tear down the next one.
    expect(onTeardown).toHaveBeenCalledTimes(1);
  });
});
