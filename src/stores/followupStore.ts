import { create } from 'zustand';
import type { Followup } from '@/engine/followups';
import { listFollowups, cancelFollowup } from '@/lib/ipc';
import { useUiStore } from './uiStore';
import { useVaultStore } from './vaultStore';

export type FollowupRead =
  { state: 'loading' } | { state: 'ready'; rows: Followup[] } | { state: 'unavailable' };
interface State {
  vault: string | null;
  read: FollowupRead;
  held: Record<string, number>;
  reset(vault: string | null): void;
  load(vault: string): Promise<void>;
  refresh(vault: string): Promise<void>;
  hold(id: string, until: number): void;
  cancel(id: string): Promise<boolean>;
}
let generation = 0;
let request = 0;
let pending: { vault: string; promise: Promise<void> } | null = null;
/** Operational rows, never frontmatter or a localStorage source of truth. */
export const useFollowupStore = create<State>((set, get) => ({
  vault: null,
  read: { state: 'loading' },
  held: {},
  reset(vault) {
    generation++;
    request++;
    pending = null;
    set({ vault, read: { state: 'loading' }, held: {} });
  },
  async load(vault) {
    if (get().vault !== vault) get().reset(vault);
    if (pending?.vault === vault) return pending.promise;
    if (get().read.state === 'loading') await get().refresh(vault);
  },
  async refresh(vault) {
    if (useVaultStore.getState().vaultPath !== vault) return;
    if (get().vault !== vault) get().reset(vault);
    const ticket = ++request;
    const promise = (async () => {
      try {
        const rows = await listFollowups(vault);
        if (ticket !== request || get().vault !== vault) return;
        const ids = new Set(rows.map((row) => row.followupId));
        set((state) => ({
          read: { state: 'ready', rows },
          held: Object.fromEntries(Object.entries(state.held).filter(([id]) => ids.has(id))),
        }));
      } catch {
        if (ticket === request && get().vault === vault) set({ read: { state: 'unavailable' } });
      }
    })();
    pending = { vault, promise };
    await promise;
    if (pending?.promise === promise) pending = null;
  },
  hold(id, until) {
    set((state) => ({ held: { ...state.held, [id]: until } }));
  },
  async cancel(id) {
    const vault = get().vault;
    if (vault === null) return false;
    const epoch = generation;
    try {
      const changed = await cancelFollowup(vault, id);
      if (epoch !== generation) return false;
      if (!changed) useUiStore.getState().toast('That follow-up already started or was cancelled');
      await get().refresh(vault);
      return changed;
    } catch {
      if (epoch === generation) useUiStore.getState().toast("Couldn't cancel that follow-up");
      return false;
    }
  },
}));
useVaultStore.subscribe((state, previous) => {
  if (state.vaultPath !== previous.vaultPath) useFollowupStore.getState().reset(state.vaultPath);
});

/** Unknown reads contribute no claim that an agent has a follow-up waiting. */
export function useWaitingFollowup(actor: string): boolean {
  const vault = useVaultStore((state) => state.vaultPath);
  return useFollowupStore(
    (state) =>
      state.vault === vault &&
      state.read.state === 'ready' &&
      state.read.rows.some(
        (row) => row.actor === actor && (row.state === 'pending' || row.state === 'claimed'),
      ),
  );
}
