import { navSeed } from '@/test/navSeed';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import * as mock from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { StarterOffer } from './StarterOffer';
const VAULT = '/demo-vault';
const messages = () => useUiStore.getState().toasts.map((t) => t.message);
beforeEach(async () => {
  mock.emptyMockVault();
  useUiStore.setState({ toasts: [] });
  await useVaultStore.getState().openVault(VAULT);
  useNavStore.setState({
    selection: { kind: 'home' },
    history: [navSeed({ kind: 'home' })],
    historyIndex: 0,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mock.resetMockFs();
});
const offer = async () => {
  render(<StarterOffer />);
  return screen.findByRole('button', { name: 'Add the starter kit' });
};
it('adds all pages, rescans, and opens Getting started', async () => {
  fireEvent.click(await offer());
  await waitFor(() =>
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'getting-started.md' }),
  );
  expect(useVaultStore.getState().entries).toHaveLength(mock.STARTER_FILES.length);
  expect(messages()).toContain('Added the starter kit');
  expect(screen.queryByTestId('starter-offer')).toBeNull();
});
it('declines and stays hidden after a remount', async () => {
  await offer();
  fireEvent.click(screen.getByRole('button', { name: 'No thanks' }));
  await waitFor(() => expect(screen.queryByTestId('starter-offer')).toBeNull());
  cleanup();
  await act(async () => {
    render(<StarterOffer />);
  });
  expect(screen.queryByTestId('starter-offer')).toBeNull();
  expect(await mock.scanVault(VAULT)).toEqual([]);
});
it('reads no marker before this vault has an empty, ready scan', async () => {
  const read = vi.spyOn(ipc, 'starterMarker');
  for (const state of [
    { status: 'scanning' as const },
    { status: 'ready' as const, entriesVault: '/other' },
    { status: 'error' as const },
  ]) {
    useVaultStore.setState(state);
    await act(async () => {
      render(<StarterOffer />);
    });
    expect(screen.queryByTestId('starter-offer')).toBeNull();
    cleanup();
  }
  expect(read).not.toHaveBeenCalled();
});
it('shows unavailable and retries a failed marker read', async () => {
  vi.spyOn(ipc, 'starterMarker').mockRejectedValueOnce(new Error('offline'));
  render(<StarterOffer />);
  expect(await screen.findByTestId('section-unavailable')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Add the starter kit' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('button', { name: 'Add the starter kit' })).toBeTruthy();
});
it('keeps the offer and toasts a failed install without throwing', async () => {
  vi.spyOn(ipc, 'installStarterKit').mockRejectedValueOnce(new Error('Could not install'));
  fireEvent.click(await offer());
  await waitFor(() => expect(messages()).toContain('Could not install'));
  expect(screen.getByRole('button', { name: 'Add the starter kit' })).toBeTruthy();
  expect(await mock.scanVault(VAULT)).toEqual([]);
});
it('reports the successful pages when only the marker save failed', async () => {
  vi.spyOn(ipc, 'installStarterKit').mockImplementationOnce(async (vault) => {
    await mock.installStarterKit(vault);
    return { marker_saved: false };
  });
  fireEvent.click(await offer());
  await waitFor(() =>
    expect(messages()).toContain(
      'Added the starter kit. Its offer marker could not be saved; the pages are safe.',
    ),
  );
});
it('disables both choices while one is in flight', async () => {
  let finish!: () => void;
  const install = vi.spyOn(ipc, 'installStarterKit').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ marker_saved: true });
      }),
  );
  const add = await offer();
  fireEvent.click(add);
  fireEvent.click(add);
  expect((add as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'No thanks' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(install).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish();
  });
});
it('does not navigate a newly selected vault after an old install finishes', async () => {
  let finish!: () => void;
  vi.spyOn(ipc, 'installStarterKit').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ marker_saved: true });
      }),
  );
  fireEvent.click(await offer());
  await act(async () => {
    useVaultStore.setState({ vaultPath: '/other' });
    finish();
  });
  expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
  expect(messages()).toEqual([]);
});
