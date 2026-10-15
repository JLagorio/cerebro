import { create } from 'zustand';
import type { Reminder } from '@/engine/reminders';
import { fireId, type ReminderFire, type SessionWindow } from '@/engine/reminderState';
import { reminderState } from '@/lib/ipc';
interface State {
  vault: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  reminders: Reminder[];
  fires: Record<string, ReminderFire>;
  window: SessionWindow | null;
  reset(vault: string | null): void;
  hydrate(vault: string): Promise<void>;
  setReminders(vault: string, reminders: Reminder[]): void;
  addFires(vault: string, fires: ReminderFire[]): void;
}
let generation = 0;
let pending: { vault: string; promise: Promise<void> } | null = null;
export const useReminderStore = create<State>((set, get) => ({
  vault: null,
  status: 'idle',
  reminders: [],
  fires: {},
  window: null,
  reset(vault) {
    generation++;
    pending = null;
    set({ vault, status: 'idle', reminders: [], fires: {}, window: null });
  },
  async hydrate(vault) {
    if (get().vault !== vault) get().reset(vault);
    if (get().status === 'ready' || get().status === 'error') return;
    if (pending?.vault === vault) return pending.promise;
    const epoch = generation;
    set({ status: 'loading' });
    const promise = (async () => {
      try {
        const result = await reminderState(vault);
        if (epoch === generation)
          set({
            status: 'ready',
            fires: Object.fromEntries(result.fires.map((f) => [fireId(f), f])),
            window: result.window,
          });
      } catch {
        if (epoch === generation) set({ status: 'error' });
      } finally {
        if (epoch === generation) pending = null;
      }
    })();
    pending = { vault, promise };
    return promise;
  },
  setReminders(vault, reminders) {
    if (get().vault === vault) set({ reminders });
  },
  addFires(vault, fires) {
    if (get().vault === vault)
      set((s) => ({
        fires: { ...s.fires, ...Object.fromEntries(fires.map((f) => [fireId(f), f])) },
      }));
  },
}));
