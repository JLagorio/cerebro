import { expect, it } from 'vitest';
import { nestingRefusal } from './ancestry';
it('allows eight different boards, then refuses depth and any self reference', () => {
  const chain: string[] = [];
  for (let i = 0; i < 8; i++) {
    const path = `${i}.canvas`;
    expect(nestingRefusal(chain, path)).toBeNull();
    chain.push(path);
  }
  expect(nestingRefusal(chain, '9.canvas')).toBe('depth');
  expect(nestingRefusal(chain, '0.canvas')).toBe('self');
});
