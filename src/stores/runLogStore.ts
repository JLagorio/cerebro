import { create } from 'zustand';
import { capRunLog, parseRunLog, type RunLogEntry } from '@/engine/runLog';

/**
 * The run log's home (M53.20). engine/runLog.ts says what an entry is and why
 * the log lives in localStorage rather than in the vault; this store holds it
 * for the session and writes every change through, so the status bar's list
 * shows a run the moment it is recorded.
 *
 * Every storage call sits in try/catch: the log is a convenience, and a
 * browser that refuses storage must cost it durability, never a thrown error
 * in the run that was recording itself.
 */
const KEY = 'cerebro.runLog';

function hydrate(): RunLogEntry[] {
  try {
    // window.localStorage explicitly: the bare global is Node's experimental
    // stub under vitest and shadows jsdom's working implementation.
    return parseRunLog(window.localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

interface RunLogState {
  /** Newest first, capped by the engine. */
  entries: RunLogEntry[];
  /** Record a finished run. */
  append(entry: RunLogEntry): void;
  /** Forget every entry, in memory and in storage. */
  clear(): void;
}

export const useRunLogStore = create<RunLogState>()((set, get) => ({
  entries: hydrate(),

  append(entry) {
    const entries = capRunLog(entry, get().entries);
    set({ entries });
    try {
      window.localStorage.setItem(KEY, JSON.stringify(entries));
    } catch {
      // Storage unavailable (private mode): the entry stays for the session,
      // which is strictly better than failing the run that was trying to
      // record itself.
    }
  },

  clear() {
    set({ entries: [] });
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      // Storage unavailable: there is nothing durable to forget.
    }
  },
}));
