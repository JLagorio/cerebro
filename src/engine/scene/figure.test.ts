import { expect, it } from 'vitest';
import { createBoard, EMPTY_BOARD } from './board';
import {
  arrowHead,
  edgeLabelBox,
  edgeRoute,
  facingSides,
  groupLabelBox,
  labelAnchor,
  routeSamples,
  sceneBox,
  selfLoop,
  sideAnchor,
} from './figure';
import type { BoardEdge, GroupCard, TextCard } from './model';
const box = { x: 10, y: 20, width: 100, height: 80 };
const node: TextCard = { ...box, id: 'a', type: 'text', shape: 'rectangle', text: 'A', z: 'a0' };
const edge: BoardEdge = { id: 'e', z: 'a0', fromNode: 'a', toNode: 'b' };
it('pads measured content and gives empty boards a finite centred frame', () => {
  expect(sceneBox(EMPTY_BOARD)).toEqual({ x: -400, y: -300, width: 800, height: 600 });
  expect(sceneBox(createBoard({ nodes: [node] }))).toEqual({
    x: -54,
    y: -44,
    width: 228,
    height: 208,
  });
});
it('anchors each side at its midpoint and chooses facing sides on the dominant axis', () => {
  expect(['top', 'right', 'bottom', 'left'].map((s) => sideAnchor(box, s as 'top'))).toEqual([
    { x: 60, y: 20 },
    { x: 110, y: 60 },
    { x: 60, y: 100 },
    { x: 10, y: 60 },
  ]);
  expect(facingSides(box, { ...box, x: 400 })).toEqual({ from: 'right', to: 'left' });
  expect(facingSides(box, { ...box, x: -400 })).toEqual({ from: 'left', to: 'right' });
  expect(facingSides(box, { ...box, y: -400 })).toEqual({ from: 'top', to: 'bottom' });
  expect(facingSides(box, { ...box, y: 400 })).toEqual({ from: 'bottom', to: 'top' });
});
it('honours explicit sides and bounds control-point reach at both distances', () => {
  const far = edgeRoute({ ...edge, fromSide: 'top', toSide: 'bottom' }, box, { ...box, x: 3000 });
  expect(far.from).toEqual({ x: 60, y: 20 });
  expect(far.c1).toEqual({ x: 60, y: -140 });
  expect(far.c2.y - far.to.y).toBe(160);
  const near = edgeRoute(edge, box, { ...box, x: 110 });
  expect(near.c1.x - near.from.x).toBe(24);
});
it('self loops leave right and return above; samples, labels and arrowheads share its route', () => {
  const curve = selfLoop(box);
  expect(edgeRoute({ ...edge, toNode: 'a' }, box, box)).toEqual(curve);
  expect(curve.from).toEqual(sideAnchor(box, 'right'));
  expect(curve.to).toEqual(sideAnchor(box, 'top'));
  const points = routeSamples(curve, 4);
  expect(points).toHaveLength(5);
  expect(points[0]).toEqual(curve.from);
  expect(points[4]).toEqual(curve.to);
  expect(points[2]).toEqual(labelAnchor(curve));
  expect(routeSamples(curve, 1000)).toHaveLength(257);
  expect(routeSamples(curve, 0)).toHaveLength(2);
  expect(arrowHead({ x: 10, y: 0 }, { x: 0, y: 0 }, 4)).toEqual([
    { x: 10, y: 0 },
    { x: 6, y: 2 },
    { x: 6, y: -2 },
  ]);
  const label = edgeLabelBox({ ...edge, label: 'Go' }, curve);
  expect(label.x + label.width / 2).toBe(points[2].x);
  expect(label.height).toBe(24);
  expect(
    groupLabelBox({ ...box, type: 'group', id: 'g', z: 'a0', label: 'Group' } satisfies GroupCard),
  ).toEqual({ x: 18, y: 26, width: 52, height: 24 });
});

it('the export frame contains long labels and every control/arrow point on outward and self-loop edges', () => {
  const a = { ...node, width: 800, height: 800 };
  const b = { ...node, id: 'b', y: 1200, width: 800, height: 800 };
  const edges = [
    { ...edge, fromSide: 'right' as const, toSide: 'right' as const, label: 'W'.repeat(200) },
    { ...edge, id: 'loop', toNode: 'a' },
  ];
  const board = createBoard({ nodes: [a, b], edges });
  const frame = sceneBox(board);
  const inside = (p: { x: number; y: number }) => {
    expect(p.x).toBeGreaterThanOrEqual(frame.x);
    expect(p.x).toBeLessThanOrEqual(frame.x + frame.width);
    expect(p.y).toBeGreaterThanOrEqual(frame.y);
    expect(p.y).toBeLessThanOrEqual(frame.y + frame.height);
  };
  for (const current of edges) {
    const route = edgeRoute(current, a, current.toNode === 'a' ? a : b);
    [route.from, route.c1, route.c2, route.to, ...arrowHead(route.to, route.c2)].forEach(inside);
    if (current.label) {
      const label = edgeLabelBox(current, route);
      inside(label);
      inside({ x: label.x + label.width, y: label.y + label.height });
    }
  }
  expect(frame.x).toBeLessThan(a.x - 64);
  expect(frame.x + frame.width).toBeGreaterThan(a.x + a.width + 160);
});
it('tiny group labels have no room to paint beyond their group', () => {
  const label = groupLabelBox({
    id: 'tiny',
    type: 'group',
    z: 'a0',
    x: 0,
    y: 0,
    width: 4,
    height: 4,
    label: 'Long label',
  });
  expect(label.width).toBe(0);
  expect(label.height).toBe(0);
});
