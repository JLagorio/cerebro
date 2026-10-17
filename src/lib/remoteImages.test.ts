import { beforeEach, expect, it, vi } from 'vitest';
import {
  allowRemoteImage,
  clearRemoteImages,
  remoteImageAllowed,
  subscribeRemoteImages,
} from './remoteImages';
beforeEach(clearRemoteImages);
it('remembers only the exact URL in this session, without writing storage', () => {
  const store = vi.spyOn(Storage.prototype, 'setItem');
  const notify = vi.fn();
  const remove = subscribeRemoteImages(notify);
  allowRemoteImage('https://images.example/a.png');
  expect(remoteImageAllowed('https://images.example/a.png')).toBe(true);
  expect(remoteImageAllowed('https://images.example/b.png')).toBe(false);
  expect(remoteImageAllowed('https://IMAGES.example/a.png')).toBe(false);
  expect(notify).toHaveBeenCalledOnce();
  allowRemoteImage('http://images.example/a.png');
  expect(remoteImageAllowed('http://images.example/a.png')).toBe(false);
  remove();
  clearRemoteImages();
  expect(notify).toHaveBeenCalledOnce();
  expect(store).not.toHaveBeenCalled();
  store.mockRestore();
});
