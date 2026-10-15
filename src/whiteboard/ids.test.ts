import { expect, it, vi } from 'vitest';
import { newBoardId } from './ids';

it('uses eight random bytes as sixteen lowercase hexadecimal characters', () => {
  const random = vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
    (array as Uint8Array).set([0, 1, 15, 16, 127, 128, 254, 255]);
    return array;
  });
  expect(newBoardId()).toBe('00010f107f80feff');
  random.mockRestore();
});
