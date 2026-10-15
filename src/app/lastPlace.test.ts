import { beforeEach, expect, it, vi } from 'vitest';
import { useVaultStore } from '@/stores/vaultStore';
import {
  LAST_PLACE_KEY,
  forgetLastPlace,
  placeSnapshot,
  readLastPlace,
  rememberLastPlace,
} from './lastPlace';
beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.removeItem(LAST_PLACE_KEY);
});
it('keeps each vault’s useful place and drops transient thread/run identities', () => {
  rememberLastPlace('/a', { kind: 'doc', path: 'a.md', thread: 'ephemeral', tab: 'body' });
  rememberLastPlace('/b', { kind: 'knowledge', nav: { tab: 'runs', run: 'ephemeral' } });
  expect(readLastPlace('/a')).toEqual({ kind: 'doc', path: 'a.md', tab: 'body' });
  expect(readLastPlace('/b')).toEqual({ kind: 'knowledge', nav: { tab: 'runs' } });
  forgetLastPlace('/a');
  expect(readLastPlace('/a')).toBeNull();
  expect(readLastPlace('/b')).not.toBeNull();
});
it('ignores corrupt storage and survives a blocked preference store', () => {
  window.localStorage.setItem(LAST_PLACE_KEY, 'broken');
  expect(readLastPlace('/a')).toBeNull();
  window.localStorage.setItem(LAST_PLACE_KEY, JSON.stringify({ '/a': { kind: 'doc', path: 1 } }));
  expect(readLastPlace('/a')).toBeNull();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('denied');
  });
  expect(() => rememberLastPlace('/a', { kind: 'home' })).not.toThrow();
  expect(() => forgetLastPlace('/a')).not.toThrow();
});
it('does not expose another vault’s or an unreadable snapshot', () => {
  useVaultStore.setState({ vaultPath: '/a', entriesVault: '/b', status: 'ready' });
  expect(placeSnapshot()).toBeNull();
  useVaultStore.setState({ entriesVault: '/a', status: 'scanning' });
  expect(placeSnapshot()).toBeNull();
  useVaultStore.setState({ status: 'error' });
  expect(placeSnapshot()).toBeNull();
  useVaultStore.setState({ status: 'ready' });
  expect(placeSnapshot()).not.toBeNull();
});
