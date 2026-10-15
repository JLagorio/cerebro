import { expect, it, vi } from 'vitest';
import { readCamera, writeCamera } from './camera';
const camera = { scale: 1.5, offset: { x: -20, y: 130 } };
it('keeps the latest100 cameras and moves a rewritten key to the end', () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
  for (let i = 0; i < 100; i++) writeCamera(String(i), camera, storage);
  writeCamera('0', { ...camera, scale: 2 }, storage);
  writeCamera('100', camera, storage);
  expect(readCamera('0', storage)?.scale).toBe(2);
  expect(readCamera('1', storage)).toBeNull();
  expect(readCamera('100', storage)).toEqual(camera);
  expect(JSON.parse([...data.values()][0])).toHaveLength(100);
});
it('corrupt or unavailable storage never prevents opening or moving a board', () => {
  expect(readCamera('a', { getItem: () => '{', setItem: vi.fn() })).toBeNull();
  const throwing = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('quota');
    },
  };
  expect(readCamera('a', throwing)).toBeNull();
  expect(() => writeCamera('a', camera, throwing)).not.toThrow();
  const setItem = vi.fn();
  writeCamera('a', { ...camera, scale: 100 }, { getItem: () => null, setItem });
  expect(setItem).not.toHaveBeenCalled();
  expect(
    readCamera('a', {
      getItem: () =>
        JSON.stringify([{ key: 'a', transform: { scale: 1, offset: { x: null, y: 0 } } }]),
      setItem,
    }),
  ).toBeNull();
});
