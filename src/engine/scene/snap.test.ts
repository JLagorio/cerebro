import { expect, it } from 'vitest';
import { snapMove, snapResize } from './snap';
const box = { x: 0, y: 0, width: 100, height: 80 };
const opts = { scale: 1, grid: true, objects: true, gridSize: 24 };
it('near object lines beat the grid and emit only one guide per axis', () => {
  const result = snapMove(box, 17, 17, [{ x: 120, y: 100, width: 100, height: 80 }], opts);
  expect(result.dx).toBe(20);
  expect(result.dy).toBe(20);
  expect(result.guides.map((g) => g.axis)).toEqual(['x', 'y']);
});
it('object tolerance follows scale; grid or all snapping can be disabled', () => {
  expect(
    snapMove(box, 17, 0, [{ x: 120, y: 300, width: 100, height: 80 }], { ...opts, scale: 4 }).dx,
  ).toBe(24);
  expect(snapMove(box, 17, 11, [], { ...opts, grid: false })).toEqual({
    dx: 17,
    dy: 11,
    guides: [],
  });
  expect(snapMove(box, 17, 11, [], opts)).toEqual({ dx: 24, dy: 0, guides: [] });
});
it('resize seeks only moving edges and keeps its opposite side fixed', () => {
  const result = snapResize(box, 'e', 17, 0, [{ x: 120, y: 200, width: 100, height: 80 }], opts);
  expect(result.box).toEqual({ ...box, width: 120 });
  expect(result.guides.map((g) => g.axis)).toEqual(['x']);
  const centre = snapResize(box, 'e', 8, 0, [{ x: 110, y: 200, width: 100, height: 80 }], {
    ...opts,
    fromCenter: true,
  });
  expect(centre.box).toEqual({ x: -10, y: 0, width: 120, height: 80 });
});
