import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useDndContext, useDndMonitor } from '@dnd-kit/core';

/**
 * Notion's SECOND drag grammar — block reorder — as two pieces of chrome
 * (M46.2 Task 4, reference §C-II).
 *
 * The measurement found two grammars in one app and we matched neither.
 * `useSortableList` now carries the first (§C-I: the real row follows the
 * cursor, siblings slide, no ghost and no line). This file carries the second,
 * the one a BLOCK among blocks takes:
 *
 * - a **clone** at `opacity: 0.4` follows the cursor while the source stays
 *   exactly where it was, at full strength. Ours did the inverse — dimmed the
 *   source to 0.6 and left a hole where it had been, with nothing at all under
 *   the pointer (`2026-08-29-cerebro-drag-baseline.md` §D1–D3);
 * - a 4px **insertion line** that is a CHILD OF THE TARGET, so it inherits
 *   that target's width and indent. Ours was a fixed-width bar owned by the
 *   container, blind to the box it was pointing at (§D4/D5).
 *
 * Both are surface-agnostic on purpose: the canvas's sections, the dashboard's
 * widgets and (Task 5) the board's cards are the same gesture over different
 * nouns, and a second copy of this would be a second thing to keep in step.
 *
 * **Dark-theme numbers, our tokens.** Every value the reference states is a
 * dark-theme measurement of Notion's palette; light-theme equivalents were
 * never measured. So the 4px, the 43%, the `z-index: 88` and the 200ms are
 * carried over as MEASUREMENTS, and the colour behind the 43% is our accent
 * — never their `#2383E2`.
 */

/** The source's viewport box at pick-up. `DOMRect` satisfies it. */
export interface GhostRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The pointer's travel since pick-up — dnd-kit's `delta`, unmodified. */
export interface GhostDelta {
  x: number;
  y: number;
}

/**
 * Where the ghost sits, pure (reference §C-II.2).
 *
 * Notion's structure is a fixed layer, a WRAPPER carrying the pointer delta,
 * and inside it a clone laid out at the source's own page coordinates. That
 * separation is the whole trick and it is why no grab offset is ever computed:
 * the clone starts exactly on top of the source, so whatever point of it the
 * user grabbed is already under the pointer, and translating by the RAW delta
 * keeps it there for the length of the gesture. An implementation that
 * centred the clone on the cursor — the obvious shortcut — would make the
 * block jump to the pointer on the first frame.
 *
 * The clone's own appearance is stated rather than left to a class, because
 * every one of these was a measured `none` and each is a thing a later
 * stylesheet could quietly add: no scale, no rotation, no shadow, no
 * background, no rounded corners. A lifted-and-tilted card is somebody else's
 * drag grammar.
 */
export function ghostLayout(
  rect: GhostRect,
  delta: GhostDelta,
): { wrapper: CSSProperties; clone: CSSProperties } {
  return {
    wrapper: {
      position: 'absolute',
      top: 0,
      insetInlineStart: 0,
      transform: `translate3d(${delta.x}px, ${delta.y}px, 0)`,
    },
    clone: {
      position: 'absolute',
      top: rect.top,
      insetInlineStart: rect.left,
      width: rect.width,
      height: rect.height,
      opacity: 0.4,
      pointerEvents: 'none',
      transform: 'none',
      backgroundColor: 'transparent',
      boxShadow: 'none',
      borderRadius: 0,
    },
  };
}

/**
 * The layer itself. `fixed` because the clone is placed by the source's
 * VIEWPORT rect, and above the DS dialog scrim (z-index 1000) because a drag
 * that starts inside a dialog must not slide under it — the same band the
 * popover already occupies, and below the tooltip/toast band at 1100. It can
 * never intercept anything: the layer is pointer-transparent and `inert`.
 */
const LAYER: CSSProperties = {
  position: 'fixed',
  inset: 0,
  overflow: 'hidden',
  pointerEvents: 'none',
  zIndex: 1050,
};

/**
 * Attributes a clone must not carry into the document a second time.
 *
 * `id` and `data-testid` are identities: duplicated, they make
 * `getByTestId` ambiguous and `getElementById` a coin toss. `data-drag-id` is
 * how the layer FINDS a source, so a clone wearing one could be picked up as
 * the source of the next drag. `data-line` would give the ghost a second copy
 * of the insertion line, riding along under the cursor.
 */
const CLONE_STRIPS = ['id', 'data-testid', 'data-drag-id', 'data-line', 'data-slot'];

function depersonalise(root: HTMLElement): void {
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const attr of CLONE_STRIPS) el.removeAttribute(attr);
  }
}

/**
 * The dragged block's stand-in: a real DOM copy of the source subtree.
 *
 * A copy and not a re-render, for the reason Notion's is one — it is the same
 * pixels by construction, whatever the block happens to be, so no surface has
 * to hand the layer a second rendering of itself. Cloned nodes carry no React
 * props and no delegated listeners (React binds at its own root container and
 * this is appended by hand outside it), so the ghost cannot fire anything the
 * original would have. Belt and braces: the layer is `inert` and
 * `pointer-events: none`, which is what keeps a canvas ghost from breaking the
 * layout editor's inert-preview invariant — the clone of an inert preview is
 * every bit as unreachable as the preview.
 *
 * A live `<input>`'s typed value is an IDL property, not an attribute, so it
 * does not survive `cloneNode`. Accepted: the fields on our block surfaces
 * render their value as text, and a half-typed cell is not what a drag is
 * about.
 */
function GhostClone({ source, style }: { source: HTMLElement; style: CSSProperties }) {
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = box.current;
    if (host === null) return;
    const copy = source.cloneNode(true) as HTMLElement;
    depersonalise(copy);
    host.appendChild(copy);
    return () => copy.remove();
  }, [source]);
  return <div data-testid="drag-ghost" ref={box} style={style} />;
}

/** The source of the drag with this id, or null — the element a surface marked
 * with `data-drag-id`. Scanned rather than selected: an id may carry a colon
 * (`field:priority`) or a quote, and jsdom has no `CSS.escape` to lean on. */
function findDragSource(id: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>('[data-drag-id]')) {
    if (el.getAttribute('data-drag-id') === id) return el;
  }
  return null;
}

/**
 * The ghost layer, mounted as a child of a `DndContext`.
 *
 * It listens through `useDndMonitor` rather than taking props, for two
 * reasons. A call site adds one line and wires nothing — the surface's only
 * obligation is a `data-drag-id` on each source, which is also the thing that
 * says "this block is what moves". And the per-move state stays HERE: a
 * `useState` in the surface would re-render its whole subtree on every pointer
 * frame of every drag, which on the layout canvas is the entire preview.
 */
export function DragGhostLayer() {
  const [ghost, setGhost] = useState<{
    source: HTMLElement;
    rect: GhostRect;
    delta: GhostDelta;
  } | null>(null);
  useDndMonitor({
    onDragStart: ({ active }) => {
      const source = findDragSource(String(active.id));
      if (source === null) {
        // A surface that marks no sources gets no ghost, and nothing else
        // changes. That is the whole failure mode.
        setGhost(null);
        return;
      }
      const r = source.getBoundingClientRect();
      setGhost({
        source,
        rect: { top: r.top, left: r.left, width: r.width, height: r.height },
        delta: { x: 0, y: 0 },
      });
    },
    onDragMove: ({ delta }) =>
      setGhost((g) => (g === null ? null : { ...g, delta: { x: delta.x, y: delta.y } })),
    onDragEnd: () => setGhost(null),
    // The reference verified this for a block and a database row both: cancel
    // takes the ghost with it and the order is untouched.
    onDragCancel: () => setGhost(null),
  });
  if (ghost === null) return null;
  const styles = ghostLayout(ghost.rect, ghost.delta);
  return createPortal(
    <div data-testid="drag-layer" style={LAYER} inert>
      <div style={styles.wrapper}>
        <GhostClone source={ghost.source} style={styles.clone} />
      </div>
    </div>,
    document.body,
  );
}

/** Which edge of its target a line hangs on. `top`/`bottom` are the row case;
 * `start`/`end` are the reference's column variant, a 4px full-height rule on
 * the block's leading edge (§C-II.3). */
export type LineSide = 'top' | 'bottom' | 'start' | 'end';

/**
 * `top: -4px` above, `bottom: -4px` below — the line sits OUTSIDE the target's
 * box, in the gap, rather than eating a strip of it. `inset-x-0` is
 * `inset-inline: 0`, which is the whole point of the line being a child: it
 * takes the target's own width and indent, so a nested or indented block gets
 * a narrower, indented line instead of the container-wide bar we shipped.
 *
 * The column variant sits ON the leading edge (`start-0`, not `-start-1`),
 * which is where it was measured and also the only place it survives a target
 * that clips its own overflow.
 */
const SIDE: Record<LineSide, string> = {
  top: 'inset-x-0 -top-1 h-1',
  bottom: 'inset-x-0 -bottom-1 h-1',
  start: 'inset-y-0 start-0 w-1',
  end: 'inset-y-0 end-0 w-1',
};

/**
 * The line's classes, pure (reference §C-II.3).
 *
 * `h-1` is the measured 4px; `bg-cortex-500/43` is the measured 43% over OUR
 * accent rather than Notion's blue; `rounded-none` and `z-[88]` and
 * `pointer-events-none` are measured as stated.
 *
 * `lit` moves OPACITY on a line that is always there and always accent —
 * never a colour swapped in and out — because that is what makes the
 * cross-fade possible: the target being left fades out over the same 200ms
 * the target being entered fades in, both in the DOM at once, and travel
 * between two targets reads as movement rather than as two snaps. Task 3
 * established the same shape on the canvas's slot; this is that mechanism
 * moved onto the target's own box, so there is one of it and not two.
 */
export function insertionLineClass(side: LineSide, lit: boolean): string {
  return [
    'motion-move pointer-events-none absolute rounded-none bg-cortex-500/43 z-[88]',
    SIDE[side],
    lit ? 'opacity-100' : 'opacity-0',
  ].join(' ');
}

/**
 * The insertion line for one drop target, rendered inside the block it points
 * at (which must be a positioned box — every call site's already is).
 *
 * `gap` is the droppable id this line stands for, so the line is lit by
 * exactly the target that would COMMIT, read from dnd-kit's own `over`. It
 * stays mounted when it is not lit — see `insertionLineClass` — so the
 * cross-fade has something to fade.
 */
export function InsertionLine({ gap, side }: { gap: string; side: LineSide }) {
  const { over } = useDndContext();
  const lit = over !== null && String(over.id) === gap;
  return (
    <span
      data-testid="insertion-line"
      data-line={gap}
      data-side={side}
      data-lit={lit ? 'true' : 'false'}
      className={insertionLineClass(side, lit)}
    />
  );
}

/**
 * Which rendered block hosts the line for each insertion gap, given the gaps
 * in render order — `gaps[i]` sitting before block `i`, and one more at the
 * end (`gaps.length === blocks + 1`).
 *
 * A gap has two neighbours and both could draw it, so the rule has to pick
 * one or a single target lights twice. It hangs on the block that FOLLOWS the
 * gap, as that block's `top` line; the last gap has no follower, so it hangs
 * below the block that precedes it. Every gap is therefore drawn exactly once
 * and by a block whose box it actually sits against — the invariant this is
 * pure and tested for.
 *
 * A container with no blocks (an emptied section) returns nothing: there is no
 * box to hug, and that container's own drop grammar is the whole-area one.
 */
export function lineHosts(gaps: string[]): { above: string; below?: string }[] {
  const blocks = gaps.length - 1;
  if (blocks <= 0) return [];
  return Array.from({ length: blocks }, (_, i) =>
    i === blocks - 1 ? { above: gaps[i], below: gaps[blocks] } : { above: gaps[i] },
  );
}
