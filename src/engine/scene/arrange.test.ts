import { expect, it } from 'vitest';
import { alignBoxes, distribute, type PlacedBox } from './arrange';
const boxes: PlacedBox[] = [
  { key: 'n:a', box: { x: 0, y: 10, width: 20, height: 20 } },
  { key: 'n:b', box: { x: 70, y: 70, width: 40, height: 30 } },
  { key: 'i:c', box: { x: 180, y: 160, width: 20, height: 40 } },
];
it.each(['left', 'center', 'right', 'top', 'middle', 'bottom'] as const)(
  'aligns %s to the union while preserving dimensions',
  (mode) => {
    const result = alignBoxes(boxes, mode);
    const field = ['left', 'center', 'right'].includes(mode) ? 'x' : 'y';
    const size = field === 'x' ? 'width' : 'height';
    const factors = { left: 0, center: 0.5, right: 1, top: 0, middle: 0.5, bottom: 1 };
    const anchors = result.map((i) => i.box[field] + i.box[size] * factors[mode]);
    expect(new Set(anchors).size).toBe(1);
    expect(result.map((i) => [i.box.width, i.box.height])).toEqual(
      boxes.map((i) => [i.box.width, i.box.height]),
    );
  },
);
it('distributes by equal gaps, fixes endpoints and permits overlapping boxes', () => {
  const result = distribute(boxes, 'horizontal');
  expect(result.map((i) => i.box.x)).toEqual([0, 80, 180]);
  expect(result[0]).toBe(boxes[0]);
  expect(result[2]).toBe(boxes[2]);
  const crowded = boxes.map((i, n) => ({ ...i, box: { ...i.box, x: n * 5, width: 40 } }));
  expect(distribute(crowded, 'horizontal').map((i) => i.box.x)).toEqual([0, 5, 10]);
  expect(distribute(boxes.slice(0, 2), 'horizontal')).toEqual(boxes.slice(0, 2));
  expect(boxes[1].box.x).toBe(70);
});
