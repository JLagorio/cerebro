// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { CANVAS_FORMAT, CANVAS_FORMAT_PATH, CANVAS_DIGEST_PATH, parseCanvasFormat } from './format';
import type { BackgroundStyle, BoardNode, CardShape, EdgeEnd, Side } from './model';
import type { ColorPreset } from './colors';

const root = resolve(__dirname, '../../..');
it('hashes to the digest the Rust reader also asserts', () => {
  const bytes = readFileSync(resolve(root, CANVAS_FORMAT_PATH));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    readFileSync(resolve(root, CANVAS_DIGEST_PATH), 'utf8').trim(),
  );
});
it('holds every scene union to the shared vocabulary', () => {
  const nodes: Record<BoardNode['type'], true> = {
    file: true,
    group: true,
    link: true,
    text: true,
  };
  const sides: Record<Side, true> = { top: true, right: true, bottom: true, left: true };
  const ends: Record<EdgeEnd, true> = { none: true, arrow: true };
  const backgrounds: Record<BackgroundStyle, true> = { cover: true, ratio: true, repeat: true };
  const shapes: Record<Exclude<CardShape, 'rectangle'>, true> = { diamond: true, ellipse: true };
  const colors: Record<ColorPreset, true> = {
    '1': true,
    '2': true,
    '3': true,
    '4': true,
    '5': true,
    '6': true,
  };
  expect(CANVAS_FORMAT.vocab).toEqual({
    node_types: Object.keys(nodes),
    sides: Object.keys(sides),
    ends: Object.keys(ends),
    background_styles: Object.keys(backgrounds),
    shapes: Object.keys(shapes),
    color_presets: Object.keys(colors),
  });
});
it('replays the shared format refusals', () => {
  const cases: { path: string[]; value?: unknown; remove?: boolean; message: string }[] =
    JSON.parse(readFileSync(resolve(root, 'shared/canvas/format-cases.json'), 'utf8'));
  for (const c of cases) {
    const raw = JSON.parse(readFileSync(resolve(root, CANVAS_FORMAT_PATH), 'utf8')) as Record<
      string,
      unknown
    >;
    let at = raw;
    for (const key of c.path.slice(0, -1)) at = at[key] as Record<string, unknown>;
    const key = c.path.at(-1)!;
    if (c.remove) delete at[key];
    else at[key] = c.value;
    expect(() => parseCanvasFormat(raw)).toThrow(c.message);
  }
});
