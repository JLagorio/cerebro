import { createElement } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEntry } from '@/engine/testHelpers';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import type { StoredLayout } from '@/engine/paneLayout';
import { PaneLayoutHost } from './LastPlaceHost';
import { rememberLastPlace, LAST_PLACE_KEY } from './lastPlace';
import { __resetDeepLinks, primeDeepLinks } from './deepLinks';
import { PANE_LAYOUT_KEY, readPaneLayout } from './paneLayoutPersistence';
const two: StoredLayout = {
  v: 1,
  active: 0,
  panes: [
    { index: 0, entries: [{ kind: 'doc', path: 'a.md' }] },
    { index: 0, entries: [{ kind: 'doc', path: 'b.md' }] },
  ],
};
const save = (vault = '/a', layout = two) =>
  window.localStorage.setItem(PANE_LAYOUT_KEY, JSON.stringify({ [vault]: layout }));
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
beforeEach(async () => {
  vi.restoreAllMocks();
  __resetDeepLinks();
  window.localStorage.removeItem(PANE_LAYOUT_KEY);
  window.localStorage.removeItem(LAST_PLACE_KEY);
  useNavStore.getState().reset();
  useNavStore.getState().setPaneCapacity(4);
  ready();
  await primeDeepLinks();
});
afterEach(() => {
  cleanup();
  __resetDeepLinks();
  vi.restoreAllMocks();
});
describe('pane layout restore lifecycle', () => {
  it('restores an unscanned attachment and remaps its saved folder', () => {
    const selection = { kind: 'file', path: 'attachments/brief.pdf' } as const;
    save('/a', { v: 1, active: 0, panes: [{ index: 0, entries: [selection] }] });
    render(createElement(PaneLayoutHost));
    expect(useNavStore.getState().selection).toEqual(selection);
    act(() => useNavStore.getState().replacePath('attachments', 'assets'));
    expect(useNavStore.getState().selection).toEqual({ kind: 'file', path: 'assets/brief.pdf' });
    expect(readPaneLayout('/a')?.panes[0].entries[0]).toEqual({
      kind: 'file',
      path: 'assets/brief.pdf',
    });
  });
  it('waits for readiness without overwriting stored panes, and restores once per open', () => {
    save();
    rememberLastPlace('/a', { kind: 'settings' });
    useVaultStore.setState({ status: 'scanning' });
    render(createElement(PaneLayoutHost));
    expect(readPaneLayout('/a')).toEqual(two);
    expect(useNavStore.getState().paneIds).toHaveLength(1);
    act(() => ready());
    const ids = useNavStore.getState().paneIds;
    expect(ids).toHaveLength(2);
    expect(useNavStore.getState().active).toBe(ids[0]);
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'a.md' });
    act(() => useNavStore.getState().focusPane(ids[1]));
    expect(readPaneLayout('/a')?.active).toBe(1);
    act(() => ready());
    expect(useNavStore.getState().paneIds).toEqual(ids);
    expect(useNavStore.getState().active).toBe(ids[1]);
  });
  it('never saves vault A’s panes under B while B is opening', () => {
    save();
    render(createElement(PaneLayoutHost));
    act(() => useVaultStore.setState({ vaultPath: '/b', status: 'scanning' }));
    expect(readPaneLayout('/b')).toBeNull();
    expect(readPaneLayout('/a')).toEqual(two);
    act(() => ready('/b'));
    expect(readPaneLayout('/b')?.panes).toEqual([{ index: 0, entries: [{ kind: 'home' }] }]);
    act(() => ready('/a'));
    expect(useNavStore.getState().paneIds).toHaveLength(2);
  });
  it('drops dead saved panes, then falls back to last place and Home', () => {
    save('/a', {
      v: 1,
      active: 0,
      panes: [{ index: 0, entries: [{ kind: 'doc', path: 'gone.md' }] }],
    });
    rememberLastPlace('/a', { kind: 'settings' });
    render(createElement(PaneLayoutHost));
    expect(useNavStore.getState().selection).toEqual({ kind: 'settings' });
    act(() => ready('/b'));
    expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
  });
  it('keeps a person’s navigation made during startup and never restores overlays', () => {
    save();
    useVaultStore.setState({ status: 'scanning' });
    render(createElement(PaneLayoutHost));
    act(() => useNavStore.getState().navigate({ kind: 'settings' }));
    act(() => ready());
    expect(useNavStore.getState().selection).toEqual({ kind: 'settings' });
    expect(useNavStore.getState().paneIds).toHaveLength(1);
    expect(useUiStore.getState().detailPath).toBeNull();
  });
  it('pending deep links take priority and do not restore the saved panes', async () => {
    save();
    window.__cerebroDeepLink?.({ kind: 'open', path: 'a.md', vault: null });
    render(createElement(PaneLayoutHost));
    expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
    expect(useNavStore.getState().paneIds).toHaveLength(1);
    expect(readPaneLayout('/a')).toEqual(two);
  });
  it('storage failure is silent and cannot prevent the current session', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    expect(() => render(createElement(PaneLayoutHost))).not.toThrow();
    act(() => useNavStore.getState().navigate({ kind: 'settings' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'settings' });
  });
});

it('does not rewrite the stored layout for visit scroll or search changes', () => {
  render(createElement(PaneLayoutHost));
  const write = vi.spyOn(window.localStorage, 'setItem');
  act(() => useNavStore.getState().setEntryState('view.search', 'find me'));
  act(() => useNavStore.getState().setEntryState('canvas.scroll', 250));
  expect(write).not.toHaveBeenCalled();
});
