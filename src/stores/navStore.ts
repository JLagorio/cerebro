import { create } from 'zustand';
import type { Selection } from '@/engine/types';

interface NavState {
  selection: Selection;
  history: Selection[];
  historyIndex: number;
  navigate(sel: Selection): void;
  back(): void;
  forward(): void;
}

export const useNavStore = create<NavState>((set, get) => ({
  selection: { kind: 'home' },
  history: [{ kind: 'home' }],
  historyIndex: 0,

  navigate(sel) {
    const { history, historyIndex } = get();
    const next = [...history.slice(0, historyIndex + 1), sel];
    set({ selection: sel, history: next, historyIndex: next.length - 1 });
  },

  back() {
    const { history, historyIndex } = get();
    if (historyIndex <= 0) return;
    const index = historyIndex - 1;
    set({ selection: history[index], historyIndex: index });
  },

  forward() {
    const { history, historyIndex } = get();
    if (historyIndex >= history.length - 1) return;
    const index = historyIndex + 1;
    set({ selection: history[index], historyIndex: index });
  },
}));
