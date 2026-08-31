import { describe, expect, it } from 'vitest';
import { dropSpotsFrom, isNoOpDrop, nearestDropSpot, type BlockBox } from './blockDrop';

const box = (
  id: string,
  top: number,
  bottom: number,
  depth = 0,
  left = 0,
  right = 600,
): BlockBox => ({ id, top, bottom, left, right, depth });

/**
 * A page with a column list in the middle:
 *
 *   above          y  0.. 40   depth 0, x 0..600
 *   list          y 50..250   depth 0, x 0..600
 *     left col    y 50..250   depth 1, x 0..290
 *       l1        y 50..100   depth 2
 *       l2        y110..160   depth 2
 *     right col   y 50..250   depth 1, x 310..600
 *       r1        y 50..100   depth 2
 *   below         y260..300   depth 0
 */
const PAGE: BlockBox[] = [
  box('above', 0, 40),
  box('list', 50, 250),
  box('leftcol', 50, 250, 1, 0, 290),
  box('l1', 50, 100, 2, 0, 290),
  box('l2', 110, 160, 2, 0, 290),
  box('rightcol', 50, 250, 1, 310, 600),
  box('r1', 50, 100, 2, 310, 600),
  box('below', 260, 300),
];

describe('turning measured boxes into insertion lines', () => {
  it('offers the gap above every block', () => {
    const spots = dropSpotsFrom([box('a', 0, 10), box('b', 20, 30)]);
    expect(spots.filter((s) => s.placement === 'before').map((s) => s.blockId)).toEqual(['a', 'b']);
  });

  /* A gap between two siblings is one place, not two. Offered twice, the
     nearest-spot search becomes a coin toss between identical answers that
     commit differently. */
  it('offers the gap below only where nothing follows at the same depth', () => {
    const spots = dropSpotsFrom([box('a', 0, 10), box('b', 20, 30)]);
    expect(spots.filter((s) => s.placement === 'after').map((s) => s.blockId)).toEqual(['b']);
  });

  it('closes a nested run before its parent continues', () => {
    const after = dropSpotsFrom(PAGE)
      .filter((s) => s.placement === 'after')
      .map((s) => s.blockId);
    // l2 ends the left column's run, r1 ends the right column's, below ends
    // the page. Nothing else needs a closing line.
    expect(after).toEqual(['l2', 'r1', 'below']);
  });
});

describe('finding the spot the pointer is asking for', () => {
  const spots = dropSpotsFrom(PAGE);
  const at = (x: number, y: number) => {
    const spot = nearestDropSpot(spots, x, y);
    return spot === null ? 'none' : `${spot.placement} ${spot.blockId}`;
  };

  it('lands between two ordinary blocks', () => {
    expect(at(300, 44)).toBe('before list');
  });

  /* The whole reason dropping into a column needs no rule about columns: over
     the left column, only the left column's lines contain the pointer's x. */
  it('drops INTO the column the pointer is over, not beside it', () => {
    expect(at(100, 108)).toBe('before l2');
    expect(at(500, 52)).toBe('before r1');
  });

  it('reaches the end of a column, below its last block', () => {
    expect(at(100, 158)).toBe('after l2');
  });

  /* A column's interior and the list's exterior share an edge at y=50. The
     more specific of the two is what somebody aiming there meant. */
  it('prefers the deeper spot when two lines sit at the same height', () => {
    expect(at(100, 50)).toBe('before l1');
  });

  /* A drag out past the margin has to land somewhere. Landing nowhere means
     the block silently stays put after a gesture that looked like it worked. */
  it('still answers when the pointer is outside every block', () => {
    // Far out to the right, past the last block: the nearest line, not
    // nothing. Landing nowhere means the block silently stays put after a
    // gesture that looked like it worked.
    expect(at(2000, 320)).toBe('after below');
    expect(at(2000, 270)).toBe('before below');
  });

  it('answers nothing only when there is nowhere to go', () => {
    expect(nearestDropSpot([], 10, 10)).toBeNull();
  });
});

describe('a drop that would change nothing', () => {
  const page = [
    { id: 'a', parentId: null },
    { id: 'b', parentId: null },
    { id: 'c', parentId: null },
  ];
  const spot = (blockId: string, placement: 'before' | 'after') => ({
    blockId,
    placement,
    y: 0,
    left: 0,
    right: 100,
    depth: 0,
  });

  it('is a no-op just above and just below where the block already is', () => {
    expect(isNoOpDrop(page, 'a', spot('b', 'before'))).toBe(true);
    expect(isNoOpDrop(page, 'b', spot('a', 'after'))).toBe(true);
  });

  it('is a no-op onto the block itself', () => {
    expect(isNoOpDrop(page, 'b', spot('b', 'before'))).toBe(true);
    expect(isNoOpDrop(page, 'b', spot('b', 'after'))).toBe(true);
  });

  it('is a no-op when there is no spot at all', () => {
    expect(isNoOpDrop(page, 'b', null)).toBe(true);
  });

  it('is a real move anywhere else', () => {
    expect(isNoOpDrop(page, 'a', spot('c', 'after'))).toBe(false);
    expect(isNoOpDrop(page, 'c', spot('a', 'before'))).toBe(false);
  });

  /* The case this whole milestone is about, and the one document order alone
     gets WRONG: `above` sits directly before the column's first block, so by
     position this looks like a block dropped where it already is. It is not —
     it changes parent, from the page to the column. */
  it('is a real move into a column, however little the block appears to travel', () => {
    const withColumn = [
      { id: 'above', parentId: null },
      { id: 'l1', parentId: 'leftcol' },
    ];
    expect(isNoOpDrop(withColumn, 'above', spot('l1', 'before'))).toBe(false);
    expect(isNoOpDrop(withColumn, 'above', spot('l1', 'after'))).toBe(false);
  });
});
