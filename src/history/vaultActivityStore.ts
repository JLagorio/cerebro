import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { activityWindow } from '@/engine/activity';
import { vaultActivity, type HistoryActivity } from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * History's one activity read (M64.2), shared by the heatmap and the feed.
 *
 * Opening History reads once: the first section to mount starts the read,
 * every other one shares it, and a read already in flight for the vault is
 * never started twice. While History is open, a change to the vault's entries
 * (a save, a rename, an agent's write landing) re-reads a second after the
 * last change, keeping the year on screen until the new one lands. A read
 * that fails is `unavailable`, with Rust's reason, never an empty year
 * (CV-05).
 */

export type ActivityRead =
  | { kind: 'loading' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'ready'; data: HistoryActivity; today: string };

const LOADING: ActivityRead = { kind: 'loading' };

/** How long after the last entries change History reads again. */
export const REREAD_MS = 1_000;

interface ActivityState {
  vault: string | null;
  read: ActivityRead;
}

const useActivityStore = create<ActivityState>(() => ({ vault: null, read: LOADING }));

let inflight: { vault: string; promise: Promise<void> } | null = null;
let generation = 0;
let mounted = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Read the vault's year, or join the read already in flight for it. */
export function loadVaultActivity(vault: string): Promise<void> {
  if (inflight !== null && inflight.vault === vault) return inflight.promise;
  const span = activityWindow(Date.now());
  const mine = ++generation;
  const promise = vaultActivity(vault, span.since, span.until)
    .then(
      (data) => {
        if (mine !== generation) return;
        useActivityStore.setState({ vault, read: { kind: 'ready', data, today: span.today } });
      },
      (e: unknown) => {
        if (mine !== generation) return;
        const reason = e instanceof Error ? e.message : String(e);
        useActivityStore.setState({ vault, read: { kind: 'unavailable', reason } });
      },
    )
    .finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
  inflight = { vault, promise };
  return promise;
}

/** Read again `REREAD_MS` after the last call, if History is still open. */
function scheduleReread(vault: string): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (mounted > 0 && useVaultStore.getState().vaultPath === vault) void loadVaultActivity(vault);
  }, REREAD_MS);
}

/** Forget everything: for tests and the state lab. */
export function resetVaultActivity(): void {
  generation += 1;
  inflight = null;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  useActivityStore.setState({ vault: null, read: LOADING });
}

/** The open vault's activity, read when History opens and again after the
 * vault changes, and a `reload` for Retry. */
export function useVaultActivity(): { read: ActivityRead; reload: () => void } {
  const vault = useVaultStore((s) => s.vaultPath);
  const entries = useVaultStore((s) => s.entries);
  const read = useActivityStore((s) => (s.vault === vault ? s.read : LOADING));

  useEffect(() => {
    if (vault === null) return;
    mounted += 1;
    // The first section to open History starts a fresh read; a year left
    // from an earlier visit is not shown as this one.
    if (mounted === 1 || useActivityStore.getState().vault !== vault) {
      useActivityStore.setState({ vault, read: LOADING });
      void loadVaultActivity(vault);
    }
    return () => {
      mounted -= 1;
      if (mounted === 0 && timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, [vault]);

  const seen = useRef(entries);
  useEffect(() => {
    if (seen.current === entries || vault === null) return;
    seen.current = entries;
    scheduleReread(vault);
  }, [entries, vault]);

  return {
    read,
    reload: () => {
      if (vault !== null) void loadVaultActivity(vault);
    },
  };
}
