import { useCallback, useEffect, useState } from 'react';
import { ledgerStatus, resolveReconciliation, type LedgerStatus } from '@/lib/ipc';

/**
 * The M23.7 divergence banner. While the ledger's named reconciliation
 * mode is open, automatic capture is suspended and the vault needs an
 * explicit decision: adopt the current files through the capture valve, or
 * restore every projection from ledger history. Renders nothing when the
 * mode is closed — which is always, in the browser mock.
 */
export function ReconciliationBanner({ vault }: { vault: string }) {
  const [status, setStatus] = useState<LedgerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    // Store-layer discipline: never throw — an unreadable status simply
    // renders no banner.
    ledgerStatus(vault)
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [vault]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const act = (action: 'accept_current_files' | 'restore_ledger_authority') => {
    setBusy(true);
    setError(null);
    resolveReconciliation(vault, action)
      .then(() => refresh())
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  if (status === null || !status.reconciliation_open) return null;
  return (
    <div
      data-testid="reconciliation-banner"
      role="alert"
      className="flex flex-wrap items-center gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-900"
    >
      <span className="font-medium">Knowledge history diverged.</span>
      <span>
        The files on disk and the recorded history disagree ({status.divergences.length}{' '}
        unresolved). Automatic capture is paused until you choose.
      </span>
      <span className="ml-auto flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => act('accept_current_files')}
          className="rounded border border-amber-400 px-2 py-0.5 font-medium hover:bg-amber-100 disabled:opacity-50"
        >
          Keep my files
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => act('restore_ledger_authority')}
          className="rounded border border-amber-400 px-2 py-0.5 font-medium hover:bg-amber-100 disabled:opacity-50"
        >
          Restore recorded history
        </button>
      </span>
      {error !== null && <span className="w-full text-red-700">{error}</span>}
    </div>
  );
}
