import { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { DiffView } from '@/git/DiffView';
import { useFileHistory } from '@/git/useGit';
import { getFileDiffAtCommit } from '@/lib/gitIpc';
import { useVaultStore } from '@/stores/vaultStore';

/** Relative dates, because "3d ago" answers the question "is this current?"
 * and an ISO timestamp does not. */
export function relativeDate(unixSeconds: number, now = Date.now()): string {
  const days = Math.floor((now / 1000 - unixSeconds) / 86400);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1mo ago' : `${months}mo ago`;
}

/**
 * One note's history (M9.4). Ported from tolaria's GitHistoryPanel; lifts
 * cleanly because it is genuinely small.
 *
 * Renders nothing when the note has no commits — a heading over an empty
 * list is chrome, and a note you just created has no history to show.
 */
export function GitHistoryPanel({ path }: { path: string }) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const { commits, loading } = useFileHistory(path);
  const [open, setOpen] = useState<{ hash: string; message: string } | null>(null);
  const [diff, setDiff] = useState<string>('');

  const showDiff = (hash: string, message: string) => {
    setOpen({ hash, message });
    setDiff('');
    if (vaultPath === null) return;
    void getFileDiffAtCommit(vaultPath, path, hash)
      .then(setDiff)
      .catch(() => setDiff(''));
  };

  if (loading || commits.length === 0) return null;

  return (
    <div data-testid="git-history" className="mt-5">
      <div className="mb-2 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--n-500)]">
        <Icon name="history" size={12} />
        History
      </div>
      <div className="flex flex-col gap-2">
        {commits.map((c) => (
          <div
            key={c.hash}
            data-testid="git-commit"
            className="border-l-2 border-[var(--n-200)] pl-2.5"
          >
            <button
              type="button"
              onClick={() => showDiff(c.hash, c.message)}
              className="w-full truncate border-0 bg-transparent p-0 text-left text-[12px] text-[var(--cortex-600)] hover:underline"
              title={`View what ${c.shortHash} changed`}
            >
              <span className="[font-family:var(--font-mono)] text-[11px]">{c.shortHash}</span>
              {' · '}
              {c.message}
            </button>
            <div className="text-[10.5px] text-[var(--n-400)]">
              {c.author} · {relativeDate(c.date)}
            </div>
          </div>
        ))}
      </div>

      {open !== null && (
        <Dialog
          open
          onClose={() => setOpen(null)}
          title={open.message}
          width={720}
          secondaryAction={{ label: 'Close', onClick: () => setOpen(null) }}
        >
          <DiffView diff={diff} emptyLabel="This commit did not change this file." />
        </Dialog>
      )}
    </div>
  );
}
