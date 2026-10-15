import { expect, it } from 'vitest';
import { handleAt, handlePoints, resizeBox, scaleBoxes } from './resize';
const box = { x: 20, y: 30, width: 100, height: 50 };
it('corners precede edge handles and their hit radius follows screen scale', () => {
  expect(handlePoints(box).map((h) => h.handle)).toEqual([
    'nw',
    'ne',
    'se',
    'sw',
    'n',
    'e',
    's',
    'w',
  ]);
  expect(handleAt(box, { x: 23, y: 33 }, 2)).toBe('nw');
  expect(handleAt(box, { x: 24, y: 34 }, 2)).toBeNull();
});
it('all eight handles keep their opposite anchor and never flip', () => {
  expect(resizeBox(box, 'se', 25, 15)).toEqual({ x: 20, y: 30, width: 125, height: 65 });
  expect(resizeBox(box, 'nw', 20, 10)).toEqual({ x: 40, y: 40, width: 80, height: 40 });
  expect(resizeBox(box, 'w', 200, 0)).toEqual({ x: 100, y: 30, width: 20, height: 50 });
  expect(resizeBox(box, 'n', 0, 200)).toEqual({ x: 20, y: 60, width: 100, height: 20 });
  expect(resizeBox(box, 'e', 30, 500)).toEqual({ x: 20, y: 30, width: 130, height: 50 });
  expect(resizeBox(box, 's', 500, 30)).toEqual({ x: 20, y: 30, width: 100, height: 80 });
  expect(resizeBox(box, 'ne', 30, -10)).toEqual({ x: 20, y: 20, width: 130, height: 60 });
  expect(resizeBox(box, 'sw', -30, 10)).toEqual({ x: -10, y: 30, width: 130, height: 60 });
});
it('ratio and centre constraints compose and give whole-number boxes', () => {
  const ratio = resizeBox(box, 'se', 50, 10, { keepRatio: true });
  expect(ratio).toEqual({ x: 20, y: 30, width: 150, height: 75 });
  const centre = resizeBox(box, 'se', 25, 10, { keepRatio: true, fromCenter: true });
  expect(centre).toEqual({ x: -5, y: 18, width: 150, height: 75 });
  expect(resizeBox(box, 'e', 10, 0, { keepRatio: true })).toEqual({
    x: 20,
    y: 28,
    width: 110,
    height: 55,
  });
});
it('scales each member relative to its original union', () => {
  expect(
    scaleBoxes(
      [
        { key: 'n:a', box },
        { key: 'i:b', box: { x: 220, y: 30, width: 100, height: 50 } },
      ],
      { x: 20, y: 30, width: 300, height: 50 },
      { x: 100, y: 50, width: 600, height: 100 },
    ),
  ).toEqual([
    { key: 'n:a', box: { x: 100, y: 50, width: 200, height: 100 } },
    { key: 'i:b', box: { x: 500, y: 50, width: 200, height: 100 } },
  ]);
});
