import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { FixedBelowAnchor } from '@/detail/FieldPopover';
import { isFailure, type SyncState } from '@/engine/git';
import { useGit } from '@/git/useGit';
import * as git from '@/lib/gitIpc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * Sync state in the topbar (M9.4).
 *
 * Held to the no-idle-chrome rule: a clean, remoteless vault renders NOTHING.
 * The badge appears only when it has something to tell you — uncommitted
 * work, a divergence from the remote, or a conflict — and every state it
 * shows is one you can act on from the popover it opens.
 */
const TONE: Record<SyncState, { icon: string; color: string; label: (n: number) => string }> = {
  clean: { icon: 'check', color: 'var(--n-400)', label: () => 'Up to date' },
  'local-changes': {
    icon: 'file-diff',
    color: 'var(--warn-600, #B87503)',
    label: (n) => `${n} uncommitted`,
  },
  ahead: { icon: 'arrow-up', color: 'var(--cortex-600)', label: (n) => `${n} to push` },
  behind: { icon: 'arrow-down', color: 'var(--cortex-600)', label: (n) => `${n} to pull` },
  diverged: { icon: 'git-branch', color: 'var(--warn-600, #B87503)', label: () => 'Diverged' },
  conflict: { icon: 'triangle-alert', color: 'var(--danger-500)', label: (n) => `${n} conflicted` },
};

export function SyncBadge() {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const toast = useUiStore((s) => s.toast);
  const navigate = useNavStore((s) => s.navigate);
  const { isRepo, ready, sync, modified, conflicts, remote, refresh } = useGit();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Nothing to say: not a repo, still loading, or clean with no remote.
  if (!ready || !isRepo) return null;
  if (sync === 'clean' && remote === null) return null;

  const count =
    sync === 'conflict'
      ? conflicts.length
      : sync === 'local-changes'
        ? modified.length
        : sync === 'behind'
          ? (remote?.behind ?? 0)
          : (remote?.ahead ?? 0);
  const tone = TONE[sync];

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
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--n-200)] bg-[var(--n-0)] px-2 text-[12px] text-[var(--n-600)] hover:border-[var(--n-300)]"
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
            <div className="w-[260px] rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] p-2 shadow-[var(--shadow-lg)]">
              <div className="px-0.5 pb-1.5 text-[11px] text-[var(--n-500)]">
                {remote === null
                  ? 'Tracked locally. No remote connected.'
                  : `${remote.branch} · ${remote.ahead} ahead, ${remote.behind} behind`}
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
                <Button
                  variant="secondary"
                  size="sm"
                  icon="activity"
                  onClick={() => {
                    setOpen(false);
                    navigate({ kind: 'pulse' });
                  }}
                >
                  Pulse
                </Button>
              </div>
            </div>
          </FixedBelowAnchor>
        </>
      )}
    </span>
  );
}
