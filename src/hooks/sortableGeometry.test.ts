import { describe, expect, it } from 'vitest';
import {
  clampMain,
  extentOf,
  measureRows,
  offsetByRow,
  orderWith,
  slotFor,
  slotOffsets,
  type ListMetrics,
} from '@/hooks/sortableGeometry';

/**
 * The slot maths of a C-I list reorder (M46.2 Task 2).
 *
 * These are real tests, not guards: every function here takes NUMBERS and
 * returns numbers. The rects in `measureRows` cases are its input domain, not
 * a pretence that jsdom laid anything out — the DOM lifecycle that reads real
 * rects is guarded separately in `useSortableList.test.tsx`.
 *
 * The reference numbers come from `docs/superpowers/specs/
 * 2026-08-29-notion-drag-and-row-reference.md` §C-I: a 7-row property list,
 * 34px content on a 38px pitch, first row's top edge at y 84.
 */

/** Notion's measured property list, as metrics. */
const notion = (rows = 7): ListMetrics => ({
  start: 84,
  sizes: Array.from({ length: rows }, () => 34),
  gaps: Array.from({ length: rows - 1 }, () => 4),
  cross: Array.from({ length: rows }, () => 0),
  crossSizes: Array.from({ length: rows }, () => 347),
});

describe('measureRows', () => {
  const rect = (top: number, left: number, width: number, height: number) => ({
    top,
    left,
    width,
    height,
  });

  it('reads a vertical list down the main axis', () => {
    const m = measureRows(
      [rect(84, 0, 347, 34), rect(122, 0, 347, 34), rect(160, 0, 347, 34)],
      { top: 0, left: 0 },
      'y',
    );

    expect(m.start).toBe(84);
    expect(m.sizes).toEqual([34, 34, 34]);
    expect(m.gaps).toEqual([4, 4]);
    expect(m.crossSizes).toEqual([347, 347, 347]);
  });

  it('reads a horizontal list across the same shapes', () => {
    // The tab strips are the horizontal consumers: the axis swaps which pair
    // of rect fields is "along the list" and which is "across" it.
    const m = measureRows(
      [rect(0, 84, 34, 347), rect(0, 122, 34, 347), rect(0, 160, 34, 347)],
      { top: 0, left: 0 },
      'x',
    );

    expect(m.start).toBe(84);
    expect(m.sizes).toEqual([34, 34, 34]);
    expect(m.gaps).toEqual([4, 4]);
    expect(m.crossSizes).toEqual([347, 347, 347]);
  });

  it('measures from the container, not the viewport', () => {
    const m = measureRows(
      [rect(120, 40, 100, 20), rect(140, 40, 100, 20)],
      { top: 100, left: 40 },
      'y',
    );

    expect(m.start).toBe(20);
    expect(m.cross).toEqual([0, 0]);
  });

  it('keeps a row that bleeds outside the container on the cross axis', () => {
    // PropertyRow wears `-mx-1`, so its box starts 4px left of the column.
    // Zeroing that would shove every row right the moment a drag froze it.
    const m = measureRows([rect(0, -4, 108, 20), rect(20, -4, 108, 20)], { top: 0, left: 0 }, 'y');

    expect(m.cross).toEqual([-4, -4]);
    expect(m.crossSizes).toEqual([108, 108]);
  });

  it('never reports a negative gap', () => {
    // Overlapping rows would invert the slot thresholds; the layout is off by
    // the overlap instead, which is a pixel, not a wrong order.
    const m = measureRows([rect(0, 0, 100, 20), rect(18, 0, 100, 20)], { top: 0, left: 0 }, 'y');

    expect(m.gaps).toEqual([0]);
  });

  it('describes an empty list without throwing', () => {
    const m = measureRows([], { top: 0, left: 0 }, 'y');

    expect(m.start).toBe(0);
    expect(m.sizes).toEqual([]);
    expect(m.gaps).toEqual([]);
  });
});

describe('slotOffsets', () => {
  it('reproduces the measured offsets for the order it measured', () => {
    // The freeze itself is drawn with this function, so identity has to land
    // every row exactly where it already was — otherwise the list twitches
    // the instant a drag begins.
    const m = notion(3);

    expect(slotOffsets(m, orderWith(3, 0, 0))).toEqual([84, 122, 160]);
  });

  it('is exact for non-uniform rows and non-uniform spacing', () => {
    // Notion's 38px pitch is one list's measurement, not a law: our rows are
    // whatever their content makes them.
    const m: ListMetrics = {
      start: 10,
      sizes: [20, 60, 30],
      gaps: [6, 2],
      cross: [0, 0, 0],
      crossSizes: [100, 100, 100],
    };

    expect(slotOffsets(m, [0, 1, 2])).toEqual([10, 36, 98]);
  });

  it('lays the moved row out at its new slot and closes the hole behind it', () => {
    const m = notion(3);

    // `a b c` dragged to the end: b and c take the first two slots.
    expect(slotOffsets(m, orderWith(3, 0, 2))).toEqual([84, 122, 160]);
    expect(offsetByRow(m, 0, 2)).toEqual([160, 84, 122]);
  });
});

describe('orderWith', () => {
  it('moves one index and leaves the rest in order', () => {
    expect(orderWith(4, 0, 2)).toEqual([1, 2, 0, 3]);
    expect(orderWith(4, 3, 1)).toEqual([0, 3, 1, 2]);
    expect(orderWith(4, 2, 2)).toEqual([0, 1, 2, 3]);
  });
});

describe("slotFor — the dragged row's midpoint against the neighbour's leading edge", () => {
  it("matches Notion's measured flip, sample for sample", () => {
    // Reference §C-I.5. The dragged row starts at slot 0 (top 84); the table
    // is indexed by its `translateY`, and the flip lands at 22 (±2px, the
    // sampling granularity).
    const m = notion();
    const midAt = (translateY: number) => 84 + translateY + 34 / 2;

    expect(slotFor(m, 0, 0, midAt(19))).toBe(0);
    expect(slotFor(m, 0, 0, midAt(21))).toBe(0);
    expect(slotFor(m, 0, 0, midAt(23))).toBe(1);
    expect(slotFor(m, 0, 0, midAt(25))).toBe(1);
  });

  it("is the dragged row's midpoint, NOT the pointer and NOT the row's top edge", () => {
    const m = notion();
    // A row whose TOP edge has crossed the neighbour's leading edge — 122 —
    // is a full 17px past the flip. The old rule fired here; this one fired
    // at 107.
    expect(slotFor(m, 0, 0, 84 + 23 + 17)).toBe(1);
    // And the neighbour's own midpoint (139) is far past it.
    expect(slotFor(m, 0, 0, 139)).toBe(1);
  });

  it("swaps upward when the midpoint crosses the neighbour's trailing edge", () => {
    // Notion never measured the up direction; this is the symmetric rule and
    // the plan says so rather than claiming parity. Row 1 rests at 122; the
    // row above it ends at 118.
    const m = notion();

    expect(slotFor(m, 1, 1, 122 - 21 + 17)).toBe(1);
    expect(slotFor(m, 1, 1, 122 - 22 + 17)).toBe(0);
  });

  it('walks past several neighbours in one move', () => {
    const m = notion();

    expect(slotFor(m, 0, 0, 84 + 38 * 3 + 17)).toBe(3);
    expect(slotFor(m, 6, 6, 84 + 17)).toBe(0);
  });

  it('never leaves the list', () => {
    const m = notion(3);

    expect(slotFor(m, 0, 0, -400)).toBe(0);
    expect(slotFor(m, 0, 0, 4000)).toBe(2);
  });

  it('holds its slot inside the gap between the two thresholds', () => {
    // Down at 122, up at 118: a midpoint in between belongs to whoever has it.
    const m = notion();

    expect(slotFor(m, 0, 0, 120)).toBe(0);
    expect(slotFor(m, 0, 1, 120)).toBe(1);
  });

  it('settles instead of flickering when a neighbour is much taller', () => {
    // The ragged case a uniform list never reaches: a 60px neighbour against a
    // 20px dragged row, where the down and up thresholds cross (20 and 60). A
    // still pointer must still settle: whichever slot the previous move left
    // behind, the next one has to agree with it.
    const m: ListMetrics = {
      start: 0,
      sizes: [20, 60, 20],
      gaps: [0, 0],
      cross: [0, 0, 0],
      crossSizes: [100, 100, 100],
    };

    for (let mid = -10; mid <= 110; mid += 1) {
      for (const slot of [0, 1, 2]) {
        const once = slotFor(m, 0, slot, mid);
        expect(slotFor(m, 0, once, mid), `mid ${mid} from slot ${slot}`).toBe(once);
      }
    }
  });

  it('answers from the midpoint alone, outside the hysteresis band', () => {
    // The same property stated directly: every slot is an entry point, and
    // only the gap-wide band between the two thresholds may disagree.
    const m = notion();

    for (let mid = 60; mid <= 340; mid += 1) {
      const answers = new Set([0, 1, 2, 3, 4, 5, 6].map((slot) => slotFor(m, 0, slot, mid)));
      expect(answers.size, `mid ${mid}`).toBeLessThanOrEqual(2);
    }
  });
});

describe('clampMain', () => {
  it('holds the dragged row inside the list', () => {
    // Reference §C-I.3: pointer y 95 and 101 both left the row top at 84.
    const m = notion();

    expect(clampMain(m, 0, 70)).toBe(84);
    expect(clampMain(m, 0, 84)).toBe(84);
    expect(clampMain(m, 0, 100)).toBe(100);
    // 7 rows of 34 with six 4px gaps = 262; the last leading edge is 84+228.
    expect(clampMain(m, 0, 9000)).toBe(84 + 262 - 34);
  });

  it("measures the bottom bound against the dragged row's own size", () => {
    const m: ListMetrics = {
      start: 0,
      sizes: [20, 60],
      gaps: [0],
      cross: [0, 0],
      crossSizes: [100, 100],
    };

    expect(clampMain(m, 0, 500)).toBe(60);
    expect(clampMain(m, 1, 500)).toBe(20);
  });
});

describe('extentOf', () => {
  it('spans the first leading edge to the last trailing edge', () => {
    expect(extentOf(notion())).toBe(7 * 34 + 6 * 4);
    expect(extentOf(notion(1))).toBe(34);
    expect(extentOf(notion(0))).toBe(0);
  });
});
