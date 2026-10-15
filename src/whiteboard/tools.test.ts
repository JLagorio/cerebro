import { expect, it } from 'vitest';
import { BOARD_TOOLS, staysActive } from './tools';
it('tool keys are unique and reserve chord leaders', () => {
  expect(new Set(BOARD_TOOLS.map((t) => t.key)).size).toBe(BOARD_TOOLS.length);
  expect(BOARD_TOOLS.some((t) => (['g', 'c'] as string[]).includes(t.key))).toBe(false);
  expect(BOARD_TOOLS.filter((t) => staysActive(t.id)).map((t) => t.id)).toEqual([
    'select',
    'hand',
    'pencil',
    'eraser',
  ]);
});
