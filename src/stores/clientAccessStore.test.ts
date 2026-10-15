import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/ipc', { spy: true });
import * as ipc from '@/lib/ipc';
import { resetMockFs, __seedClientTokens } from '@/lib/mockIpc';
import { useUiStore } from './uiStore';
import { useVaultStore } from './vaultStore';
import { useClientAccessStore } from './clientAccessStore';
const request = { name: 'Editor', toolsets: ['read'], writeScope: [], readScope: null };
const store = () => useClientAccessStore.getState();
beforeEach(() => {
  vi.restoreAllMocks();
  resetMockFs();
  useUiStore.setState({ toasts: [] });
  useVaultStore.setState({ vaultPath: '/demo-vault' });
  store().reset('/demo-vault');
});
describe('client token metadata store', () => {
  it('keeps a created secret out of every state snapshot', async () => {
    await store().load('/demo-vault');
    const snapshots: string[] = [];
    const unsubscribe = useClientAccessStore.subscribe((value) =>
      snapshots.push(JSON.stringify(value)),
    );
    const created = await store().make(request);
    unsubscribe();
    expect(created?.secret).toMatch(/^cbr_[0-9a-f]{64}$/);
    expect(store().tokens).toHaveLength(1);
    expect(snapshots.join('')).not.toContain(created!.secret);
    expect(snapshots.join('')).not.toContain('secret');
    expect(await store().revoke(created!.token.tokenId)).toBe(true);
    expect(store().tokens).toEqual([]);
  });
  it('keeps failed token reads distinct from empty and can retry', async () => {
    __seedClientTokens(null);
    await store().load('/demo-vault');
    expect(store().tokensStatus).toBe('error');
    __seedClientTokens(0);
    await store().refresh('/demo-vault');
    expect(store().tokensStatus).toBe('ready');
  });
  it('toasts create, revoke and listener failures without throwing', async () => {
    await store().load('/demo-vault');
    vi.spyOn(ipc, 'createClientToken').mockRejectedValue(Error('create unavailable'));
    vi.spyOn(ipc, 'revokeClientToken').mockRejectedValue(Error('revoke unavailable'));
    vi.spyOn(ipc, 'setClientAccess').mockRejectedValue(Error('listener unavailable'));
    expect(await store().make(request)).toBeNull();
    expect(await store().revoke('id')).toBe(false);
    expect(await store().setAccess(true, 37421)).toBe(false);
    expect(useUiStore.getState().toasts.map((toast) => toast.message)).toEqual([
      'create unavailable',
      'revoke unavailable',
      'listener unavailable',
    ]);
    expect(store().busy).toBe(false);
  });
  it('ignores old-vault reads and drops a newly minted secret after a switch', async () => {
    let finishRead!: (value: Awaited<ReturnType<typeof ipc.clientTokens>>) => void;
    vi.spyOn(ipc, 'clientTokens').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const reading = store().load('/old');
    useVaultStore.setState({ vaultPath: '/new' });
    finishRead([]);
    await reading;
    expect(store().vault).toBe('/new');
    expect(store().tokensStatus).toBe('idle');
    await store().load('/new');
    let finish!: (value: Awaited<ReturnType<typeof ipc.createClientToken>>) => void;
    vi.spyOn(ipc, 'createClientToken').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const making = store().make(request);
    useVaultStore.setState({ vaultPath: '/third' });
    finish({
      token: {
        ...request,
        tokenId: 'id',
        vaultId: 'id',
        vaultPath: '/new',
        slug: 'editor',
        createdAt: 'now',
        lastUsedAt: null,
        currentVault: true,
      },
      secret: `cbr_${'a'.repeat(64)}`,
    });
    expect(await making).toBeNull();
    expect(store().tokens).toEqual([]);
    expect(store().busy).toBe(false);
  });
  it('does not let a refresh strand an in-flight mutation', async () => {
    await store().load('/demo-vault');
    let finish!: (value: boolean) => void;
    vi.spyOn(ipc, 'revokeClientToken').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const revoking = store().revoke('id');
    await store().refresh('/demo-vault');
    finish(true);
    await revoking;
    expect(store().busy).toBe(false);
  });
});
