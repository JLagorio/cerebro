import { describe, expect, it } from 'vitest';
import { beginTabDrag, currentTabDrag, dropSlot, endTabDrag, zoneFor } from './tabDrag';

/** jsdom gives every element a zero box, so rects are built by hand here. */
const rect = (left: number, width: number): DOMRect =>
  ({ left, width, right: left + width, top: 0, bottom: 0, height: 0, x: left, y: 0 }) as DOMRect;

describe('dropSlot', () => {
  it('lands before a tab when the pointer has not passed its midpoint', () => {
    expect(dropSlot(2, 40, rect(0, 100))).toBe(2);
  });

  it('lands after a tab once the pointer passes the midpoint', () => {
    expect(dropSlot(2, 60, rect(0, 100))).toBe(3);
  });

  it('measures from the tab, not from the window', () => {
    expect(dropSlot(0, 540, rect(500, 100))).toBe(0);
    expect(dropSlot(0, 560, rect(500, 100))).toBe(1);
  });
});

describe('zoneFor', () => {
  it('claims a quarter at each edge and leaves the middle alone', () => {
    const box = rect(0, 400);
    expect(zoneFor(10, box)).toBe('left');
    expect(zoneFor(200, box)).toBe('center');
    expect(zoneFor(390, box)).toBe('right');
  });

  it('puts the boundaries exactly on the quarters', () => {
    const box = rect(0, 400);
    expect(zoneFor(99, box)).toBe('left');
    expect(zoneFor(101, box)).toBe('center');
    expect(zoneFor(299, box)).toBe('center');
    expect(zoneFor(301, box)).toBe('right');
  });

  it('measures from the pane, not from the window', () => {
    const box = rect(800, 400);
    expect(zoneFor(810, box)).toBe('left');
    expect(zoneFor(1000, box)).toBe('center');
  });

  /** A pane with no measurable width has no edges to aim at. */
  it('calls a zero-width pane the middle rather than dividing by zero', () => {
    expect(zoneFor(0, rect(0, 0))).toBe('center');
  });
});

describe('the drag payload', () => {
  it('is nothing until a drag starts, and nothing again once it ends', () => {
    endTabDrag();
    expect(currentTabDrag()).toBeNull();
    beginTabDrag({ tab: { rootId: 'r1', path: 'a.md' }, fromGroupId: 'g1' });
    expect(currentTabDrag()?.tab.path).toBe('a.md');
    endTabDrag();
    expect(currentTabDrag()).toBeNull();
  });
});
