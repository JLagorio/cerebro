import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { resolveReconciliation, type QuarantinedPath } from '@/lib/ipc';
import { refusalText } from '@/lib/refusal';
import { isRecording, useLedgerStore } from '@/stores/ledgerStore';

/** What each quarantine class means, in the person's words. */
const CLASS_LABEL: Record<QuarantinedPath['class'], string> = {
  adoptable: 'edited outside Cerebro',
  refused: 'cannot be kept',
  deleted: 'deleted outside Cerebro',
  unrecorded: 'never recorded',
};

/**
 * The divergence banner (M23.7, rebuilt in M49.6).
 *
 * Files win (the 2026-09 owner decision): a knowledge file that differs from
 * its recorded history is QUARANTINED — nothing is written over it — and the
 * rest of the vault keeps recording (M49.5). This banner names every such
 * file with why, and offers a choice per file and for all of them:
 *
 * - Keep records the file as it is now. A file Keep cannot record (a changed
 *   author or verified stamp, a removed alias…) says why and stays listed.
 * - Restore puts the recorded version back, after saving what is on disk to
 *   `.cerebro/reconcile-backup/` — nothing is ever deleted. It asks first.
 *
 * Before M49.6 it said "(1 unresolved)" and named nothing: the person could
 * not find the file, or judge either button, and one of them could not work.
 *
 * Reads the shared ledger status (M49.2); `RecordingBanner` refreshes it and
 * renders the failed-read state, so this one stays quiet on a read it could
 * not make rather than claiming nothing is wrong. Both exits append to the
 * ledger, so while this window is not recording the vault they are not
 * offered — `RecordingBanner` above says why and how to start.
 */
export function ReconciliationBanner({ vault }: { vault: string }) {
  const readVault = useLedgerStore((s) => s.vault);
  const read = useLedgerStore((s) => s.read);
  const refresh = useLedgerStore((s) => s.refresh);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recording = useLedgerStore((s) => isRecording(vault, s));

  if (readVault !== vault || read.kind !== 'read') return null;
  const status = read.status;
  const files = status.quarantined;
  if (!status.reconciliation_open && files.length === 0) return null;

  const run = (key: string, action: string, path?: string) => {
    setBusy(key);
    setError(null);
    resolveReconciliation(vault, action, path)
      .catch((e: unknown) => setError(refusalText(e)))
      .finally(() => {
        setBusy(null);
        setConfirming(null);
        // Refresh either way: a Keep-all that refused one file still kept
        // the others, and the list has to say so.
        void refresh(vault);
      });
  };
  const restore = (key: string, action: string, path?: string) => {
    if (confirming !== key) {
      setConfirming(key);
      return;
    }
    run(key, action, path);
  };

  const n = files.length;
  const plural = n === 1 ? '' : 's';
  const restoreButton = (key: string, label: string, action: string, path?: string) => (
    <Button
      size="sm"
      variant={confirming === key ? 'danger' : 'secondary'}
      disabled={busy !== null}
      onClick={() => restore(key, action, path)}
    >
      {confirming === key ? 'Confirm restore' : label}
    </Button>
  );

  return (
    <div
      data-testid="reconciliation-banner"
      data-stopped={status.stopped ? 'true' : 'false'}
      role="alert"
      className="flex flex-col gap-2 border-b border-warn-300 bg-warn-50 px-4 py-2.5 text-xs text-warn-700"
    >
      <p className="m-0">
        <span className="font-semibold">
          {status.stopped
            ? 'Knowledge history diverged — recording is paused for the whole vault.'
            : n === 0
              ? 'A recorded divergence is still open, though every file now matches its recorded history.'
              : `${n} knowledge file${plural} differ${n === 1 ? 's' : ''} from ${n === 1 ? 'its' : 'their'} recorded history.`}
        </span>{' '}
        {status.stopped
          ? 'A mass change, a migration problem, or a rewound history was found. Choose for all files, or file by file.'
          : 'Nothing has been written over them, and the rest of the vault keeps recording.'}
      </p>

      {n > 0 && (
        <ul data-testid="quarantine-list" className="m-0 flex list-none flex-col gap-1 p-0">
          {files.map((q) => (
            <li
              key={q.path}
              data-path={q.path}
              data-class={q.class}
              className="flex flex-wrap items-center gap-x-2 gap-y-1"
            >
              <code className="rounded-sm bg-n-0 px-1.5 py-px font-mono text-2xs text-n-800">
                {q.path}
              </code>
              <span>{CLASS_LABEL[q.class]}</span>
              {q.class === 'refused' && <span>({q.reason})</span>}
              {recording && (
                <span className="flex gap-1.5">
                  {q.class === 'adoptable' && (
                    <Button
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => run(`keep:${q.path}`, 'keep', q.path)}
                    >
                      Keep
                    </Button>
                  )}
                  {restoreButton(`restore:${q.path}`, 'Restore', 'restore', q.path)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* The vault-wide exits resolve a RECORDED divergence; a file can be
          quarantined with none open (a scan has not run since it changed),
          and there only the per-file exits work. */}
      {recording && status.reconciliation_open && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => run('keep-all', 'accept_current_files')}
          >
            {n > 1 ? 'Keep all' : 'Keep my files'}
          </Button>
          {restoreButton('restore-all', 'Restore recorded history', 'restore_ledger_authority')}
          <span>
            Keep records the files as they are now; a file it cannot record stays listed, with why.
            Restore saves what is on disk to .cerebro/reconcile-backup/ first — nothing is deleted.
          </span>
        </div>
      )}

      {!recording && (
        <p data-testid="reconciliation-not-recording" className="m-0">
          Keep and Restore are available once this window is recording the vault.
        </p>
      )}

      {error !== null && (
        <p data-testid="reconciliation-error" className="m-0 text-danger-700">
          {error}
        </p>
      )}
    </div>
  );
}
