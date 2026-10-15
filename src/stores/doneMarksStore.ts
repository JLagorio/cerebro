import { create } from 'zustand';
import {
  markId,
  type DoneLane,
  type DoneMark,
  type DoneMarkInput,
  type DoneMarkResult,
} from '@/engine/reminderState';
import { doneMark, doneMarksImport, doneMarksRead, doneUnmark } from '@/lib/ipc';
import { useUiStore } from './uiStore';
interface State {
  vault: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  marks: Record<string, DoneMark>;
  reset(vault: string | null): void;
  hydrate(vault: string): Promise<void>;
  markDone(input: DoneMarkInput): Promise<DoneMark | null | false>;
  markDoneResult(
    input: DoneMarkInput,
    options?: { quiet?: boolean },
  ): Promise<DoneMarkResult | false>;
  undoDone(
    set: DoneMark,
    replaced: DoneMark | null,
    options?: { quiet?: boolean },
  ): Promise<boolean>;
  isDone(lane: DoneLane, subject: string, revision?: string): boolean;
}
let generation = 0;
let pending: { vault: string; promise: Promise<void> } | null = null;
const imported = new Set<string>();
export const useDoneMarksStore = create<State>((set, get) => ({
  vault: null,
  status: 'idle',
  marks: {},
  reset(vault) {
    generation++;
    pending = null;
    set({ vault, status: 'idle', marks: {} });
  },
  async hydrate(vault) {
    if (get().vault !== vault) get().reset(vault);
    if (get().status === 'ready' || get().status === 'error') return;
    if (pending?.vault === vault) return pending.promise;
    const epoch = generation;
    set({ status: 'loading' });
    const promise = (async () => {
      try {
        let marks = await doneMarksRead(vault);
        if (!marks.some((m) => m.lane === 'insight') && !imported.has(vault)) {
          let legacy: string[] = [];
          try {
            const value: unknown = JSON.parse(
              localStorage.getItem('cerebro.dismissedInsights') ?? '[]',
            );
            if (Array.isArray(value))
              legacy = value.filter((v): v is string => typeof v === 'string');
          } catch {
            /* The old browser key is only a best-effort migration source. */
          }
          await doneMarksImport(
            vault,
            legacy.map((subject) => ({ lane: 'insight', subject })),
          );
          if (legacy.length) marks = await doneMarksRead(vault);
          imported.add(vault);
        }
        if (epoch === generation)
          set({ status: 'ready', marks: Object.fromEntries(marks.map((m) => [markId(m), m])) });
      } catch {
        if (epoch === generation) set({ status: 'error' });
      } finally {
        if (epoch === generation) pending = null;
      }
    })();
    pending = { vault, promise };
    return promise;
  },
  async markDone(input) {
    const result = await get().markDoneResult(input);
    return result === false ? false : result.replaced;
  },
  async markDoneResult(input, options) {
    const { vault, status } = get(),
      epoch = generation;
    if (!vault || status !== 'ready') {
      if (!options?.quiet)
        useUiStore
          .getState()
          .toast('Done history could not be read. Try again after reopening this vault.');
      return false;
    }
    try {
      const result = await doneMark(vault, input);
      if (epoch === generation) {
        set((s) => ({ marks: { ...s.marks, [markId(result.set)]: result.set } }));
        if (input.lane === 'insight') useUiStore.getState().dismissInsight(input.subject);
      }
      return result;
    } catch {
      if (!options?.quiet)
        useUiStore.getState().toast('Done could not be saved. Please try again.');
      return false;
    }
  },
  async undoDone(mark, replaced, options) {
    const { vault } = get(),
      epoch = generation;
    if (!vault) return false;
    try {
      const changed = await doneUnmark(vault, mark, replaced);
      if (epoch === generation) {
        // A failed compare means another window owns a newer mark: refresh it.
        const marks = await doneMarksRead(vault);
        if (epoch === generation)
          set({ marks: Object.fromEntries(marks.map((m) => [markId(m), m])) });
        if (changed && !replaced && mark.lane === 'insight')
          useUiStore.getState().restoreInsight(mark.subject);
      }
      return changed;
    } catch {
      if (!options?.quiet)
        useUiStore.getState().toast('Undo could not be saved. Please try again.');
      return false;
    }
  },
  isDone(lane, subject, revision) {
    const mark = get().marks[markId({ lane, subject })];
    return !!mark && (mark.until === 'forever' || mark.revision === revision);
  },
}));
