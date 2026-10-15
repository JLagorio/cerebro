import { useMemo, useState } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import type { CommitQuery, PulseChanges } from '@/engine/git';
import { CommitAuthor } from '@/git/CommitAuthor';
import { DiffView } from '@/git/DiffView';
import { relativeDate } from '@/git/GitHistoryPanel';
import { useCommitDiff, useCommitRuns, useVaultPulse } from '@/git/useGit';

/**
 * What has happened in this vault (M9.4).
 *
 * The surface that makes the assistant's unattended work legible: the
 * background distiller writes to `knowledge/` whether or not the AI panel is
 * open, and "the base edited 14 notes overnight" is only reassuring if you
 * can read exactly which ones and what it said.
 *
 * Four answers, each its own sentence (M53.15): history that could not be
 * read, a vault that keeps none ("History is off"), a repository with nothing
 * committed ("No history yet"), and the commits. Nothing renders until the
 * read lands, so the page never says "No history yet" about a vault it has
 * not looked at.
 *
 * Who made each commit is the page's History tab's reading (M58.4,
 * `CommitAuthor`): a run only from runtime.db's commit record, else
 * "unattributed", and "attribution unknown" when the record could not be
 * read. The git author stays in the hover.
 */
export function PulsePage() {
  const { pulse, reload } = useVaultPulse();
  const openPath = useOpenPath();
  const [open, setOpen] = useState<{ hash: string; message: string } | null>(null);
  const diff = useCommitDiff(open === null ? null : open.hash);
  const queries = useMemo<CommitQuery[]>(
    () =>
      pulse.kind === 'ready'
        ? pulse.data.commits.map((c) => ({ hash: c.hash, path: null, since: null }))
        : [],
    [pulse],
  );
  const runs = useCommitRuns(queries);

  if (pulse.kind === 'loading') return null;

  if (pulse.kind === 'unavailable') {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="pulse-page">
        <PulseHeader />
        <div className="px-5">
          <div className="mx-auto flex w-full max-w-[720px] flex-col items-start gap-2 pt-1">
            <p data-testid="section-unavailable" className="m-0 text-xs text-n-500">
              This vault's history could not be read, so nothing here is a statement about it.
            </p>
            <Button size="sm" testId="history-retry" onClick={reload}>
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const { tracked, commits } = pulse.data;

  if (!tracked) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center">
        <EmptyState
          icon="activity"
          title="History is off"
          description="This vault is not tracked. Turn history on in Settings to keep every version of every note."
        />
      </div>
    );
  }

  if (commits.length === 0) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center">
        <EmptyState
          icon="activity"
          title="No history yet"
          description="Nothing has been committed in this vault yet."
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="pulse-page">
      <PulseHeader />
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
                if ((e.target as HTMLElement).closest('button') === null) {
                  setOpen({ hash: c.hash, message: c.message });
                }
              }}
              className="cursor-pointer rounded-lg border border-n-200 p-3 hover:border-n-300 hover:bg-n-25"
            >
              <div className="flex min-w-0 items-baseline gap-2">
                <button
                  type="button"
                  onClick={() => setOpen({ hash: c.hash, message: c.message })}
                  className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left text-sm font-medium text-n-900 hover:text-cortex-600"
                >
                  {c.message}
                </button>
                <span className="flex-none [font-family:var(--font-mono)] text-2xs text-n-400">
                  {c.shortHash}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-2xs text-n-500">
                <CommitAuthor commit={c} runs={runs} />
                {runs.kind !== 'loading' && <span>·</span>}
                <span>{relativeDate(c.date)}</span>
                {c.changes === null ? (
                  // Not +0 / ~0: nobody counted, so no number is shown.
                  <span
                    data-testid="pulse-files-unknown"
                    className="text-n-400"
                    title="The files this commit changed could not be read"
                  >
                    files unknown
                  </span>
                ) : (
                  <ChangeCounts changes={c.changes} />
                )}
              </div>
              {c.changes !== null && c.changes.files.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {c.changes.files.slice(0, 8).map((f) => (
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
                  {c.changes.files.length > 8 && (
                    <span className="self-center text-2xs text-n-400">
                      +{c.changes.files.length - 8} more
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
          {/* Nothing while the diff is out, and never DiffView's "No changes."
              for a read that failed: that would describe a commit nobody
              looked at. */}
          {diff.kind === 'unavailable' && (
            <p data-testid="section-unavailable" className="m-0 px-1 py-3 text-sm text-n-500">
              What this commit changed could not be read, so nothing here is a statement about it.
            </p>
          )}
          {diff.kind === 'ready' && <DiffView diff={diff.data} />}
        </Dialog>
      )}
    </div>
  );
}

/** The header shares the content column's left edge (M15). In `px-5` against
 * a centred 720px list it floated ~220px to the left of every card it labels,
 * reading as two unrelated fragments. It is also titled "History", because
 * that is what the nav and the status bar call this destination — a button
 * labelled History that opens a page called Pulse is two names for one place. */
function PulseHeader() {
  return (
    <div className="flex-none px-5 pb-2 pt-3.5">
      <div className="mx-auto flex w-full min-w-0 max-w-[720px] items-center gap-2">
        <Icon name="activity" size={16} color="var(--n-600)" />
        <h1 className="m-0 text-lg font-semibold leading-6 tracking-[-0.005em]">History</h1>
      </div>
    </div>
  );
}

/** `+1` and `~1` are undecodable without knowing the convention, and colour is
 * the only other cue — so each counter carries its own words for hover and for
 * a screen reader. */
function ChangeCounts({ changes }: { changes: PulseChanges }) {
  const { added, modified, deleted } = changes;
  return (
    <>
      {added > 0 && (
        <span
          className="text-success-600"
          title={`${added} file${added === 1 ? '' : 's'} added`}
          aria-label={`${added} file${added === 1 ? '' : 's'} added`}
        >
          +{added}
        </span>
      )}
      {modified > 0 && (
        <span
          className="text-warn-600"
          title={`${modified} file${modified === 1 ? '' : 's'} changed`}
          aria-label={`${modified} file${modified === 1 ? '' : 's'} changed`}
        >
          ~{modified}
        </span>
      )}
      {deleted > 0 && (
        <span
          className="text-danger-500"
          title={`${deleted} file${deleted === 1 ? '' : 's'} deleted`}
          aria-label={`${deleted} file${deleted === 1 ? '' : 's'} deleted`}
        >
          −{deleted}
        </span>
      )}
    </>
  );
}
