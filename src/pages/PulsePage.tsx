import { useState } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { DiffView } from '@/git/DiffView';
import { relativeDate } from '@/git/GitHistoryPanel';
import { useVaultPulse } from '@/git/useGit';
import { getCommitDiff } from '@/lib/gitIpc';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * What has happened in this vault (M9.4).
 *
 * The surface that makes the assistant's unattended work legible: the
 * background distiller writes to `knowledge/` whether or not the AI panel is
 * open, and "the base edited 14 notes overnight" is only reassuring if you
 * can read exactly which ones and what it said.
 */
export function PulsePage() {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const { commits, loading } = useVaultPulse();
  const openPath = useOpenPath();
  const [open, setOpen] = useState<{ hash: string; message: string } | null>(null);
  const [diff, setDiff] = useState('');

  const show = (hash: string, message: string) => {
    setOpen({ hash, message });
    setDiff('');
    if (vaultPath === null) return;
    void getCommitDiff(vaultPath, hash)
      .then(setDiff)
      .catch(() => setDiff(''));
  };

  if (loading) return null;

  if (commits.length === 0) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center">
        <EmptyState
          icon="activity"
          title="No history yet"
          description="Once this vault is tracked, everything that changes shows up here."
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="pulse-page">
      <div className="flex-none px-5 pb-2 pt-3.5">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="activity" size={16} color="var(--n-600)" />
          <h1 className="m-0 text-[15px] font-semibold leading-6 tracking-[-0.005em]">Pulse</h1>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3 pt-1">
          {commits.map((c) => (
            <div
              key={c.hash}
              data-testid="pulse-commit"
              className="rounded-[10px] border border-[var(--n-200)] p-3"
            >
              <div className="flex min-w-0 items-baseline gap-2">
                <button
                  type="button"
                  onClick={() => show(c.hash, c.message)}
                  className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left text-[13px] font-medium text-[var(--n-900)] hover:text-[var(--cortex-600)]"
                >
                  {c.message}
                </button>
                <span className="flex-none [font-family:var(--font-mono)] text-[10.5px] text-[var(--n-400)]">
                  {c.shortHash}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--n-500)]">
                <span>{c.author}</span>
                <span>·</span>
                <span>{relativeDate(c.date)}</span>
                {c.added > 0 && (
                  <span className="text-[var(--success-600,#1F9D61)]">+{c.added}</span>
                )}
                {c.modified > 0 && <span className="text-[var(--warn-600,#B87503)]">~{c.modified}</span>}
                {c.deleted > 0 && <span className="text-[var(--danger-500)]">−{c.deleted}</span>}
              </div>
              {c.files.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {c.files.slice(0, 8).map((f) => (
                    <button
                      key={f.path}
                      type="button"
                      onClick={() => openPath(f.path)}
                      title={f.path}
                      className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--n-200)] bg-transparent px-2 py-[2px] text-[11px] text-[var(--n-600)] hover:border-[var(--n-400)] hover:text-[var(--n-900)]"
                    >
                      <span className="truncate">{f.title}</span>
                    </button>
                  ))}
                  {c.files.length > 8 && (
                    <span className="self-center text-[11px] text-[var(--n-400)]">
                      +{c.files.length - 8} more
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {open !== null && (
        <Dialog
          open
          onClose={() => setOpen(null)}
          title={open.message}
          width={760}
          secondaryAction={{ label: 'Close', onClick: () => setOpen(null) }}
        >
          <DiffView diff={diff} />
        </Dialog>
      )}
    </div>
  );
}
