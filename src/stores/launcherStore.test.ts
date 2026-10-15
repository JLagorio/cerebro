import { beforeEach, expect, it, vi } from 'vitest';
import { useNavStore } from './navStore';
import { useVaultStore } from './vaultStore';
import { useLauncherStore } from './launcherStore';
beforeEach(() => {
  useVaultStore.setState({ vaultPath: '/one', entriesVault: '/one', status: 'ready', entries: [] });
  useNavStore.setState({ selection: { kind: 'home' } });
  useLauncherStore.setState({ open: false, flow: null, recents: {} });
});
it('records uses per vault and moves from launcher to flow then closes it', () => {
  useLauncherStore.getState().openLauncher();
  expect(useLauncherStore.getState().open).toBe(true);
  useLauncherStore.getState().startCreate('page');
  expect(useLauncherStore.getState()).toMatchObject({
    open: false,
    flow: { id: 'page', vault: '/one' },
  });
  useLauncherStore.getState().endFlow();
  expect(useLauncherStore.getState().flow).toBeNull();
  useVaultStore.setState({ vaultPath: '/two', entriesVault: '/two' });
  useLauncherStore.getState().startCreate('database');
  expect(useLauncherStore.getState().recents).toEqual({ '/one': ['page'], '/two': ['database'] });
});
it('an unavailable preference store cannot prevent opening and creating', () => {
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  useLauncherStore.getState().openLauncher();
  useLauncherStore.getState().startCreate('page');
  expect(useLauncherStore.getState().flow?.id).toBe('page');
  write.mockRestore();
});
it('rejects unknown and unavailable rows without recording a use', () => {
  useLauncherStore.getState().startCreate('sub-page');
  useLauncherStore.getState().startCreate('retired');
  useVaultStore.setState({ status: 'scanning' });
  useLauncherStore.getState().startCreate('database');
  expect(useLauncherStore.getState()).toMatchObject({ flow: null, recents: {} });
});
