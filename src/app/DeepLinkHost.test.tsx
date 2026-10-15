import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeEntry } from '@/engine/testHelpers';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { __resetDeepLinks, primeDeepLinks } from './deepLinks';
import { DeepLinkHost } from './DeepLinkHost';
import { LastPlaceHost } from './LastPlaceHost';
import { PANE_LAYOUT_KEY } from './paneLayoutPersistence';
import { LAST_PLACE_KEY, rememberLastPlace, readLastPlace } from './lastPlace';
const ready = (path = '/vault') =>
  useVaultStore.setState({
    vaultPath: path,
    entriesVault: path,
    status: 'ready',
    entries: [makeEntry({ path: 'a.md' })],
    views: [],
    collections: [],
    folders: [],
  });
const writes = () => (window as unknown as { __cerebroMockWrites: unknown[] }).__cerebroMockWrites;
const messages = () => useUiStore.getState().toasts.map((t) => t.message);
const opening = { kind: 'open', path: 'a.md', vault: null };
async function send(payload: unknown) {
  await act(async () => {
    window.__cerebroDeepLink?.(payload);
  });
}
beforeEach(async () => {
  __resetDeepLinks();
  window.localStorage.removeItem(LAST_PLACE_KEY);
  window.localStorage.removeItem(PANE_LAYOUT_KEY);
  useNavStore.getState().setLiveCheck(null);
  useNavStore.getState().reset();
  useUiStore.setState({ toasts: [], detailPath: null });
  ready();
  await primeDeepLinks();
  writes().length = 0;
});
afterEach(() => {
  cleanup();
  __resetDeepLinks();
  vi.restoreAllMocks();
});
it('waits for the first scan and opens once under StrictMode, before the last place', async () => {
  rememberLastPlace('/vault', { kind: 'settings' });
  useVaultStore.setState({ status: 'scanning', entriesVault: null });
  await send(opening);
  render(
    <StrictMode>
      <LastPlaceHost />
      <DeepLinkHost />
    </StrictMode>,
  );
  expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
  act(() => ready());
  await waitFor(() =>
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'a.md' }),
  );
  expect(useNavStore.getState().history).toHaveLength(1);
  act(() => useNavStore.getState().navigate({ kind: 'home' }));
  expect(useNavStore.getState().history).toHaveLength(2);
  expect(readLastPlace('/vault')).toEqual({ kind: 'home' });
  act(() => useNavStore.getState().back());
  expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'a.md' });
});
it('waits when no vault is open', async () => {
  useVaultStore.setState({ vaultPath: null, entriesVault: null, status: 'idle' });
  await send(opening);
  render(<DeepLinkHost />);
  expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
  act(() => ready());
  await waitFor(() =>
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'a.md' }),
  );
});
it('a missing page creates nothing', async () => {
  const before = useVaultStore.getState().entries;
  render(<DeepLinkHost />);
  await send({ ...opening, path: 'missing.md' });
  expect(messages()).toEqual(["This link points to missing.md, which isn't in this vault."]);
  expect(useVaultStore.getState().entries).toBe(before);
  expect(writes()).toEqual([]);
});
it('another vault asks first and Stay here drops the link', async () => {
  const open = vi.spyOn(useVaultStore.getState(), 'openVault');
  render(<DeepLinkHost />);
  await send({
    ...opening,
    vault: { id: '0'.repeat(32), lookup: { kind: 'found', path: '/other-vault' } },
  });
  expect(screen.getByRole('dialog', { name: 'Open another vault?' })).not.toBeNull();
  expect(screen.getByTestId('deep-link-confirm').textContent).toContain('other-vault');
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Stay here' }));
  expect(useVaultStore.getState().vaultPath).toBe('/vault');
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('an approved switch waits for its new scan and then opens the page', async () => {
  let finish!: () => void;
  vi.spyOn(useVaultStore.getState(), 'openVault').mockImplementation(async (path) => {
    useVaultStore.setState({ vaultPath: path, status: 'scanning' });
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    ready(path);
  });
  render(
    <>
      <LastPlaceHost />
      <DeepLinkHost />
    </>,
  );
  await send({
    ...opening,
    vault: { id: '0'.repeat(32), lookup: { kind: 'found', path: '/other-vault' } },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
  await act(async () => finish());
  expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'a.md' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(useNavStore.getState().history).toHaveLength(1);
});
it('the lookup words differ and refused links keep their reason', async () => {
  render(<DeepLinkHost />);
  await send({ ...opening, vault: { id: '0'.repeat(32), lookup: { kind: 'unknown' } } });
  await send({ ...opening, vault: { id: '0'.repeat(32), lookup: { kind: 'unreadable' } } });
  await send({ kind: 'refused', reason: 'it names no page' });
  expect(messages()).toEqual([
    "This link names a vault Cerebro hasn't opened on this Mac.",
    "Cerebro couldn't read its list of vaults, so this link wasn't opened.",
    "This link couldn't be opened: it names no page.",
  ]);
});
it('a delivered link writes nothing', async () => {
  render(<DeepLinkHost />);
  await send(opening);
  await send({ kind: 'go', to: 'history', database: null, view: null, vault: null });
  expect(useNavStore.getState().selection).toEqual({ kind: 'pulse' });
  expect(writes()).toEqual([]);
});

it('a live link preserves the place that was already open', async () => {
  render(<DeepLinkHost />);
  await send({ kind: 'go', to: 'history', database: null, view: null, vault: null });
  expect(useNavStore.getState().selection).toEqual({ kind: 'pulse' });
  act(() => useNavStore.getState().back());
  expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
});

it('a linked record is a page Back can return to, never a transient peek', async () => {
  useVaultStore.setState({ status: 'scanning', entriesVault: null });
  await send(opening);
  render(
    <>
      <LastPlaceHost />
      <DeepLinkHost />
    </>,
  );
  act(() =>
    useVaultStore.setState({
      status: 'ready',
      entriesVault: '/vault',
      entries: [makeEntry({ path: 'a.md', type: 'Work item' })],
    }),
  );
  expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'a.md' });
  expect(useUiStore.getState().detailPath).toBeNull();
  act(() => useNavStore.getState().navigate({ kind: 'home' }));
  act(() => useNavStore.getState().back());
  expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'a.md' });
  expect(useNavStore.getState().history).toHaveLength(2);
});
