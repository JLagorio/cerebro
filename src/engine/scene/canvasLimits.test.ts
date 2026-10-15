// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import cases from '../../../shared/canvas/agent-limit-cases.json';
import source from '../../../shared/canvas/agent-limits.v1.json';
import { CANVAS_LIMITS, readCanvasLimits } from './canvasLimits';
it('hashes to the digest the Rust loader also asserts', () => {
  const bytes = readFileSync(resolve(__dirname, '../../../shared/canvas/agent-limits.v1.json'));
  const digest = readFileSync(
    resolve(__dirname, '../../../shared/canvas/agent-limits.v1.sha256'),
    'utf8',
  ).trim();
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest);
  expect(CANVAS_LIMITS).toEqual(source);
});
it.each(cases)('replays the shared limit cases: $name', (test) => {
  let value: unknown = structuredClone(source);
  if ('path' in test) {
    let slot = value as Record<string, unknown>;
    for (const key of test.path!.slice(0, -1)) slot = slot[key] as Record<string, unknown>;
    slot[test.path!.at(-1)!] = test.value;
  } else value = test.value;
  if ('error' in test) expect(() => readCanvasLimits(value)).toThrow(test.error);
  else expect(() => readCanvasLimits(value)).not.toThrow();
});
