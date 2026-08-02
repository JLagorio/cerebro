import { create } from 'zustand';
import type { Selection } from '@/engine/types';
import { useUiStore } from '@/stores/uiStore';

export interface NavigateOptions {
  /**
   * Keep the record panel open across this navigation.
   *
   * The ONE caller that needs it is the detail panel's own container
   * breadcrumb: it navigates to the record's Collection precisely so you can
   * read the record against its container, so closing the panel would undo the
   * thing the button exists to do. Everything else is a surface change, and a
   * record panel from another surface is not part of it.
   */
  keepDetail?: boolean;
}

interface NavState {
  selection: Selection;
  history: Selection[];
  historyIndex: number;
  navigate(sel: Selection, options?: NavigateOptions): void;
  back(): void;
  forward(): void;
}

/**
 * Surface-scoped UI state, dropped whenever the surface changes (M9.7/M15).
 *
 * An open diff belongs to the note you were reading; an open record panel
 * belongs to the table you opened it from. Carrying either across a navigation
 * shows one surface's state against another's — the record panel was following
 * users onto Docs, Inbox, Knowledge, Settings and Pulse, where it read as the
 * page content rather than as a leftover.
 *
 * Safe for opening records because `useOpenPath` navigates FIRST and calls
 * `openDetail` after, so the panel it opens is never the one closed here.
 */
function leaveSurface(keepDetail: boolean): void {
  const ui = useUiStore.getState();
  ui.closeDiff();
  if (!keepDetail) ui.closeDetail();
}

export const useNavStore = create<NavState>((set, get) => ({
  selection: { kind: 'home' },
  history: [{ kind: 'home' }],
  historyIndex: 0,

  navigate(sel, options) {
    const { history, historyIndex } = get();
    const next = [...history.slice(0, historyIndex + 1), sel];
    leaveSurface(options?.keepDetail === true);
    set({ selection: sel, history: next, historyIndex: next.length - 1 });
  },

  back() {
    const { history, historyIndex } = get();
    if (historyIndex <= 0) return;
    const index = historyIndex - 1;
    leaveSurface(false);
    set({ selection: history[index], historyIndex: index });
  },

  forward() {
    const { history, historyIndex } = get();
    if (historyIndex >= history.length - 1) return;
    const index = historyIndex + 1;
    leaveSurface(false);
    set({ selection: history[index], historyIndex: index });
  },
}));
