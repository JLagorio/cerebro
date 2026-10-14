import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type {
  ConflictMode,
  GitCommit,
  GitRemoteStatus,
  ModifiedFile,
  VaultPulse,
} from '@/engine/git';
import { syncState, type SyncState } from '@/engine/git';
import * as git from '@/lib/gitIpc';
import { ledgerHead } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * Git state for the current vault (M9.4).
 *
 * Everything keys on `vaultPath` and resets when it changes — `openVault`
 * swaps the whole corpus, and the new vault may not be a repository at all.
 * Holding stale ahead/behind counts across that switch would report another
 * repository's state as this one's.
 */
export interface GitState {
  ready: boolean;
  isRepo: boolean;
  modified: ModifiedFile[];
  conflicts: string[];
  conflictMode: ConflictMode;
  remote: GitRemoteStatus | null;
  sync: SyncState;
  refresh: () => Promise<void>;
}

type GitSnapshot = Omit<GitState, 'sync' | 'refresh'>;

const EMPTY: GitSnapshot = {
  ready: false,
  isRepo: false,
  modified: [],
  conflicts: [],
  conflictMode: 'none',
  remote: null,
};

/**
 * ONE git state for the whole app (M15).
 *
 * `useGit` used to be a plain hook holding its own `useState`, fetched once in
 * an effect keyed on `vaultPath`. Six call sites therefore held six
 * independent, never-refreshed copies: the status bar read "No changes" while
 * the Changes page listed five, and the Commit affordance — gated on a count
 * that never moved — stayed invisible for the rest of the session. A store
 * makes disagreement impossible, and a store can be refreshed from one place.
 */
const useGitStore = create<GitSnapshot>(() => EMPTY);

/** Newer reads win: two overlapping probes must not land out of order. */
let seq = 0;
/** The vault the snapshot describes; `undefined` = nothing read yet. */
let described: string | null | undefined;

export async function refreshGit(): Promise<void> {
  const vaultPath = useVaultStore.getState().vaultPath;
  const mine = ++seq;
  const commit = (patch: Partial<GitSnapshot>): void => {
    if (mine !== seq) return;
    useGitStore.setState({ ...patch, ready: true });
  };
  if (vaultPath === null) {
    commit({ ...EMPTY });
    return;
  }
  try {
    const repo = await git.isGitRepo(vaultPath);
    if (!repo) {
      commit({ ...EMPTY, isRepo: false });
      return;
    }
    const [files, conflicted, mode, remoteStatus] = await Promise.all([
      git.getModifiedFiles(vaultPath),
      git.getConflictFiles(vaultPath),
      git.getConflictMode(vaultPath),
      git.gitRemoteStatus(vaultPath),
    ]);
    commit({
      isRepo: true,
      modified: files,
      conflicts: conflicted,
      conflictMode: mode,
      remote: remoteStatus.hasRemote ? remoteStatus : null,
    });
  } catch {
    // A git probe failing must never take the app down with it — the vault
    // is still perfectly usable as plain files.
    commit({ ...EMPTY, isRepo: false });
  }
}

/**
 * How the shared state stays honest without anyone remembering to refresh it.
 *
 * Three triggers, because they catch different things: the vault's entries
 * changing (a save, a rescan, an agent write), coming back to the window, and
 * a slow poll for what happens outside the app while the window is in view —
 * a terminal commit, a `git pull` in another tool.
 *
 * The poll sleeps while the window is hidden (M53.13). The shell turns
 * WebKit's background throttling off, so a hidden window's timers keep
 * running, and an awake poll would spawn about ten git processes every 20 s
 * for a state nothing hidden shows. Coming back re-reads it. The entries
 * trigger stays awake: rescans and agent writes still land while hidden.
 */
const POLL_MS = 20_000;
const SETTLE_MS = 700;

let watchers = 0;
let poll: number | null = null;
let settle: number | null = null;
let unsubscribeVault: (() => void) | null = null;
let lastEntries: unknown;

function refreshSoon(): void {
  if (settle !== null) window.clearTimeout(settle);
  settle = window.setTimeout(() => {
    settle = null;
    void refreshGit();
  }, SETTLE_MS);
}

const onVisible = (): void => {
  if (document.visibilityState === 'visible') void refreshGit();
};

const onPoll = (): void => {
  // Only `hidden` sleeps: a jsdom that is not pretending to be visual says
  // `prerender`, and that must keep polling.
  if (document.visibilityState !== 'hidden') void refreshGit();
};

function attach(): void {
  watchers += 1;
  if (watchers > 1) return;
  lastEntries = useVaultStore.getState().entries;
  unsubscribeVault = useVaultStore.subscribe((s) => {
    if (s.entries === lastEntries) return;
    lastEntries = s.entries;
    refreshSoon();
  });
  poll = window.setInterval(onPoll, POLL_MS);
  document.addEventListener('visibilitychange', onVisible);
}

function detach(): void {
  watchers -= 1;
  if (watchers > 0) return;
  unsubscribeVault?.();
  unsubscribeVault = null;
  if (poll !== null) window.clearInterval(poll);
  poll = null;
  if (settle !== null) window.clearTimeout(settle);
  settle = null;
  document.removeEventListener('visibilitychange', onVisible);
}

export function useGit(): GitState {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const snapshot = useGitStore();

  useEffect(() => {
    attach();
    return detach;
  }, []);

  useEffect(() => {
    // Guarded on the module's own record of what was read, not on this hook's
    // render, so six mounted consumers cause ONE probe rather than six.
    if (described === vaultPath) return;
    described = vaultPath;
    useGitStore.setState({ ...EMPTY });
    void refreshGit();
  }, [vaultPath]);

  return {
    ...snapshot,
    sync: syncState(snapshot.remote, snapshot.modified.length, snapshot.conflicts.length),
    // A stable module function: callers pass it straight into effect deps.
    refresh: refreshGit,
  };
}

/** Test seam: forget what the shared state describes, so the next mount reads
 * again. Nothing in the app needs it — a vault change is detected on its own. */
export function resetGitState(): void {
  described = undefined;
  seq += 1;
  useGitStore.setState({ ...EMPTY });
}

/**
 * A git read, as a surface has to render it (M53.15).
 *
 * Three answers, never two. A read that failed is `unavailable`, never an
 * empty `ready`: "this note has no history" and "this note's history could
 * not be read" are opposite sentences, and these hooks used to turn the
 * second into the first. `loading` renders as nothing, so no surface states
 * an empty answer before its read has landed.
 */
export type GitRead<T> = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; data: T };

const LOADING: GitRead<never> = { kind: 'loading' };
const UNAVAILABLE: GitRead<never> = { kind: 'unavailable' };

/**
 * Run one read and keep its answer beside the request it answers.
 *
 * The request's identity is the key: callers build `run` with `useMemo` over
 * exactly the inputs the read depends on. A render whose inputs have moved on
 * finds an answer to some other request and shows `loading`, and a late answer
 * to an old request is dropped, so a stale answer never renders. `reload`
 * asks the same request again.
 */
function useGitRead<T>(run: (() => Promise<T>) | null): { read: GitRead<T>; reload: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<{
    run: () => Promise<T>;
    attempt: number;
    read: GitRead<T>;
  } | null>(null);

  useEffect(() => {
    if (run === null) return;
    let live = true;
    // A read that throws before it hands back a promise failed all the same.
    new Promise<T>((resolve) => resolve(run())).then(
      (data) => {
        if (live) setAnswer({ run, attempt, read: { kind: 'ready', data } });
      },
      () => {
        if (live) setAnswer({ run, attempt, read: UNAVAILABLE });
      },
    );
    return () => {
      live = false;
    };
  }, [run, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const answered =
    run !== null && answer !== null && answer.run === run && answer.attempt === attempt;
  return { read: answered ? answer.read : LOADING, reload };
}

/** One note's commit history, read again when the note or the vault changes. */
export function useFileHistory(path: string): GitRead<GitCommit[]> {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const run = useMemo(
    () => (vaultPath === null ? null : () => git.getFileHistory(vaultPath, path)),
    [vaultPath, path],
  );
  const { read } = useGitRead(run);
  return vaultPath === null ? UNAVAILABLE : read;
}

/** The vault's history for the History page, and a way to ask again. */
export function useVaultPulse(): { pulse: GitRead<VaultPulse>; reload: () => void } {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const run = useMemo(
    () => (vaultPath === null ? null : () => git.getVaultPulse(vaultPath)),
    [vaultPath],
  );
  const { read, reload } = useGitRead(run);
  return { pulse: vaultPath === null ? UNAVAILABLE : read, reload };
}

/** Everything one commit changed. No commit asked for is no read: `null`
 * stays `loading`, which every caller renders as nothing. */
export function useCommitDiff(hash: string | null): GitRead<string> {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const run = useMemo(
    () => (vaultPath === null || hash === null ? null : () => git.getCommitDiff(vaultPath, hash)),
    [vaultPath, hash],
  );
  const { read } = useGitRead(run);
  if (hash === null) return LOADING;
  return vaultPath === null ? UNAVAILABLE : read;
}

/** Idle thresholds, in seconds. */
const IDLE_SECONDS = 120;
const INACTIVE_SECONDS = 30;

/**
 * Automatic checkpoints (M9.4), ported from tolaria's `useAutoGit`.
 *
 * Two triggers because they mean different things: `idle` is "you stopped
 * typing at your desk", `inactive` is "you switched away from the app". The
 * second fires sooner — leaving is a stronger signal that a unit of work
 * finished than merely pausing.
 *
 * Never fires while a note has unsaved edits: committing a half-written file
 * captures a state the user never chose.
 */
export function useAutoCheckpoint(enabled: boolean, onCommitted: () => void): void {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const lastActivity = useRef(Date.now());
  const committing = useRef(false);

  useEffect(() => {
    if (!enabled || vaultPath === null) return;

    const bump = () => {
      lastActivity.current = Date.now();
    };
    const events: (keyof WindowEventMap)[] = ['keydown', 'pointerdown', 'wheel'];
    for (const e of events) window.addEventListener(e, bump, { passive: true });

    const tick = async () => {
      if (committing.current) return;
      const idleFor = (Date.now() - lastActivity.current) / 1000;
      const focused = document.visibilityState === 'visible' && document.hasFocus();
      const threshold = focused ? IDLE_SECONDS : INACTIVE_SECONDS;
      if (idleFor < threshold) return;

      committing.current = true;
      try {
        const files = await git.getModifiedFiles(vaultPath);
        if (files.length === 0) return;
        const message = await withLedgerTrailer(vaultPath, checkpointMessage(files));
        const hash = await git.gitCommit(vaultPath, message);
        if (hash !== null) onCommitted();
      } catch {
        // A failed checkpoint is not worth interrupting anyone for; the next
        // tick tries again.
      } finally {
        committing.current = false;
        lastActivity.current = Date.now();
      }
    };

    const timer = window.setInterval(() => void tick(), 15_000);
    return () => {
      window.clearInterval(timer);
      for (const e of events) window.removeEventListener(e, bump);
    };
  }, [enabled, vaultPath, onCommitted]);
}

/**
 * Append the ledger chain head as a commit trailer (M21.7) — a JOIN KEY from
 * the commit to the ledger head it was made at. It is not rollback
 * detection (M49.10): nothing reads it back, and with knowledge synced
 * through git, other devices' commits carry their own ledgers' heads.
 * Ledger correctness never depends on it. A vault with no ledger, a failing
 * command, or no head changes nothing about the checkpoint — the message
 * goes through untouched.
 */
export async function withLedgerTrailer(vaultPath: string, message: string): Promise<string> {
  try {
    const head = await ledgerHead(vaultPath);
    return head === null ? message : `${message}\n\nCerebro-Ledger-Head: ${head.hash}`;
  } catch {
    return message;
  }
}

/**
 * Commit everything one applied logical batch wrote, as ONE commit (M25.8).
 *
 * The unit of review is the batch, not the file and not the turn. An M22
 * logical batch is atomic in the ledger — its members commit together or not
 * at all — and a checkpoint that split it across commits would offer a revert
 * that could leave the working tree describing half of an event that the
 * ledger only ever holds whole.
 *
 * The batch id rides beside the chain head, so a commit can be joined back to
 * the exact event that produced it.
 */
export function useBatchCheckpoint(
  refresh: () => void,
): (batchId: string, summary: string) => void {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const toast = useUiStore((s) => s.toast);

  return useCallback(
    (batchId: string, summary: string) => {
      if (vaultPath === null) return;
      void (async () => {
        try {
          const base = await withLedgerTrailer(vaultPath, `applied: ${summary}`);
          const hash = await git.gitCommit(vaultPath, `${base}\nCerebro-Batch: ${batchId}`);
          if (hash !== null) refresh();
        } catch (err) {
          // A failed checkpoint never fails the application it describes:
          // the ledger already holds the batch, and git is the cross-attest.
          toast(`Couldn't checkpoint the applied change: ${String(err)}`);
        }
      })();
    },
    [vaultPath, refresh, toast],
  );
}

/** A message that says what changed, not just that something did. */
export function checkpointMessage(files: ModifiedFile[]): string {
  if (files.length === 1) {
    const name = files[0].path.split('/').pop() ?? files[0].path;
    return `Update ${name.replace(/\.md$/, '')}`;
  }
  const folders = new Set(files.map((f) => f.path.split('/')[0]));
  if (folders.size === 1) {
    const [folder] = folders;
    return `Update ${files.length} notes in ${folder}`;
  }
  return `Update ${files.length} notes`;
}

/**
 * Commit what an assistant turn wrote, as its own commit.
 *
 * This is the cerebro-specific trigger and the reason git is in this
 * milestone: the background distiller writes to `knowledge/` unattended.
 * Giving its work a separate commit is what makes it independently
 * reviewable and revertible, rather than tangled into the next checkpoint
 * alongside the user's own edits.
 */
export function useAgentCheckpoint(refresh: () => void): (summary: string) => void {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const toast = useUiStore((s) => s.toast);

  return useCallback(
    (summary: string) => {
      if (vaultPath === null) return;
      void (async () => {
        try {
          const message = await withLedgerTrailer(vaultPath, `assistant: ${summary}`);
          const hash = await git.gitCommit(vaultPath, message);
          if (hash !== null) refresh();
        } catch (err) {
          toast(`Couldn't checkpoint the assistant's edits: ${String(err)}`);
        }
      })();
    },
    [vaultPath, refresh, toast],
  );
}
