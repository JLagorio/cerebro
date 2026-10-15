import { create } from 'zustand';
import type {
  ClientToken,
  ClientTokenRequest,
  CreatedClientToken,
  ClientAccessStatus,
} from '@/engine/clientAccess';
import * as ipc from '@/lib/ipc';
import { useUiStore } from './uiStore';
import { useVaultStore } from './vaultStore';

type ReadStatus = 'idle' | 'loading' | 'ready' | 'error';
interface State {
  vault: string | null;
  tokens: ClientToken[];
  tokensStatus: ReadStatus;
  access: ClientAccessStatus | null;
  accessStatus: ReadStatus;
  busy: boolean;
  reset(vault: string | null): void;
  load(vault: string): Promise<void>;
  refresh(vault: string): Promise<void>;
  make(request: ClientTokenRequest): Promise<CreatedClientToken | null>;
  revoke(tokenId: string): Promise<boolean>;
  setAccess(enabled: boolean, port: number): Promise<boolean>;
}
let generation = 0;
const fail = (error: unknown) =>
  useUiStore.getState().toast(String(error instanceof Error ? error.message : error));

/** Operational metadata only. A newly minted secret returns straight to the
 * mounted dialog, never through Zustand or a persistence middleware. */
export const useClientAccessStore = create<State>((set, get) => ({
  vault: null,
  tokens: [],
  tokensStatus: 'idle',
  access: null,
  accessStatus: 'idle',
  busy: false,
  reset(vault) {
    generation++;
    set({
      vault,
      tokens: [],
      tokensStatus: 'idle',
      access: null,
      accessStatus: 'idle',
      busy: false,
    });
  },
  async load(vault) {
    if (get().vault !== vault) get().reset(vault);
    if (get().tokensStatus === 'idle') await get().refresh(vault);
  },
  async refresh(vault) {
    if (get().busy && get().vault === vault) return;
    if (get().vault !== vault) get().reset(vault);
    const epoch = ++generation;
    set({ tokensStatus: 'loading', accessStatus: 'loading' });
    const [tokens, access] = await Promise.allSettled([
      ipc.clientTokens(vault),
      ipc.clientAccessStatus(),
    ]);
    if (epoch !== generation) return;
    set({
      tokens: tokens.status === 'fulfilled' ? tokens.value : [],
      tokensStatus: tokens.status === 'fulfilled' ? 'ready' : 'error',
      access: access.status === 'fulfilled' ? access.value : null,
      accessStatus: access.status === 'fulfilled' ? 'ready' : 'error',
    });
  },
  async make(request) {
    const { vault, busy } = get();
    if (!vault || busy) return null;
    const epoch = generation;
    set({ busy: true });
    try {
      const created = await ipc.createClientToken(vault, request);
      if (epoch !== generation) return null;
      set((s) => ({ tokens: [...s.tokens, created.token] }));
      return created;
    } catch (error) {
      if (epoch === generation) fail(error);
      return null;
    } finally {
      if (epoch === generation) set({ busy: false });
    }
  },
  async revoke(tokenId) {
    if (get().busy) return false;
    const epoch = generation;
    set({ busy: true });
    try {
      await ipc.revokeClientToken(tokenId);
      if (epoch !== generation) return false;
      set((s) => ({ tokens: s.tokens.filter((token) => token.tokenId !== tokenId) }));
      return true;
    } catch (error) {
      if (epoch === generation) fail(error);
      return false;
    } finally {
      if (epoch === generation) set({ busy: false });
    }
  },
  async setAccess(enabled, port) {
    if (get().busy) return false;
    const epoch = generation;
    set({ busy: true });
    try {
      const access = await ipc.setClientAccess(enabled, port);
      if (epoch !== generation) return false;
      set({ access, accessStatus: 'ready' });
      return true;
    } catch (error) {
      if (epoch === generation) fail(error);
      return false;
    } finally {
      if (epoch === generation) set({ busy: false });
    }
  },
}));

useVaultStore.subscribe((state, previous) => {
  if (state.vaultPath !== previous.vaultPath)
    useClientAccessStore.getState().reset(state.vaultPath);
});
