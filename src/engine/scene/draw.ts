import type { Point } from './figure';
import { MAX_INK_POINTS } from './limits';
import type { Box, NewStroke } from './model';

export interface DrawOptions {
  square?: boolean;
  fromCenter?: boolean;
}
export function boxFromDrag(start: Point, end: Point, options: DrawOptions = {}): Box {
  const signX = end.x < start.x ? -1 : 1,
    signY = end.y < start.y ? -1 : 1;
  let dx = Math.abs(end.x - start.x),
    dy = Math.abs(end.y - start.y);
  if (options.square) dx = dy = Math.max(dx, dy);
  const factor = options.fromCenter ? 2 : 1;
  const width = Math.max(20, Math.round(dx * factor)),
    height = Math.max(20, Math.round(dy * factor));
  return {
    x: Math.round(start.x - (options.fromCenter ? width / 2 : signX < 0 ? width : 0)),
    y: Math.round(start.y - (options.fromCenter ? height / 2 : signY < 0 ? height : 0)),
    width,
    height,
  };
}
export function defaultBox(point: Point, kind: 'shape' | 'text'): Box {
  return kind === 'shape'
    ? { x: Math.round(point.x - 80), y: Math.round(point.y - 50), width: 160, height: 100 }
    : { x: Math.round(point.x), y: Math.round(point.y), width: 250, height: 60 };
}
export const isTap = (start: Point, end: Point): boolean =>
  Math.hypot(end.x - start.x, end.y - start.y) < 3;
export interface DrawSample extends Point {
  pressure: number;
}
/** Samples are capped before normalization, including coalesced pointer batches. */
export function appendSamples(
  samples: readonly DrawSample[],
  added: readonly DrawSample[],
): DrawSample[] {
  const next = [...samples];
  for (const sample of added) {
    if (next.length >= MAX_INK_POINTS) break;
    if (![sample.x, sample.y, sample.pressure].every(Number.isFinite)) continue;
    const last = next.at(-1);
    if (last && last.x === sample.x && last.y === sample.y && last.pressure === sample.pressure)
      continue;
    next.push({ ...sample, pressure: Math.max(0, Math.min(1, sample.pressure)) });
  }
  return next;
}
/** Keep pressure; disk coordinates are tenths relative to an integer box. */
export function strokeFromSamples(
  samples: readonly DrawSample[],
  simulated: boolean,
  size = 4,
): NewStroke | null {
  if (samples.length === 0) return null;
  const x = Math.floor(Math.min(...samples.map((sample) => sample.x))),
    y = Math.floor(Math.min(...samples.map((sample) => sample.y)));
  const width = Math.max(1, Math.ceil(Math.max(...samples.map((sample) => sample.x))) - x),
    height = Math.max(1, Math.ceil(Math.max(...samples.map((sample) => sample.y))) - y);
  return {
    x,
    y,
    width,
    height,
    simulated,
    size,
    points: samples.flatMap((sample) => [
      Math.round((sample.x - x) * 10),
      Math.round((sample.y - y) * 10),
      Math.round(sample.pressure * 1000),
    ]),
  };
}
