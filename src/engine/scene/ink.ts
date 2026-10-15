import { getStroke } from 'perfect-freehand';
import { MAX_INK_POINTS, MAX_INK_SIZE } from './limits';
import type { Box, InkStroke } from './model';

/**
 * Ink strokes (M68.1): the one file that loads perfect-freehand. A stroke's
 * points are flat whole-number triples, x and y in tenths of a unit from its
 * box's top-left corner and pressure in thousandths (model.ts). Outlines are
 * in board units and cached by stroke identity, so a stroke that has not
 * changed is never outlined twice.
 */

/** Tenths of a unit per point coordinate, thousandths per pressure. */
const COORD_SCALE = 10;
const PRESSURE_SCALE = 1000;

export interface Outline {
  /** The filled polygon around the stroke, in board units. */
  readonly polygon: readonly (readonly [number, number])[];
  /** The polygon as an SVG path, coordinates to two decimals. */
  readonly path: string;
  /** The polygon's bounds; a zero box for a stroke with no outline. */
  readonly bounds: Box;
}

const outlines = new WeakMap<InkStroke, Outline>();

/** The stroke's samples as board-unit points with a 0–1 pressure. */
function samples(stroke: InkStroke): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i + 2 < stroke.points.length; i += 3) {
    out.push([
      stroke.x + stroke.points[i] / COORD_SCALE,
      stroke.y + stroke.points[i + 1] / COORD_SCALE,
      stroke.points[i + 2] / PRESSURE_SCALE,
    ]);
  }
  return out;
}

function fixed(n: number): string {
  const s = n.toFixed(2);
  return s === '-0.00' ? '0.00' : s;
}

/** The stroke's outline. One sample draws a dot. */
export function strokeOutline(stroke: InkStroke): Outline {
  const cached = outlines.get(stroke);
  if (cached !== undefined) return cached;
  const polygon = getStroke(samples(stroke), {
    size: stroke.size,
    thinning: 0.5,
    smoothing: 0.65,
    streamline: 0.6,
    simulatePressure: stroke.simulated,
    last: true,
  }).map(([x, y]) => [x, y] as const);
  let path = '';
  let bounds: Box = { x: stroke.x, y: stroke.y, width: 0, height: 0 };
  if (polygon.length > 0) {
    path = `M${polygon.map(([x, y]) => `${fixed(x)} ${fixed(y)}`).join('L')}Z`;
    const xs = polygon.map(([x]) => x);
    const ys = polygon.map(([, y]) => y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    bounds = { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
  }
  const outline: Outline = { polygon, path, bounds };
  outlines.set(stroke, outline);
  return outline;
}

function segmentDistance(
  p: { x: number; y: number },
  a: readonly number[],
  b: readonly number[],
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t =
    length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / length2));
  return Math.hypot(p.x - (a[0] + t * dx), p.y - (a[1] + t * dy));
}

/** Whether `point` (board units) lies within `tolerance` of the stroke's ink. */
export function inkContains(
  stroke: InkStroke,
  point: { readonly x: number; readonly y: number },
  tolerance: number,
): boolean {
  const reach = stroke.size / 2 + Math.max(0, tolerance);
  const line = samples(stroke);
  if (line.length === 0) return false;
  if (line.length === 1) return segmentDistance(point, line[0], line[0]) <= reach;
  for (let i = 1; i < line.length; i += 1) {
    if (segmentDistance(point, line[i - 1], line[i]) <= reach) return true;
  }
  return false;
}

/**
 * The stroke fitted to `box`: its points scale with the box, keeping the
 * sample count, whole numbers and the pressures. `box` must be whole numbers
 * with a width and height of at least 1 (checkSet holds that).
 */
export function scaleStroke(stroke: InkStroke, box: Box): InkStroke {
  const sx = box.width / stroke.width;
  const sy = box.height / stroke.height;
  const points = stroke.points.map((value, i) => {
    if (i % 3 === 0) return Math.round(value * sx);
    if (i % 3 === 1) return Math.round(value * sy);
    return value;
  });
  return { ...stroke, x: box.x, y: box.y, width: box.width, height: box.height, points };
}

/**
 * What is wrong with a stroke's points and size, in words, or null. Points
 * are whole-number triples inside the box with a pressure of 0–1000, at
 * least one sample and at most MAX_INK_POINTS; the size is 1–MAX_INK_SIZE.
 */
export function inkProblem(stroke: InkStroke): string | null {
  const { points, size } = stroke;
  if (!Number.isInteger(size) || size < 1 || size > MAX_INK_SIZE) {
    return `its size must be a whole number from 1 to ${MAX_INK_SIZE}`;
  }
  if (typeof stroke.simulated !== 'boolean') return 'simulated must be true or false';
  if (!Array.isArray(points) || points.length === 0 || points.length % 3 !== 0) {
    return 'its points must be x, y and pressure triples, at least one';
  }
  if (points.length / 3 > MAX_INK_POINTS) {
    return `it has ${points.length / 3} samples; the limit is ${MAX_INK_POINTS}`;
  }
  const maxX = stroke.width * COORD_SCALE;
  const maxY = stroke.height * COORD_SCALE;
  for (let i = 0; i < points.length; i += 3) {
    const [x, y, p] = [points[i], points[i + 1], points[i + 2]];
    if (![x, y, p].every((v) => Number.isInteger(v))) {
      return `sample ${i / 3 + 1} must be whole numbers`;
    }
    if (x < 0 || x > maxX || y < 0 || y > maxY) {
      return `sample ${i / 3 + 1} lies outside the stroke's box`;
    }
    if (p < 0 || p > PRESSURE_SCALE) {
      return `sample ${i / 3 + 1} has pressure ${p}; pressure runs from 0 to ${PRESSURE_SCALE}`;
    }
  }
  return null;
}
