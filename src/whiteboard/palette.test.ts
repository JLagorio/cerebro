import { expect, it } from 'vitest';
import { presetPaint } from './palette';
it('all six presets resolve through theme paint and strict hex stays literal', () => {
  for (let i = 1; i <= 6; i++) expect(presetPaint(String(i))).toBe(`var(--canvas-${i})`);
  expect(presetPaint('#A10bF0')).toBe('#A10bF0');
  for (const value of [undefined, 'red', '7', '#fff', 'url(x)', 'var(--x)'])
    expect(presetPaint(value)).toBeNull();
});
