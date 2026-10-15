import type { Point } from '@/engine/scene/figure';
export function panDelta(previous: Point, current: Point): Point {
  return { x: current.x - previous.x, y: current.y - previous.y };
}
