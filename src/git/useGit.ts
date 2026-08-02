import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ConflictMode,
  GitCommit,
  GitRemoteStatus,
  ModifiedFile,
  PulseCommit,
} from '@/engine/git';
import { syncState, type SyncState } from '@/engine/git';
import * as git from '@/lib/gitIpc';
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

export function useGit(): GitState {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const [ready, setReady] = useState(false);
  const [isRepo, setIsRepo] = useState(false);
  const [modified, setModified] = useState<ModifiedFile[]>([]);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [conflictMode, setConflictMode] = useState<ConflictMode>('none');
  const [remote, setRemote] = useState<GitRemoteStatus | null>(null);

  const refresh = useCallback(async () => {
    if (vaultPath === null) {
      setReady(true);
      setIsRepo(false);
      return;
    }
    try {
      const repo = await git.isGitRepo(vaultPath);
      setIsRepo(repo);
      if (!repo) {
        setModified([]);
        setConflicts([]);
        setConflictMode('none');
        setRemote(null);
        return;
      }
      const [files, conflicted, mode, remoteStatus] = await Promise.all([
        git.getModifiedFiles(vaultPath),
        git.getConflictFiles(vaultPath),
        git.getConflictMode(vaultPath),
        git.gitRemoteStatus(vaultPath),
      ]);
      setModified(files);
      setConflicts(conflicted);
      setConflictMode(mode);
      setRemote(remoteStatus.hasRemote ? remoteStatus : null);
    } catch {
      // A git probe failing must never take the app down with it — the vault
      // is still perfectly usable as plain files.
      setIsRepo(false);
    } finally {
      setReady(true);
    }
  }, [vaultPath]);

  useEffect(() => {
    setReady(false);
    void refresh();
  }, [refresh]);

  return {
    ready,
    isRepo,
    modified,
    conflicts,
    conflictMode,
    remote,
    sync: syncState(remote, modified.length, conflicts.length),
    refresh,
  };
}

/** One note's commit history, refetched when the path changes. */
export function useFileHistory(path: string | null): {
  commits: GitCommit[];
  loading: boolean;
} {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (vaultPath === null || path === null) {
      setCommits([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void git
      .getFileHistory(vaultPath, path)
      .then((result) => {
        if (!cancelled) setCommits(result);
      })
      .catch(() => {
        if (!cancelled) setCommits([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [vaultPath, path]);

  return { commits, loading };
}

export function useVaultPulse(): { commits: PulseCommit[]; loading: boolean; reload: () => void } {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const [commits, setCommits] = useState<PulseCommit[]>([]);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (vaultPath === null) return;
    let cancelled = false;
    setLoading(true);
    void git
      .getVaultPulse(vaultPath)
      .then((result) => {
        if (!cancelled) setCommits(result);
      })
      .catch(() => {
        if (!cancelled) setCommits([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [vaultPath, nonce]);

  return { commits, loading, reload: () => setNonce((n) => n + 1) };
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
        const message = checkpointMessage(files);
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
          const hash = await git.gitCommit(vaultPath, `assistant: ${summary}`);
          if (hash !== null) refresh();
        } catch (err) {
          toast(`Couldn't checkpoint the assistant's edits: ${String(err)}`);
        }
      })();
    },
    [vaultPath, refresh, toast],
  );
}
