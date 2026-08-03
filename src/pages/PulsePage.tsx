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
      {/* The header shares the content column's left edge (M15). In `px-5`
          against a centred 720px list it floated ~220px to the left of every
          card it labels, reading as two unrelated fragments.
          It is also titled "History", because that is what the rail and the
          status bar call this destination — a button labelled History that
          opens a page called Pulse is two names for one place. */}
      <div className="flex-none px-5 pb-2 pt-3.5">
        <div className="mx-auto flex w-full min-w-0 max-w-[720px] items-center gap-2">
          <Icon name="activity" size={16} color="var(--n-600)" />
          <h1 className="m-0 text-lg font-semibold leading-6 tracking-[-0.005em]">History</h1>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3 pt-1">
          {commits.map((c) => (
            // The card LOOKS clickable across ~970px and was inert everywhere
            // except the message string. The message button stays the
            // accessible name and the keyboard target; this only extends the
            // hit area the card's own affordances already promised. Clicks that
            // land on a real control (a file chip) are left to it.
            <div
              key={c.hash}
              data-testid="pulse-commit"
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('button') === null) show(c.hash, c.message);
              }}
              className="cursor-pointer rounded-lg border border-n-200 p-3 hover:border-n-300 hover:bg-n-25"
            >
              <div className="flex min-w-0 items-baseline gap-2">
                <button
                  type="button"
                  onClick={() => show(c.hash, c.message)}
                  className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left text-sm font-medium text-n-900 hover:text-cortex-600"
                >
                  {c.message}
                </button>
                <span className="flex-none [font-family:var(--font-mono)] text-2xs text-n-400">
                  {c.shortHash}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-2xs text-n-500">
                <span>{c.author}</span>
                <span>·</span>
                <span>{relativeDate(c.date)}</span>
                {/* `+1` and `~1` are undecodable without knowing the
                    convention, and colour is the only other cue — so each
                    carries its own words for hover and for a screen reader. */}
                {c.added > 0 && (
                  <span
                    className="text-success-600"
                    title={`${c.added} file${c.added === 1 ? '' : 's'} added`}
                    aria-label={`${c.added} file${c.added === 1 ? '' : 's'} added`}
                  >
                    +{c.added}
                  </span>
                )}
                {c.modified > 0 && (
                  <span
                    className="text-warn-600"
                    title={`${c.modified} file${c.modified === 1 ? '' : 's'} changed`}
                    aria-label={`${c.modified} file${c.modified === 1 ? '' : 's'} changed`}
                  >
                    ~{c.modified}
                  </span>
                )}
                {c.deleted > 0 && (
                  <span
                    className="text-danger-500"
                    title={`${c.deleted} file${c.deleted === 1 ? '' : 's'} deleted`}
                    aria-label={`${c.deleted} file${c.deleted === 1 ? '' : 's'} deleted`}
                  >
                    −{c.deleted}
                  </span>
                )}
              </div>
              {c.files.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {c.files.slice(0, 8).map((f) => (
                    <button
                      key={f.path}
                      type="button"
                      onClick={() => openPath(f.path)}
                      title={f.path}
                      className="inline-flex max-w-full items-center gap-1 rounded-full border border-n-200 bg-transparent px-2 py-[2px] text-2xs text-n-600 hover:border-n-400 hover:text-n-900"
                    >
                      <span className="truncate">{f.title}</span>
                    </button>
                  ))}
                  {c.files.length > 8 && (
                    <span className="self-center text-2xs text-n-400">
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
