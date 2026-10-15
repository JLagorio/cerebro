import { useMemo } from 'react';
import { create } from 'zustand';
import {
  forgetOpen,
  pruneOpens,
  readOpenLogs,
  recordOpen,
  remapOpens,
  type OpenLog,
} from '@/engine/openLog';
import { recencyOf, type Recency } from '@/lib/nameRank';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The person's own page opens, per vault, on this Mac (M59.3).
 *
 * localStorage `cerebro.openLog` holds `{vault: OpenLog}`. It ranks ⌘K and
 * the name pickers, and Settings' Recently opened shows and clears it. It
 * never reaches a prompt, an MCP tool, policy or the vault: nothing outside
 * this store, the pickers and that Settings section reads it.
 *
 * Only the person's opens land here. navStore records a page navigation
 * unless it was marked `byAgent`; `useOpenPath` records the opens that are
 * not page selections (a record's panel, a Type doc, a Collection page).
 */
export const OPEN_LOG_KEY = 'cerebro.openLog';

interface OpenLogState {
  logs: Record<string, OpenLog>;
  /** False once a write failed: the session keeps its copy, and Settings says so. */
  saved: boolean;
  record(vault: string, path: string, now?: number): void;
  remap(vault: string, from: string, to: string): void;
  prune(vault: string, existing: ReadonlySet<string>): void;
  forget(vault: string, path: string): void;
  clear(vault: string): void;
}

function load(): Record<string, OpenLog> {
  try {
    // window.localStorage explicitly: the bare global is Node's experimental
    // stub under vitest and shadows jsdom's working implementation.
    const raw = window.localStorage.getItem(OPEN_LOG_KEY);
    return raw === null ? {} : readOpenLogs(JSON.parse(raw));
  } catch {
    return {};
  }
}

function persist(logs: Record<string, OpenLog>): boolean {
  try {
    window.localStorage.setItem(OPEN_LOG_KEY, JSON.stringify(logs));
    return true;
  } catch {
    return false;
  }
}

export const useOpenLogStore = create<OpenLogState>((set, get) => {
  /** Swap one vault's log; an unchanged log writes nothing. */
  const update = (vault: string, change: (log: OpenLog) => OpenLog) => {
    const { logs } = get();
    const current = logs[vault] ?? [];
    const next = change(current);
    if (next === current) return;
    const nextLogs = { ...logs };
    if (next.length === 0) delete nextLogs[vault];
    else nextLogs[vault] = next;
    // A failed write keeps the session copy: the ranking still follows this
    // session's opens, and Settings says they are not saved.
    set({ logs: nextLogs, saved: persist(nextLogs) });
  };

  return {
    logs: load(),
    saved: true,
    record: (vault, path, now = Date.now()) => update(vault, (log) => recordOpen(log, path, now)),
    remap: (vault, from, to) => update(vault, (log) => remapOpens(log, from, to)),
    prune: (vault, existing) => update(vault, (log) => pruneOpens(log, (p) => existing.has(p))),
    forget: (vault, path) =>
      update(vault, (log) => (log.some((r) => r.path === path) ? forgetOpen(log, path) : log)),
    clear: (vault) => update(vault, (log) => (log.length === 0 ? log : [])),
  };
});

/** Record the person's open of `path` in the open vault; with no vault, nothing. */
export function recordPersonOpen(path: string): void {
  const vault = useVaultStore.getState().vaultPath;
  if (vault === null || path === '') return;
  useOpenLogStore.getState().record(vault, path);
}

/**
 * Prune the open vault's log to the paths that exist, but only on a ready
 * snapshot of THIS vault: entries mid-scan, or another vault's still on
 * screen during an open, would drop history the log still needs.
 */
export function pruneOpenLogToSnapshot(): void {
  const { status, entriesVault, vaultPath, entries } = useVaultStore.getState();
  if (vaultPath === null || status !== 'ready' || entriesVault !== vaultPath) return;
  useOpenLogStore.getState().prune(vaultPath, new Set(entries.map((e) => e.path)));
}

/** The open vault's log, as the ranker reads it. */
export function useRecency(now?: number): Recency {
  const vault = useVaultStore((s) => s.vaultPath);
  const log = useOpenLogStore((s) => (vault === null ? undefined : s.logs[vault]));
  // `now` is the caller's moment (⌘K takes it when the palette opens); a
  // caller with none reads the clock when the log changes.
  return useMemo(() => recencyOf(log, now ?? Date.now()), [log, now]);
}
