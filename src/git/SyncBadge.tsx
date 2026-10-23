import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { FixedBelowAnchor } from '@/detail/FieldPopover';
import { destination } from '@/engine/destinations';
import {
  countsUnknown,
  isFailure,
  UNCOUNTED_WORDS,
  type GitRemoteStatus,
  type SyncState,
} from '@/engine/git';
import { useGit, type GitState } from '@/git/useGit';
import * as git from '@/lib/gitIpc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * Sync state in the shell (M9.4; the sidebar footer since M43).
 *
 * Held to the no-idle-chrome rule: a clean, remoteless vault renders NOTHING.
 * The badge appears only when it has something to tell you — uncommitted
 * work, a divergence from the remote, counts git could not take (M92.10), or
 * a conflict — and every state it shows is one you can act on from the
 * popover it opens. A read that failed (M92.9) shows no badge: it can tell
 * none of those, and the status bar says the read failed.
 *
 * Each state's icon, colour and words, which the conversation rail's
 * Environment card says too (M92.9).
 */
export const SYNC_TONE: Record<
  SyncState,
  { icon: string; color: string; label: (n: number) => string }
> = {
  clean: { icon: 'check', color: 'var(--n-400)', label: () => 'Up to date' },
  'local-changes': {
    icon: 'file-diff',
    color: 'var(--warn-600)',
    label: (n) => `${n} uncommitted`,
  },
  ahead: { icon: 'arrow-up', color: 'var(--cortex-600)', label: (n) => `${n} to push` },
  behind: { icon: 'arrow-down', color: 'var(--cortex-600)', label: (n) => `${n} to pull` },
  diverged: { icon: 'git-branch', color: 'var(--warn-600)', label: () => 'Diverged' },
  // M92.10: counts git did not take are never "Up to date".
  unknown: { icon: 'circle-dashed', color: 'var(--n-500)', label: () => 'Sync unknown' },
  conflict: { icon: 'triangle-alert', color: 'var(--danger-500)', label: (n) => `${n} conflicted` },
};

/** The number a state's words count: conflicted or changed files, or
 * commits to pull or to push. */
export function syncCount(
  sync: SyncState,
  git: Pick<GitState, 'modified' | 'conflicts' | 'remote'>,
): number {
  if (sync === 'conflict') return git.conflicts.length;
  if (sync === 'local-changes') return git.modified.length;
  if (sync === 'behind') return git.remote?.behind ?? 0;
  return git.remote?.ahead ?? 0;
}

/** The popover's first line: where the branch stands, or why nobody can say. */
function remoteLine(remote: GitRemoteStatus): string {
  const unknown = countsUnknown(remote);
  return unknown === null
    ? `${remote.branch} · ${remote.ahead} ahead, ${remote.behind} behind`
    : `${remote.branch} · ${UNCOUNTED_WORDS[unknown]}`;
}

export function SyncBadge({ quiet = false }: { quiet?: boolean }) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const toast = useUiStore((s) => s.toast);
  const navigate = useNavStore((s) => s.navigate);
  const { isRepo, ready, readError, sync, modified, conflicts, remote, refresh } = useGit();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Nothing to say: not a repo, still loading, a read that failed, or clean
  // with no remote.
  if (!ready || isRepo !== true || readError !== null) return null;
  if (sync === 'clean' && remote === null) return null;

  const count = syncCount(sync, { modified, conflicts, remote });
  const tone = SYNC_TONE[sync];
  const history = destination('pulse');

  const run = async (op: 'pull' | 'push') => {
    if (vaultPath === null) return;
    setBusy(true);
    try {
      const result = op === 'pull' ? await git.gitPull(vaultPath) : await git.gitPush(vaultPath);
      // Say what actually happened. An auth error and a network error need
      // different fixes, and "sync failed" tells you neither.
      toast(result.message);
      if (isFailure(result)) {
        setOpen(false);
      }
      if (op === 'pull' && result.updatedFiles.length > 0) await rescan();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        data-testid="sync-badge"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`cb-sync-badge ${quiet ? 'cb-sync-badge--quiet' : ''} inline-flex h-7 items-center gap-1.5 rounded-md border border-n-200 bg-n-0 px-2 text-xs text-n-600 hover:border-n-300`}
      >
        <Icon name={tone.icon} size={12} color={tone.color} />
        {tone.label(count)}
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close sync menu"
            onClick={() => setOpen(false)}
            onWheel={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default border-0 bg-transparent"
          />
          <FixedBelowAnchor>
            <div className="w-[260px] rounded-lg border border-n-200 bg-n-0 p-2 shadow-[var(--shadow-lg)]">
              <div data-testid="sync-remote-line" className="px-0.5 pb-1.5 text-2xs text-n-500">
                {remote === null ? 'Tracked locally. No remote connected.' : remoteLine(remote)}
              </div>
              <div className="flex flex-col gap-1">
                {(modified.length > 0 || conflicts.length > 0) && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="file-diff"
                    onClick={() => {
                      setOpen(false);
                      navigate({ kind: 'changes' });
                    }}
                  >
                    Review {modified.length + conflicts.length} change
                    {modified.length + conflicts.length === 1 ? '' : 's'}
                  </Button>
                )}
                {remote !== null && (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon="arrow-down"
                      disabled={busy}
                      onClick={() => void run('pull')}
                    >
                      Pull
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon="arrow-up"
                      disabled={busy}
                      onClick={() => void run('push')}
                    >
                      Push
                    </Button>
                  </>
                )}
                {/* The vault's history, named as the nav names it (M59.1). */}
                <Button
                  variant="secondary"
                  size="sm"
                  icon={history.icon}
                  onClick={() => {
                    setOpen(false);
                    navigate(history.selection);
                  }}
                >
                  {history.label}
                </Button>
              </div>
            </div>
          </FixedBelowAnchor>
        </>
      )}
    </span>
  );
}
