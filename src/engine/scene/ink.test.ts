import { describe, expect, it } from 'vitest';
import { EMPTY_BOARD, checkSet, createBoard } from './board';
import { inkContains, scaleStroke, strokeOutline } from './ink';
import { MAX_INK_POINTS } from './limits';
import type { InkStroke } from './model';

function stroke(over: Partial<InkStroke> = {}): InkStroke {
  return {
    id: 's1',
    z: 'a0',
    x: 100,
    y: 200,
    width: 40,
    height: 20,
    // (0,0) → (20,10) → (40,20) in board units, at half pressure.
    points: [0, 0, 500, 200, 100, 500, 400, 200, 500],
    size: 8,
    simulated: false,
    ...over,
  };
}

const refusalFor = (s: InkStroke) => checkSet(EMPTY_BOARD, createBoard({ ink: [s] }));

describe('strokeOutline', () => {
  it('outlines one sample as a dot around it', () => {
    const { polygon, bounds, path } = strokeOutline(stroke({ points: [100, 50, 500] }));
    expect(polygon.length).toBeGreaterThan(8);
    // The dot sits on (110, 205) and is about the stroke's size across.
    expect(bounds.x + bounds.width / 2).toBeCloseTo(110, 0);
    expect(bounds.y + bounds.height / 2).toBeCloseTo(205, 0);
    expect(bounds.width).toBeGreaterThan(4);
    expect(bounds.width).toBeLessThanOrEqual(10);
    expect(path).toMatch(/^M[\d.]+ [\d.]+L.*Z$/);
  });

  it('outlines many samples as a polygon along the line', () => {
    const { bounds } = strokeOutline(stroke());
    expect(bounds.x).toBeLessThan(101);
    expect(bounds.x + bounds.width).toBeGreaterThan(139);
    expect(bounds.y).toBeLessThan(201);
    expect(bounds.y + bounds.height).toBeGreaterThan(219);
  });

  it('caches the outline by stroke identity', () => {
    const s = stroke();
    expect(strokeOutline(s)).toBe(strokeOutline(s));
    expect(strokeOutline({ ...s })).not.toBe(strokeOutline(s));
  });
});

describe('scaleStroke', () => {
  it('keeps the sample count and whole numbers', () => {
    const scaled = scaleStroke(stroke(), { x: 10, y: 10, width: 13, height: 7 });
    expect(scaled.points).toHaveLength(9);
    expect(scaled.points.every(Number.isInteger)).toBe(true);
    expect(scaled.points).toEqual([0, 0, 500, 65, 35, 500, 130, 70, 500]);
    expect([scaled.x, scaled.y, scaled.width, scaled.height]).toEqual([10, 10, 13, 7]);
    expect(refusalFor(scaled)).toBeNull();
  });
});

describe('inkContains', () => {
  it('hits on the stroke and misses beside it', () => {
    const s = stroke();
    expect(inkContains(s, { x: 120, y: 210 }, 0)).toBe(true);
    expect(inkContains(s, { x: 123, y: 210 }, 0)).toBe(true);
    expect(inkContains(s, { x: 120, y: 230 }, 0)).toBe(false);
    expect(inkContains(s, { x: 120, y: 230 }, 20)).toBe(true);
    expect(inkContains(stroke({ points: [0, 0, 500] }), { x: 102, y: 202 }, 0)).toBe(true);
  });
});

describe('checkSet on ink', () => {
  it('takes a stroke within its caps', () => {
    expect(refusalFor(stroke())).toBeNull();
  });

  it(`refuses ${MAX_INK_POINTS + 1} samples`, () => {
    const points = Array.from({ length: (MAX_INK_POINTS + 1) * 3 }, (_, i) =>
      i % 3 === 2 ? 500 : 0,
    );
    expect(refusalFor(stroke({ points }))).toMatchObject({ code: 'ink' });
    expect(refusalFor(stroke({ points: points.slice(3) }))).toBeNull();
  });

  it('refuses a pressure over 1000, fractions, points outside the box and a bad size', () => {
    expect(refusalFor(stroke({ points: [0, 0, 1001] }))?.message).toContain('pressure 1001');
    expect(refusalFor(stroke({ points: [0.5, 0, 500] }))?.code).toBe('ink');
    expect(refusalFor(stroke({ points: [401, 0, 500] }))?.message).toContain('outside');
    expect(refusalFor(stroke({ points: [0, 0] }))?.code).toBe('ink');
    expect(refusalFor(stroke({ points: [] }))?.code).toBe('ink');
    expect(refusalFor(stroke({ size: 0 }))?.code).toBe('ink');
    expect(refusalFor(stroke({ size: 65 }))?.code).toBe('ink');
  });
});
