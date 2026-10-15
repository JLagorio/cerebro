import { expect, it } from 'vitest';
import { clampZoom, pageNumber, stepZoom } from './zoom';
it('caps scale and clamps valid page inputs without inventing a page for invalid input', () => {
  expect(clampZoom(0.1)).toBe(0.25);
  expect(clampZoom(5)).toBe(4);
  expect(stepZoom(1, 1)).toBe(1.1);
  expect(stepZoom(1, -1)).toBe(0.91);
  expect(pageNumber('99', 40)).toBe(40);
  expect(pageNumber('0', 40)).toBe(1);
  expect(pageNumber(' 12 ', 40)).toBe(12);
  for (const input of ['', 'x', '1.2', '-3', '1e2']) expect(pageNumber(input, 40)).toBeNull();
});
