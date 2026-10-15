import { expect, it } from 'vitest';
import { stepLive } from './navHistory';
const step = (slots: string[], index: number, dir: -1 | 1) =>
  stepLive(
    slots,
    index,
    dir,
    (slot) => slot !== 'dead',
    (a, b) => a === b,
  );
it('drops dead slots, collapses adjacent equal places, and steps one live place', () => {
  expect(step(['a', 'dead', 'a', 'b', 'c'], 4, -1)).toEqual({
    slots: ['a', 'b', 'c'],
    index: 1,
    moved: true,
  });
  expect(step(['a', 'dead', 'a', 'b', 'c'], 3, -1)).toEqual({
    slots: ['a', 'b', 'c'],
    index: 0,
    moved: true,
  });
  expect(step(['a', 'dead', 'a', 'b', 'c'], 0, 1)).toEqual({
    slots: ['a', 'b', 'c'],
    index: 1,
    moved: true,
  });
});
it('a deleted current place is a gap, and end presses do not claim a move', () => {
  expect(step(['a', 'dead', 'b'], 1, -1)).toEqual({ slots: ['a', 'b'], index: 0, moved: true });
  expect(step(['a', 'dead', 'b'], 1, 1)).toEqual({ slots: ['a', 'b'], index: 1, moved: true });
  expect(step(['dead', 'a'], 0, -1)).toEqual({ slots: ['a'], index: 0, moved: false });
  expect(step(['a', 'dead'], 1, 1)).toEqual({ slots: ['a'], index: 0, moved: false });
  expect(step(['dead'], 0, -1)).toEqual({ slots: [], index: 0, moved: false });
  expect(step([], 0, 1)).toEqual({ slots: [], index: 0, moved: false });
});
it('coalescing keeps the current slot state and leaves its next distinct place reachable', () => {
  const slots = [
    { name: 'a', state: 1 },
    { name: 'a', state: 2 },
    { name: 'b', state: 3 },
  ];
  expect(
    stepLive(
      slots,
      1,
      -1,
      () => true,
      (a, b) => a.name === b.name,
    ),
  ).toEqual({ slots: [slots[1], slots[2]], index: 0, moved: false });
  expect(
    stepLive(
      slots,
      1,
      1,
      () => true,
      (a, b) => a.name === b.name,
    ).index,
  ).toBe(1);
});

it('skips a held entry without dropping its history slot', () => {
  const slots = ['a', 'held', 'b'];
  expect(
    stepLive(
      slots,
      2,
      -1,
      () => true,
      (a, b) => a === b,
      (slot) => slot === 'held',
    ),
  ).toEqual({ slots, index: 0, moved: true });
  expect(
    stepLive(
      slots,
      0,
      1,
      () => true,
      (a, b) => a === b,
      (slot) => slot === 'held',
    ),
  ).toEqual({ slots, index: 2, moved: true });
});
