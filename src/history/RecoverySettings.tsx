import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { clearRecovery, recoveryStatus, setRecoveryEnabled } from '@/lib/ipc';
import type { RecoveryStatus } from '@/engine/recovery';

export function RecoverySettings({ vault }: { vault: string }) {
  return <VaultRecoverySettings key={vault} vault={vault} />;
}
function VaultRecoverySettings({ vault }: { vault: string }) {
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let current = true;
    void recoveryStatus(vault).then(
      (value) => {
        if (current) setStatus(value);
      },
      () => {
        if (current) setError('Recovery settings could not be read.');
      },
    );
    return () => {
      current = false;
      alive.current = false;
    };
  }, [vault]);
  const change = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      const value = await recoveryStatus(vault);
      if (alive.current) {
        setStatus(value);
        setConfirm(false);
      }
    } catch (e) {
      if (alive.current)
        setError(`Recovery change failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <section
      aria-label="Recovery copies"
      className="mt-5 flex flex-col gap-2 border-t border-n-200 pt-4 text-sm"
    >
      <h3 className="font-semibold">Recovery copies</h3>
      <p>
        Opt in to keep displaced page bytes locally outside the vault. Copies can contain private
        text. They are kept for up to seven days, with a 100 MiB global limit and 10 MiB per copy;
        older finished copies are evicted when space is needed.
      </p>
      <p>
        Protects ordinary human Markdown and diagram body saves and recovery restores. Protected
        mail and Knowledge are excluded. Metadata, agent, batch, whiteboard and Git writes are not
        covered. Unsaved drafts are not recovered after a crash.
      </p>
      <p>
        Turning this off keeps existing copies until they expire or you delete them. In the browser
        demo, copies exist only in memory.
      </p>
      {error && (
        <p role="alert" data-testid="section-unavailable">
          {error}
        </p>
      )}
      {error && (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void change(async () => undefined)}
        >
          Retry recovery settings
        </Button>
      )}
      {status === null ? (
        !error && <p>Reading recovery settings…</p>
      ) : (
        <>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={status.enabled}
              disabled={busy}
              onChange={(event) => {
                const enabled = event.target.checked;
                void change(() => setRecoveryEnabled(vault, enabled));
              }}
            />
            Keep recovery copies for this vault
          </label>
          <p>
            Across all vaults: {status.entries} copies,{' '}
            {(status.retainedBytes / 1048576).toFixed(2)} MiB retained. {status.pending} pending;{' '}
            {status.ambiguous} ambiguous.
          </p>
          {confirm ? (
            <div role="group" aria-label="Confirm clear recovery copies">
              <p>Delete all recovery copies for this vault? Current pages are kept.</p>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void change(() => clearRecovery(vault))}
              >
                Delete copies for this vault
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirm(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirm(true)}>
              Clear recovery copies
            </Button>
          )}
        </>
      )}
    </section>
  );
}
