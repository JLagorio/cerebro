import { create } from 'zustand';

interface UiState {
  detailPath: string | null;
  openDetail(path: string): void;
  closeDetail(): void;
  quickOpenVisible: boolean;
  setQuickOpen(v: boolean): void;
  // File-tree expand state, persisted across sessions (M2 Task 10).
  expandedFolders: Record<string, boolean>;
  toggleFolder(path: string): void;
  // Doc outline visibility, persisted (M2 Task 15).
  docOutlineCollapsed: boolean;
  setDocOutlineCollapsed(v: boolean): void;
  // Doc properties panel visibility, persisted (M2 Task 16).
  docPropsCollapsed: boolean;
  setDocPropsCollapsed(v: boolean): void;
  toasts: { id: number; message: string }[];
  toast(message: string): void;
  dismissToast(id: number): void;
}

const EXPANDED_KEY = 'cerebro.expandedFolders';
const OUTLINE_KEY = 'cerebro.docOutlineCollapsed';

function loadExpanded(): Record<string, boolean> {
  try {
    // window.localStorage explicitly: the bare global is Node's experimental
    // stub under vitest and shadows jsdom's working implementation.
    const raw = window.localStorage.getItem(EXPANDED_KEY);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, boolean>)
      : {};
  } catch {
    return {};
  }
}

const PROPS_KEY = 'cerebro.docPropsCollapsed';

function loadFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

function storeFlag(key: string, v: boolean): void {
  try {
    window.localStorage.setItem(key, String(v));
  } catch {
    // Storage unavailable: session-only.
  }
}

let nextToastId = 1;

export const useUiStore = create<UiState>((set) => ({
  detailPath: null,
  openDetail: (path) => set({ detailPath: path }),
  closeDetail: () => set({ detailPath: null }),

  quickOpenVisible: false,
  setQuickOpen: (v) => set({ quickOpenVisible: v }),

  expandedFolders: loadExpanded(),
  toggleFolder: (path) =>
    set((s) => {
      const next = { ...s.expandedFolders, [path]: !s.expandedFolders[path] };
      try {
        window.localStorage.setItem(EXPANDED_KEY, JSON.stringify(next));
      } catch {
        // Storage unavailable (private mode): expand state stays session-only.
      }
      return { expandedFolders: next };
    }),

  docOutlineCollapsed: loadFlag(OUTLINE_KEY),
  setDocOutlineCollapsed: (v) => {
    storeFlag(OUTLINE_KEY, v);
    set({ docOutlineCollapsed: v });
  },

  docPropsCollapsed: loadFlag(PROPS_KEY),
  setDocPropsCollapsed: (v) => {
    storeFlag(PROPS_KEY, v);
    set({ docPropsCollapsed: v });
  },

  toasts: [],
  toast: (message) =>
    set((s) => ({ toasts: [...s.toasts, { id: nextToastId++, message }] })),
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
