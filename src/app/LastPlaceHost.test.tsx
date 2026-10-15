import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { makeEntry } from '@/engine/testHelpers';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { LastPlaceHost } from './LastPlaceHost';
import { PANE_LAYOUT_KEY } from './paneLayoutPersistence';
import { LAST_PLACE_KEY, readLastPlace, rememberLastPlace } from './lastPlace';
const ready = (vault = '/a') =>
  useVaultStore.setState({
    vaultPath: vault,
    entriesVault: vault,
    status: 'ready',
    entries: [makeEntry({ path: 'a.md' }), makeEntry({ path: 'b.md' })],
    views: [],
    collections: [],
    folders: [],
  });
beforeEach(() => {
  window.localStorage.removeItem(LAST_PLACE_KEY);
  window.localStorage.removeItem(PANE_LAYOUT_KEY);
  useNavStore.getState().setLiveCheck(null);
  useNavStore.getState().reset();
  useUiStore.setState({ toasts: [], detailPath: null });
  ready();
});
afterEach(cleanup);
it('restores with replace after readiness and remembers later navigation', () => {
  rememberLastPlace('/a', { kind: 'doc', path: 'a.md' });
  useVaultStore.setState({ status: 'scanning' });
  render(<LastPlaceHost />);
  expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
  expect(readLastPlace('/a')).toEqual({ kind: 'doc', path: 'a.md' });
  act(() => ready());
  expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'a.md' });
  expect(useNavStore.getState().history).toHaveLength(1);
  act(() => useNavStore.getState().navigate({ kind: 'doc', path: 'b.md' }));
  expect(readLastPlace('/a')).toEqual({ kind: 'doc', path: 'b.md' });
});
it('a person who moved while the scan ran keeps their place', () => {
  rememberLastPlace('/a', { kind: 'doc', path: 'a.md' });
  useVaultStore.setState({ status: 'scanning' });
  render(<LastPlaceHost />);
  act(() => useNavStore.getState().navigate({ kind: 'settings' }));
  expect(readLastPlace('/a')).toEqual({ kind: 'doc', path: 'a.md' });
  act(() => ready());
  expect(useNavStore.getState().selection).toEqual({ kind: 'settings' });
  expect(readLastPlace('/a')).toEqual({ kind: 'settings' });
});
it('a dead place is forgotten silently and a new vault resets and restores its own history', () => {
  rememberLastPlace('/a', { kind: 'doc', path: 'gone.md' });
  rememberLastPlace('/b', { kind: 'doc', path: 'b.md' });
  render(<LastPlaceHost />);
  expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
  expect(readLastPlace('/a')).toBeNull();
  expect(useUiStore.getState().toasts).toEqual([]);
  act(() => useNavStore.getState().navigate({ kind: 'settings' }));
  act(() => useVaultStore.setState({ vaultPath: '/b', status: 'scanning' }));
  expect(useNavStore.getState().history).toHaveLength(1);
  expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
  act(() => ready('/b'));
  expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'b.md' });
  expect(useNavStore.getState().history).toHaveLength(1);
  act(() => useVaultStore.setState({ entries: [] }));
  act(() => useNavStore.getState().navigate({ kind: 'settings' }));
  act(() => useNavStore.getState().back());
  expect(useNavStore.getState().selection).toEqual({ kind: 'settings' });
});
