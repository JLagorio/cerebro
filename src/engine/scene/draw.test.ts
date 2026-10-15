import { expect, it } from 'vitest';
import { appendSamples, boxFromDrag, defaultBox, isTap, strokeFromSamples } from './draw';
import { MAX_INK_POINTS } from './limits';
import { inkProblem } from './ink';
it('draws whole boxes in any direction, with square and centre modifiers', () => {
  expect(boxFromDrag({ x: 100, y: 100 }, { x: 60, y: 80 })).toEqual({
    x: 60,
    y: 80,
    width: 40,
    height: 20,
  });
  expect(boxFromDrag({ x: 100, y: 100 }, { x: 140, y: 120 }, { square: true })).toEqual({
    x: 100,
    y: 100,
    width: 40,
    height: 40,
  });
  expect(
    boxFromDrag({ x: 100, y: 100 }, { x: 140, y: 120 }, { square: true, fromCenter: true }),
  ).toEqual({ x: 60, y: 60, width: 80, height: 80 });
  expect(boxFromDrag({ x: 0.2, y: 0.2 }, { x: 1, y: 1 })).toEqual({
    x: 0,
    y: 0,
    width: 20,
    height: 20,
  });
});
it('taps use screen distance and take the tool-specific default box', () => {
  expect(isTap({ x: 0, y: 0 }, { x: 2, y: 1 })).toBe(true);
  expect(isTap({ x: 0, y: 0 }, { x: 3, y: 0 })).toBe(false);
  expect(defaultBox({ x: 100, y: 100 }, 'shape')).toEqual({
    x: 20,
    y: 50,
    width: 160,
    height: 100,
  });
  expect(defaultBox({ x: 100, y: 100 }, 'text')).toEqual({
    x: 100,
    y: 100,
    width: 250,
    height: 60,
  });
});
it('samples drop exact repeats, keep pressure, and stop at the scene cap', () => {
  const first = { x: 1, y: 2, pressure: 0.2 };
  expect(appendSamples([first], [first, { ...first, pressure: 0.7 }])).toHaveLength(2);
  expect(
    appendSamples(
      [],
      Array.from({ length: MAX_INK_POINTS + 10 }, (_, x) => ({ x, y: 0, pressure: 0.5 })),
    ),
  ).toHaveLength(MAX_INK_POINTS);
  const stroke = strokeFromSamples(
    [
      { x: -1.25, y: 2.5, pressure: 0.2 },
      { x: 10.15, y: 5.15, pressure: 0.83 },
    ],
    false,
  )!;
  expect(stroke.points).toEqual([8, 5, 200, 122, 32, 830]);
  expect(inkProblem({ ...stroke, id: 'a', z: 'a0' })).toBeNull();
  expect(strokeFromSamples([{ x: 1, y: 2, pressure: 0.5 }], true)).toMatchObject({
    width: 1,
    height: 1,
    points: [0, 0, 500],
    simulated: true,
  });
  expect(strokeFromSamples([], true)).toBeNull();
});
