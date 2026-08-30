import { describe, expect, it } from 'vitest';
import { resolveDropTarget, targetBands, type DropTarget } from '@/hooks/dropPartition';

/**
 * The canvas's drop targets, built the way the DOM builds them (M46.2 Task 3).
 *
 * Nothing here is a magic number lifted out of the baseline: a stack is
 * DESCRIBED — where it starts, how tall each slot is, how tall each row is —
 * and the extents fall out of laying those pieces end to end, exactly as the
 * flex column does. That is what lets the same sweep run over a family of
 * spacings and prove the partition holds for all of them, rather than for the
 * one arithmetic that happened to be on screen the day it was measured.
 */
function stack(opts: {
  /** Page y of the first slot's top edge. */
  start: number;
  /** How many rows the group holds; a slot brackets every one of them. */
  rows: number;
  /** Slot height — 6px for `h-1.5` row slots, 12px for `h-3` block slots. */
  slot: number;
  /** Row height between two slots. */
  row: number;
}): DropTarget[] {
  const { start, rows, slot, row } = opts;
  const targets: DropTarget[] = [];
  let y = start;
  for (let i = 0; i <= rows; i += 1) {
    targets.push({ id: `slot:g1:${i}`, rect: { top: y, bottom: y + slot } });
    y += slot + row;
  }
  return targets;
}

/** Every integer position in `[from, to]`. */
function sweep(targets: DropTarget[], from: number, to: number): (string | null)[] {
  const out: (string | null)[] = [];
  for (let y = from; y <= to; y += 1) out.push(resolveDropTarget(y, targets));
  return out;
}

const span = (targets: DropTarget[]): [number, number] => [
  Math.min(...targets.map((t) => t.rect.top)),
  Math.max(...targets.map((t) => t.rect.bottom)),
];

describe('targetBands', () => {
  it('the bands tile the stack — each ends where the next begins', () => {
    const bands = targetBands(stack({ start: 200, rows: 3, slot: 6, row: 27 }));
    expect(bands.map((b) => b.id)).toEqual(['slot:g1:0', 'slot:g1:1', 'slot:g1:2', 'slot:g1:3']);
    for (let i = 1; i < bands.length; i += 1) {
      expect(bands[i].from).toBe(bands[i - 1].to);
    }
  });

  it('a boundary sits at the midpoint of two centres — the measured flip point', () => {
    // Slots at 200 and 233 (6px tall, 27px row between): centres 203 and 236,
    // so the flip is 219.5 — the middle of the row, not an edge of a slot.
    const bands = targetBands(stack({ start: 200, rows: 1, slot: 6, row: 27 }));
    expect(bands[0].to).toBe(219.5);
    expect(bands[1].from).toBe(219.5);
  });

  it('orders by centre, not by declaration order', () => {
    const shuffled: DropTarget[] = [
      { id: 'groupslot:2', rect: { top: 300, bottom: 312 } },
      { id: 'groupslot:0', rect: { top: 100, bottom: 112 } },
      { id: 'groupslot:1', rect: { top: 200, bottom: 212 } },
    ];
    expect(targetBands(shuffled).map((b) => b.id)).toEqual([
      'groupslot:0',
      'groupslot:1',
      'groupslot:2',
    ]);
  });

  it('an empty target list has no bands', () => {
    expect(targetBands([])).toEqual([]);
  });
});

describe('resolveDropTarget — the stack has no unlit pixel (M46.2 Task 3)', () => {
  it('the measured geometry that produced the 3px dead band is now continuous', () => {
    // docs/superpowers/specs/2026-08-29-cerebro-drag-baseline.md §D7/D9: the
    // canvas swept at 1px read 225-247 -> slot 0, 248-250 -> NOTHING,
    // 251-279 -> slot 1. Same stack, swept the same way.
    const targets = stack({ start: 245, rows: 3, slot: 6, row: 27 });
    const [top, bottom] = span(targets);
    expect(sweep(targets, top, bottom)).not.toContain(null);
  });

  it('holds across a family of spacings, not one arithmetic', () => {
    // The rect-overlap rule failed whenever `pitch > slotHeight + dragHeight`.
    // These cases run from "slots almost touch" to "a slot is a hairline in a
    // very tall row" — every one of which the old rule lost, and none of which
    // this one can, because the bands are defined by adjacency.
    for (const slot of [1, 2, 6, 12, 24]) {
      for (const row of [0, 4, 27, 33, 200]) {
        const targets = stack({ start: 137, rows: 4, slot, row });
        const [top, bottom] = span(targets);
        expect(sweep(targets, top, bottom), `slot ${slot} / row ${row}`).not.toContain(null);
      }
    }
  });

  it('the lit target only ever moves DOWN as the pointer does', () => {
    // Continuity is not enough on its own: a partition that flickered back to
    // an earlier slot mid-travel would also be gap-free. The sequence must be
    // monotonic in the stack's own order.
    const targets = stack({ start: 245, rows: 5, slot: 6, row: 27 });
    const order = targetBands(targets).map((b) => b.id);
    const [top, bottom] = span(targets);
    let seen = -1;
    for (const id of sweep(targets, top, bottom)) {
      const at = order.indexOf(id ?? '');
      expect(at).toBeGreaterThanOrEqual(seen);
      seen = at;
    }
  });

  it('the slot EXTENTS do not tile the stack — which is why targeting cannot be rect-based', () => {
    // The premise of the whole change, asserted so nobody restores overlap
    // testing on the grounds that "the slots are right there": at the measured
    // spacing the slots cover 7 of every 33 pixels, and a rule that needs the
    // pointer (or the dragged rect) to touch one has to invent an answer for
    // the rest.
    const targets = stack({ start: 245, rows: 3, slot: 6, row: 27 });
    const [top, bottom] = span(targets);
    const covered = (y: number) => targets.some((t) => y >= t.rect.top && y <= t.rect.bottom);
    let holes = 0;
    for (let y = top; y <= bottom; y += 1) if (!covered(y)) holes += 1;
    expect(holes).toBeGreaterThan(0);
  });
});

describe('resolveDropTarget — containment and the ends of the stack', () => {
  it('a tall area target owns all of itself, even where a slot centre is nearer', () => {
    // The heading strip is 200px of target with a 6px group slot 10px below
    // it. By centres alone the bottom 44px of the strip would belong to the
    // slot; containment is what stops the pointer falling THROUGH a block it
    // is visibly inside.
    const targets: DropTarget[] = [
      { id: 'slot:heading:3', rect: { top: 100, bottom: 300 } },
      { id: 'slot:g1:0', rect: { top: 310, bottom: 316 } },
    ];
    expect(resolveDropTarget(299, targets)).toBe('slot:heading:3');
    expect(resolveDropTarget(305, targets)).toBe('slot:g1:0');
    // …and the 9px of gutter between them is still nobody's blind spot.
    expect(sweep(targets, 100, 316)).not.toContain(null);
  });

  it('carrying the drag off the ends of the stack clears the target', () => {
    const targets = stack({ start: 200, rows: 2, slot: 6, row: 27 });
    const [top, bottom] = span(targets);
    expect(resolveDropTarget(top - 1, targets)).toBeNull();
    expect(resolveDropTarget(bottom + 1, targets)).toBeNull();
    expect(resolveDropTarget(top, targets)).toBe('slot:g1:0');
    expect(resolveDropTarget(bottom, targets)).toBe('slot:g1:2');
  });

  it('no targets means no answer', () => {
    expect(resolveDropTarget(0, [])).toBeNull();
  });

  it('a boundary pixel belongs to exactly one band — the earlier one', () => {
    const targets = stack({ start: 200, rows: 1, slot: 6, row: 26 });
    // Centres 203 and 235 -> boundary 219, an integer both bands touch.
    const bands = targetBands(targets);
    expect(bands[0].to).toBe(219);
    expect(bands[1].from).toBe(219);
    expect(resolveDropTarget(219, targets)).toBe('slot:g1:0');
    expect(resolveDropTarget(220, targets)).toBe('slot:g1:1');
  });
});
