// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DndContext,
  KeyboardSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  DragGhostLayer,
  ghostLayout,
  insertionLineClass,
  lineHosts,
  InsertionLine,
  type LineSide,
} from '@/components/ui/BlockDrag';

/**
 * Notion's block-drag grammar, measured (M46.2 Task 4).
 *
 * The numbers here are quoted from
 * `docs/superpowers/specs/2026-08-29-notion-drag-and-row-reference.md` §C-II,
 * which is a dark-theme reading of the live app. What travels is the
 * GEOMETRY and the TIMING; the colour behind the measured 43% is ours.
 */

afterEach(cleanup);

describe('ghostLayout (reference §C-II.2)', () => {
  const rect = { top: 120, left: 40, width: 720, height: 40 };

  it('lays the clone at the SOURCE, and translates the wrapper by the raw delta', () => {
    // The two halves of the trick. The clone starts exactly on top of the
    // thing it copies, so the grab point is already under the pointer and no
    // offset is ever computed; the wrapper then moves by the pointer's own
    // travel, so it stays there.
    const { wrapper, clone } = ghostLayout(rect, { x: 33, y: -12 });
    expect(wrapper.transform).toBe('translate3d(33px, -12px, 0)');
    expect(clone.top).toBe(120);
    expect(clone.insetInlineStart).toBe(40);
    expect(clone.width).toBe(720);
    expect(clone.height).toBe(40);
  });

  it('starts the drag with the clone exactly over the source', () => {
    // Frame zero: delta 0, so the ghost has not moved at all. A layer that
    // centred the clone on the cursor instead would make the block jump on
    // pick-up — the failure this shape exists to avoid.
    const { wrapper } = ghostLayout(rect, { x: 0, y: 0 });
    expect(wrapper.transform).toBe('translate3d(0px, 0px, 0)');
  });

  it('the ghost is 40% opaque and untouchable', () => {
    const { clone } = ghostLayout(rect, { x: 0, y: 0 });
    expect(clone.opacity).toBe(0.4);
    expect(clone.pointerEvents).toBe('none');
  });

  it('adds no scale, no rotation, no shadow, no background and no radius', () => {
    // Each was measured as absent, and each is a thing a stylesheet could
    // quietly add later. A lifted, tilted, shadowed card is a DIFFERENT
    // drag grammar, and half of one is worse than either.
    const { clone } = ghostLayout(rect, { x: 10, y: 10 });
    expect(clone.transform).toBe('none');
    expect(clone.boxShadow).toBe('none');
    expect(clone.backgroundColor).toBe('transparent');
    expect(clone.borderRadius).toBe(0);
  });

  it('the wrapper carries the movement and the clone carries none of it', () => {
    // Which element moves matters: the clone's own `top`/`left` are the
    // SOURCE's, fixed for the gesture, and only the wrapper's transform
    // changes per frame.
    const a = ghostLayout(rect, { x: 0, y: 0 });
    const b = ghostLayout(rect, { x: 200, y: 90 });
    expect(a.clone.top).toBe(b.clone.top);
    expect(a.clone.insetInlineStart).toBe(b.clone.insetInlineStart);
    expect(a.wrapper.transform).not.toBe(b.wrapper.transform);
  });
});

describe('insertionLineClass (reference §C-II.3)', () => {
  it('is 4px of accent at 43%, square, at z-index 88, and untouchable', () => {
    const c = insertionLineClass('top', true);
    expect(c).toContain('h-1'); // 4px
    expect(c).toContain('bg-cortex-500/43'); // OUR accent at the measured 43%
    expect(c).toContain('rounded-none'); // measured border-radius: 0
    expect(c).toContain('z-[88]');
    expect(c).toContain('pointer-events-none');
  });

  it('spans the target inline-box, which is what makes it inherit the indent', () => {
    // `inset-x-0` is `inset-inline: 0`. The line being a CHILD is only worth
    // anything because of this: a nested or indented target gets a narrower,
    // indented line, where our container-owned bar was one fixed width for
    // every row it ever pointed at.
    expect(insertionLineClass('top', true)).toContain('inset-x-0');
    expect(insertionLineClass('bottom', true)).toContain('inset-x-0');
  });

  it('sits above at top:-4px and below at bottom:-4px', () => {
    expect(insertionLineClass('top', true)).toContain('-top-1');
    expect(insertionLineClass('top', true)).not.toContain('-bottom-1');
    expect(insertionLineClass('bottom', true)).toContain('-bottom-1');
    expect(insertionLineClass('bottom', true)).not.toContain('-top-1');
  });

  it('the column variant is 4px WIDE on the leading edge, full height', () => {
    const start = insertionLineClass('start', true);
    expect(start).toContain('w-1');
    expect(start).toContain('inset-y-0');
    expect(start).toContain('start-0');
    expect(start).not.toContain('h-1');
  });

  it('lights by opacity alone — the bookkeeping the cross-fade needs', () => {
    // Both states are the accent colour and both declare `motion-move`, so
    // the target being LEFT fades out over the same 200ms the target being
    // entered fades in. A line that lit by swapping its background would
    // snap, and one that unmounted would have nothing left to fade.
    const lit = insertionLineClass('top', true);
    const dark = insertionLineClass('top', false);
    expect(lit).toContain('opacity-100');
    expect(dark).toContain('opacity-0');
    for (const c of [lit, dark]) {
      expect(c).toContain('motion-move');
      expect(c).toContain('bg-cortex-500/43');
    }
  });
});

describe('InsertionLine outside a drag', () => {
  it('is mounted and dark — it exists before it is needed', () => {
    // Not conditional rendering: a line that appears only once it is the
    // target has no previous line to cross-fade against, and its own arrival
    // cannot animate either (mount and light land in one frame).
    render(<InsertionLine gap="slot:g1:0" side="top" />);
    const line = screen.getByTestId('insertion-line');
    expect(line.getAttribute('data-lit')).toBe('false');
    expect(line.getAttribute('data-line')).toBe('slot:g1:0');
    expect(line.className).toContain('opacity-0');
  });

  it('carries its side, so a reader can tell above from below', () => {
    for (const side of ['top', 'bottom', 'start', 'end'] as LineSide[]) {
      cleanup();
      render(<InsertionLine gap="g" side={side} />);
      expect(screen.getByTestId('insertion-line').getAttribute('data-side')).toBe(side);
    }
  });
});

/**
 * The lit path, over real dnd-kit wiring rather than a mocked context.
 *
 * jsdom measures every rect at 0x0, so the harness states its target
 * outright — which is honest here: what is under test is that the LINE reads
 * dnd-kit's `over` and that only the matching one lights, not how a target
 * gets resolved (`dropPartition.test.ts` owns that).
 */
function Harness({ target }: { target: string }) {
  const sensors = useSensors(
    useSensor(KeyboardSensor, {
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
    }),
  );
  return (
    <DndContext sensors={sensors} collisionDetection={() => [{ id: target }]}>
      <DragGhostLayer />
      <div data-testid="source" data-drag-id="block:1">
        <Grip />
      </div>
      <Gap id="gap:a" />
      <Gap id="gap:b" />
    </DndContext>
  );
}

function Grip() {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: 'block:1' });
  return <button ref={setNodeRef} {...attributes} {...listeners} aria-label="Drag" />;
}

function Gap({ id }: { id: string }) {
  const { setNodeRef } = useDroppable({ id });
  return (
    <div ref={setNodeRef} data-slot={id} className="relative">
      <InsertionLine gap={id} side="top" />
    </div>
  );
}

describe('InsertionLine during a drag', () => {
  const lineFor = (gap: string) => {
    const line = document.querySelector(`[data-line="${gap}"]`);
    if (line === null) throw new Error(`no line for ${gap}`);
    return line;
  };
  /** `KeyboardSensor.attach` registers inside a `setTimeout(0)`. */
  const pickUp = async () => {
    const grip = screen.getByRole('button', { name: 'Drag' });
    grip.focus();
    fireEvent.keyDown(grip, { key: ' ', code: 'Space' });
    await new Promise((r) => setTimeout(r, 0));
    return grip;
  };

  it('lights the line whose gap is the target, and only that one', async () => {
    render(<Harness target="gap:b" />);
    await pickUp();
    expect(lineFor('gap:b').getAttribute('data-lit')).toBe('true');
    expect(lineFor('gap:b').className).toContain('opacity-100');
    expect(lineFor('gap:a').getAttribute('data-lit')).toBe('false');
  });

  it('the line that is NOT the target stays mounted, dark — the fade needs it', async () => {
    // The outgoing half of the cross-fade. Unmounting the previous line would
    // make travel between targets read as a snap-out and a snap-in; Notion
    // keeps both in the DOM and moves opacity on each over the same 200ms.
    render(<Harness target="gap:b" />);
    await pickUp();
    const dark = lineFor('gap:a');
    expect(dark.isConnected).toBe(true);
    expect(dark.className).toContain('opacity-0');
    expect(dark.className).toContain('motion-move');
  });

  it('goes dark again when the drag is cancelled', async () => {
    render(<Harness target="gap:b" />);
    const grip = await pickUp();
    expect(lineFor('gap:b').getAttribute('data-lit')).toBe('true');
    fireEvent.keyDown(grip, { key: 'Escape', code: 'Escape' });
    expect(lineFor('gap:b').getAttribute('data-lit')).toBe('false');
  });

  it('re-measures the source each frame, so a scroll does not carry the ghost off', async () => {
    // dnd-kit's `delta` is the pointer's travel PLUS however far the surface
    // has scrolled, because the thing it normally moves lives inside that
    // surface. Ours lives in a fixed layer that no scrolling moves, so a rect
    // measured once at pick-up would drift by exactly the scrolled distance —
    // and dnd-kit auto-scrolls by default, on two surfaces that both scroll.
    // Here the source is made to report a box 40px higher, as a scrolled
    // container would; the ghost has to follow the source, not the memory.
    render(<Harness target="gap:b" />);
    const source = screen.getByTestId('source');
    const grip = await pickUp();
    expect((screen.getByTestId('drag-ghost') as HTMLElement).style.top).toBe('0px');

    source.getBoundingClientRect = () => ({ top: -40, left: 0, width: 100, height: 20 }) as DOMRect;
    fireEvent.keyDown(grip, { key: 'ArrowDown', code: 'ArrowDown' });

    expect((screen.getByTestId('drag-ghost') as HTMLElement).style.top).toBe('-40px');
  });
});

describe('lineHosts', () => {
  it('hangs every gap on the block that follows it', () => {
    expect(lineHosts(['a', 'b', 'c'])).toEqual([{ above: 'a' }, { above: 'b', below: 'c' }]);
  });

  it('gives the LAST gap to the block before it — nothing follows it', () => {
    const hosts = lineHosts(['a', 'b']);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toEqual({ above: 'a', below: 'b' });
  });

  it('draws each gap exactly once, at every size', () => {
    // The invariant the rule exists for. A gap sits between two blocks and
    // both could legitimately draw it; if both do, one target lights twice
    // and the user is shown two insertion points for one drop.
    for (const blocks of [1, 2, 3, 7]) {
      const gaps = Array.from({ length: blocks + 1 }, (_, i) => `slot:g:${i}`);
      const drawn = lineHosts(gaps).flatMap((h) =>
        h.below === undefined ? [h.above] : [h.above, h.below],
      );
      expect([...drawn].sort()).toEqual([...gaps].sort());
      expect(new Set(drawn).size).toBe(gaps.length);
    }
  });

  it('an emptied container hosts nothing — there is no box to hug', () => {
    expect(lineHosts(['slot:g:0'])).toEqual([]);
    expect(lineHosts([])).toEqual([]);
  });
});
