import React from 'react';
import { Icon } from '@/components/ui/Icon';

/**
 * The drag grip (M46.2 Task 6).
 *
 * The baseline found FOUR geometries for one affordance — 13x13 in place on a
 * property row, 16x24 in the canvas gutter, 12x16 as an in-flow flex child in
 * the group editor, 10x28 as a leading-edge overlay on a view tab — plus
 * seven more hand-written class strings saying the same thing at four sizes
 * and two colour tokens. None of them shifted layout on hover, so this is
 * consistency and hit-target work, not a jank fix, and the baseline says so.
 *
 * Notion has TWO, measured
 * (`docs/superpowers/specs/2026-08-29-notion-drag-and-row-reference.md` §B):
 *
 * - **`row`** (§B1) — the grip a LIST ROW carries, in the row's own leading
 *   slot, where it replaces the type icon rather than appending itself. No
 *   background and no radius of its own: the highlight belongs to the row (on
 *   a property row, to the label cell), and a grip that painted its own would
 *   be a second, smaller highlight inside the first.
 * - **`block`** (§B7) — the handle a BLOCK carries out in the gutter. Larger
 *   glyph, its own 4px radius and hover wash, and a dimmer ink than the row
 *   grip, because it sits on the page background rather than inside a row
 *   that is already lit.
 *
 * **The rule for which surface takes which**: does the gesture reorder an item
 * WITHIN a list (`row`), or move a block among blocks (`block`)? It is the
 * same question the slice's plan uses to choose a drag GRAMMAR — C-I for a
 * list, C-II for a block — so the handle and the lifecycle can never disagree
 * about what kind of thing is being dragged.
 *
 * `tab` is the row grip TRANSPOSED, and it is a judgement rather than a
 * measurement: a view/record tab strip reorders along x, and its grip lives in
 * the tab's own 10px of leading padding. It may not grow to 18px — that is
 * dead space exactly 10px wide, and a wider slot would either shove every tab
 * sideways on hover (the one thing §B1 is emphatic about) or sit on top of the
 * tab's icon. Everything else about it is the row grip: same glyph, same size,
 * same ink, same cursor, same reveal.
 *
 * Ours is lucide's stroked `grip-vertical` where Notion's is a filled six-dot
 * mark, so ours reads thinner at the same size; the mark is our icon set's and
 * changing it is not a parity question.
 */
export type GripKind = 'row' | 'block' | 'tab';

/** Glyph px per kind. 16 for a row (§B3), 20 for a block handle (§B7). */
export const GRIP_GLYPH: Record<GripKind, number> = { row: 16, block: 20, tab: 16 };

/**
 * The declared geometry, exported so a test can read the same string the app
 * ships rather than a copy of it.
 *
 * `motion-move` and not `motion-hover`: what a grip DOES on hover is appear,
 * and appearing is movement. The block kind's own wash is left undeclared for
 * the reason f1a02e8 recorded for the property grip — the wash arrives WITH
 * the grip, so there is no pointer travel for a 20ms guard to smooth, and one
 * element cannot carry two timings in one utility.
 */
export function gripClass(kind: GripKind): string {
  const box =
    kind === 'tab'
      ? // No height: the call site's `inset-y-*` owns it. `overflow-hidden`
        // keeps the 16px glyph box — whose painted mark is only ~5px wide —
        // from hanging 3px over the tab's icon and eating its clicks.
        'w-2.5 overflow-hidden'
      : // 18 x 24, both kinds (§B1, §B7).
        'h-6 w-[18px]';
  const ink =
    kind === 'block'
      ? // Its own 4px radius and wash, and the dimmer ink: a gutter handle
        // stands on the page, not inside a row that is already lit.
        'rounded-xs text-n-300 hover:bg-n-100 hover:text-n-500'
      : // No background, no radius. The row's own highlight is the feedback.
        'text-n-400';
  return `motion-move flex flex-none cursor-grab touch-none items-center justify-center ${box} ${ink}`;
}

export interface GripHandleProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Which primitive. See the rule above; defaults to the list-row one. */
  kind?: GripKind;
  /** A ref is an ordinary prop in React 19 (IconButton's note). */
  ref?: React.Ref<HTMLSpanElement>;
  /**
   * Placement and reveal, from the call site. Both have to live there:
   * whether the slot is absolute or in flow is the row's business, and
   * `group-hover/<name>` cannot be composed at runtime because Tailwind reads
   * class names literally.
   */
  className?: string;
}

export function Grip({ kind = 'row', className, ref, ...rest }: GripHandleProps) {
  return (
    <span ref={ref} {...rest} className={`${gripClass(kind)}${className ? ` ${className}` : ''}`}>
      <Icon name="grip-vertical" size={GRIP_GLYPH[kind]} />
    </span>
  );
}
