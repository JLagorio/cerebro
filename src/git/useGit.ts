import { saveBeforeAction } from '@/app/leaveGuard';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type {
  CommitQuery,
  CommitRun,
  ConflictMode,
  FileAt,
  FileCommit,
  FilePatch,
  GitRemoteStatus,
  ModifiedFile,
  VaultPulse,
} from '@/engine/git';
import { syncState, type SyncState } from '@/engine/git';
import { announceExternalWrites } from '@/editor/openPages';
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
  /**
   * Whether the vault is a git repository, as the newest probe that could
   * tell said (M92.9): null until one has. A read that fails leaves it as it
   * was, so a failure never reads as "not a repository" (CV-05).
   */
  isRepo: boolean | null;
  /**
   * Why the newest read failed, or null when it answered (M92.9). The rest
   * of the snapshot is then what the last read that answered said, and a
   * surface says the read failed rather than claim any of it.
   */
  readError: string | null;
  /** The branch the repository is on, kept with or without a remote
   * (M92.9); null outside a repository, and when git could not name it. */
  branch: string | null;
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
  isRepo: null,
  readError: null,
  branch: null,
  modified: [],
  conflicts: [],
  conflictMode: 'none',
  remote: null,
};

/** A failed read's reason, as a surface can say it. */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
  // A git probe failing must never take the app down with it — the vault is
  // still perfectly usable as plain files. Nor may it read as a vault with
  // no history (M92.9): it says the read failed, and leaves what an earlier
  // read found, so no surface offers to start tracking a repository it only
  // failed to read.
  let repo: boolean;
  try {
    repo = await git.isGitRepo(vaultPath);
  } catch (err) {
    commit({ readError: reasonOf(err) });
    return;
  }
  if (!repo) {
    commit({ ...EMPTY, isRepo: false });
    return;
  }
  try {
    const [files, conflicted, mode, remoteStatus] = await Promise.all([
      git.getModifiedFiles(vaultPath),
      git.getConflictFiles(vaultPath),
      git.getConflictMode(vaultPath),
      git.gitRemoteStatus(vaultPath),
    ]);
    commit({
      isRepo: true,
      readError: null,
      // git names the branch whether or not there is a remote to sync with.
      branch: remoteStatus.branch === '' ? null : remoteStatus.branch,
      modified: files,
      conflicts: conflicted,
      conflictMode: mode,
      remote: remoteStatus.hasRemote ? remoteStatus : null,
    });
  } catch (err) {
    // The repository answered; what it holds did not.
    commit({ isRepo: true, readError: reasonOf(err) });
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

/**
 * The shared state, kept honest while this consumer is mounted. `watch:
 * false` reads it as it stands and starts nothing: no probe, no poll and no
 * trigger of its own, for a surface that must not read while it is folded
 * away (the conversation rail's Environment card, M92.9).
 */
export function useGit({ watch = true }: { watch?: boolean } = {}): GitState {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const snapshot = useGitStore();

  useEffect(() => {
    if (!watch) return;
    attach();
    return detach;
  }, [watch]);

  useEffect(() => {
    // Guarded on the module's own record of what was read, not on this hook's
    // render, so six mounted consumers cause ONE probe rather than six.
    if (!watch || described === vaultPath) return;
    described = vaultPath;
    useGitStore.setState({ ...EMPTY });
    void refreshGit();
  }, [vaultPath, watch]);

  return {
    ...snapshot,
    sync: syncState(snapshot.remote, snapshot.modified.length, snapshot.conflicts.length),
    // A stable module function: callers pass it straight into effect deps.
    refresh: refreshGit,
  };
}

/** Test and state-lab seam: forget what the shared state describes, so the
 * next mount reads again. Nothing in the app needs it — a vault change is
 * detected on its own. */
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

/** Bumped by every Restore (M58.4): a page's history has a new top row. */
const useHistoryRevision = create<{ n: number }>(() => ({ n: 0 }));

/** One page's history as `FileCommit` rows (M58.4): each commit with the
 * path the page had in it, its parent and what it did. Read again when the
 * page or the vault changes, when the page goes in or out of the changed
 * files (a checkpoint or a run's commit took it), and after a Restore. */
export function useFileHistory(path: string): GitRead<FileCommit[]> {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const pending = useGitStore((s) => s.modified.some((f) => f.path === path));
  const revision = useHistoryRevision((s) => s.n);
  const run = useMemo(
    () => (vaultPath === null ? null : () => git.getFileHistory(vaultPath, path)),
    // `pending` and `revision` are the request's identity, not its inputs:
    // either moving means the history may have a row it did not.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read keys, named above
    [vaultPath, path, pending, revision],
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

/** One file's patch in one commit (M58.3), read when a turn's changeset
 * expands the file, and not before: `null` for either asks nothing and stays
 * `loading`. */
export function useFilePatch(path: string | null, commit: string | null): GitRead<FilePatch> {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const run = useMemo(
    () =>
      vaultPath === null || path === null || commit === null
        ? null
        : () => git.getFilePatch(vaultPath, path, commit),
    [vaultPath, path, commit],
  );
  const { read } = useGitRead(run);
  if (path === null || commit === null) return LOADING;
  return vaultPath === null ? UNAVAILABLE : read;
}

/**
 * Which recorded runs made these commits (M58.4, CV-35), keyed by the
 * hashes asked, so a new list asks again and the same list does not. A
 * commit missing from the answer has no record and reads "unattributed"; a
 * rejected read is `unavailable`, which reads "attribution unknown", never
 * the same thing. No queries asks nothing and answers an empty list.
 */
export function useCommitRuns(queries: CommitQuery[]): GitRead<CommitRun[]> {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  // The request's identity is its content: callers build a fresh array each
  // render, and keying on the array itself would ask again forever.
  const key = JSON.stringify(queries.map((q) => [q.hash, q.path, q.since]));
  const asked = useMemo(
    () =>
      (JSON.parse(key) as [string, string | null, string | null][]).map(
        ([hash, path, since]): CommitQuery => ({ hash, path, since }),
      ),
    [key],
  );
  const run = useMemo(
    () =>
      vaultPath === null
        ? null
        : asked.length === 0
          ? () => Promise.resolve([] as CommitRun[])
          : () => git.commitRuns(vaultPath, asked),
    [vaultPath, asked],
  );
  const { read } = useGitRead(run);
  return vaultPath === null ? UNAVAILABLE : read;
}

/** Both sides of one version (M58.4): `after` as the commit held the page,
 * `before` as its parent held it. A side with nothing to read is null. */
export interface FileVersions {
  before: FileAt | null;
  after: FileAt | null;
}

/**
 * Read one version and the one before it (M58.4): `after` at the commit
 * under `pathAt`, `before` at its parent under `previousPath ?? pathAt`, so
 * a version from before a rename opens its own file. No read for a side
 * there is nothing to read on: a root commit or an added page has no
 * before, a deleted page no after. Either read failing is `unavailable`.
 */
export function useFileVersions(commit: FileCommit | null): GitRead<FileVersions> {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const run = useMemo(() => {
    if (vaultPath === null || commit === null || commit.pathAt === null) return null;
    const pathAt = commit.pathAt;
    const readAfter = commit.change !== 'deleted';
    const readBefore = commit.parent !== null && commit.change !== 'added';
    const beforePath = commit.previousPath ?? pathAt;
    const parent = commit.parent;
    return async (): Promise<FileVersions> => {
      const [after, before] = await Promise.all([
        readAfter ? git.getFileAtCommit(vaultPath, pathAt, commit.hash) : null,
        readBefore && parent !== null ? git.getFileAtCommit(vaultPath, beforePath, parent) : null,
      ]);
      return { before, after };
    };
  }, [vaultPath, commit]);
  const { read } = useGitRead(run);
  if (commit === null) return LOADING;
  if (vaultPath === null || commit.pathAt === null) return UNAVAILABLE;
  return read;
}

/**
 * Restore a page to one version (M58.4), as a person's action: land every
 * open page's pending save first, so the restore is not overwritten by an
 * edit typed before it, then restore, tell the page its file changed, read
 * git again, and say what happened. Never throws (CV-03): a refusal toasts
 * and answers false.
 */
export async function restoreVersion(
  vault: string,
  path: string,
  commit: string,
  title: string,
): Promise<boolean> {
  const toast = useUiStore.getState().toast;
  try {
    if (!(await saveBeforeAction())) return false;
    const result = await git.restoreNoteVersion(vault, path, commit);
    if (result.unchanged) {
      toast('This page already matches that version.');
      return true;
    }
    await announceExternalWrites([path], () => useVaultStore.getState().rescan());
    useHistoryRevision.setState((s) => ({ n: s.n + 1 }));
    void refreshGit();
    toast(
      result.commitError === null
        ? `Restored ${title}. The version it replaced is in History.`
        : `Restored ${title}. History will record it at the next checkpoint.`,
    );
    return true;
  } catch (err) {
    toast(`Couldn't restore ${title}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
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
 * captures a state the user never chose. And never takes a path a live run
 * owns (M58.3): Rust's `commit_all` leaves those for the run's own commit,
 * so the message names only the files with no owner, and a tick where only
 * owned files changed commits nothing.
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
        const files = (await git.getModifiedFiles(vaultPath)).filter((f) => f.owner == null);
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
