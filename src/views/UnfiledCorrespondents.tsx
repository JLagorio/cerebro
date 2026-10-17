import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import {
  createCorrespondent,
  dismissCorrespondent,
  restoreCorrespondent,
} from '@/app/correspondentActions';
import { formatTimestamp } from '@/engine/properties';
import { unfiledCorrespondents, type MailDismissal } from '@/engine/unfiled';
import { useVaultActionGuard } from '@/hooks/useVaultActionGuard';
import { mailDismissalsRead } from '@/lib/ipc';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
/** Mounted only by the on-demand button: no closed-lane read, match or count. */
export function UnfiledCorrespondents({
  typeName,
  onClose,
}: {
  typeName: string;
  onClose: () => void;
}) {
  const vault = useVaultStore((s) => s.vaultPath),
    entries = useVaultStore((s) => s.entries),
    status = useVaultStore((s) => s.status),
    entriesVault = useVaultStore((s) => s.entriesVault);
  const schema = useSchema(),
    capture = useVaultActionGuard(typeName);
  const [read, setRead] = useState<{
    key: string | null;
    rows: MailDismissal[];
    error: boolean;
  } | null>(null);
  const [revision, setRevision] = useState(0),
    [showDismissed, setShowDismissed] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(
    () =>
      useVaultStore.subscribe((next, previous) => {
        if (next.vaultPath !== previous.vaultPath) {
          setRead(null);
          setBusy(false);
          setRevision((n) => n + 1);
        }
      }),
    [],
  );
  useEffect(() => {
    let live = true;
    setRead(null);
    if (vault !== null)
      void mailDismissalsRead(vault).then(
        (rows) => {
          if (live) setRead({ key: vault, rows, error: false });
        },
        () => {
          if (live) setRead({ key: vault, rows: [], error: true });
        },
      );
    return () => {
      live = false;
    };
  }, [vault, revision]);
  const currentRead = read?.key === vault ? read : null;
  const unavailable = currentRead?.error === true || status === 'error';
  const view =
    currentRead === null || unavailable || status !== 'ready' || entriesVault !== vault
      ? null
      : unfiledCorrespondents(entries, schema, currentRead.rows);
  const companyTypes = [...schema.types.values()].filter((type) => type.emailDomain != null);
  const action = async (run: () => Promise<unknown>) => {
    const current = capture();
    setBusy(true);
    try {
      await run();
      if (!current()) return;
      setRevision((n) => n + 1);
    } finally {
      if (current()) setBusy(false);
    }
  };
  const state = unavailable
    ? 'unavailable'
    : view === null
      ? 'loading'
      : view.unreadable > 0
        ? 'partial'
        : !view.hasMail
          ? 'not-recorded'
          : view.rows.length === 0
            ? 'empty'
            : 'ready';
  return (
    <Dialog open onClose={onClose} title="Unfiled correspondents" width={760}>
      <section data-testid="unfiled-correspondents" data-state={state}>
        {unavailable ? (
          <p data-testid="section-unavailable">
            Dismissals or cached mail could not be read. Try opening this lane again.
          </p>
        ) : view === null ? (
          <p>Reading dismissals…</p>
        ) : (
          <>
            {!view.hasMail ? (
              <p>No mail cached.</p>
            ) : view.rows.length === 0 ? (
              <p>
                {view.unreadable > 0
                  ? 'No unfiled addresses in the readable threads.'
                  : 'No unfiled correspondents.'}
              </p>
            ) : (
              <ul className="m-0 list-none p-0">
                {view.rows.map((row) => (
                  <li
                    key={row.address}
                    data-testid="unfiled-row"
                    className="border-b border-n-100 py-3"
                  >
                    <div className="font-medium">{row.address}</div>
                    <p className="my-1 text-xs text-n-500">
                      wrote in {row.threads.length}{' '}
                      {row.threads.length === 1 ? 'thread' : 'threads'},{' '}
                      {row.lastSentAt === null
                        ? 'last sent time not recorded'
                        : `last ${formatTimestamp(row.lastSentAt)}`}
                      {row.company.state === 'filed'
                        ? ` · at ${row.company.entry.title}`
                        : row.company.state === 'consumer'
                          ? ' · personal address'
                          : row.company.state === 'own'
                            ? ' · your domain'
                            : row.company.state === 'ambiguous'
                              ? ' · domain shared by more than one page'
                              : ''}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        title="Writes this address into a tracked page"
                        disabled={busy}
                        onClick={() =>
                          void action(() => createCorrespondent(typeName, row.address))
                        }
                      >
                        Create page
                      </Button>
                      {row.company.state === 'unfiled' && companyTypes.length === 1 && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() =>
                            void action(() => createCorrespondent(typeName, row.address, true))
                          }
                        >
                          Create company
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void action(() => dismissCorrespondent('address', row.address))
                        }
                      >
                        Not a person
                      </Button>
                      {row.company.state === 'unfiled' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void action(() => dismissCorrespondent('domain', row.domain))
                          }
                        >
                          Not a company
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {view.unreadable > 0 && (
              <p className="text-xs text-n-500">
                {view.unreadable} cached {view.unreadable === 1 ? 'thread' : 'threads'} could not be
                read.
              </p>
            )}
            {currentRead!.rows.length > 0 && (
              <>
                <Button variant="ghost" size="sm" onClick={() => setShowDismissed(!showDismissed)}>
                  {showDismissed ? 'Hide dismissed' : `Show ${currentRead!.rows.length} dismissed`}
                </Button>
                {showDismissed &&
                  currentRead!.rows.map((row) => (
                    <div
                      key={`${row.kind}:${row.value}`}
                      className="flex items-center justify-between gap-2 py-2 text-xs"
                    >
                      <span>
                        {row.value} · not a {row.kind === 'address' ? 'person' : 'company'}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void action(() => restoreCorrespondent(row.kind, row.value))}
                      >
                        Restore
                      </Button>
                    </div>
                  ))}
              </>
            )}
          </>
        )}
      </section>
    </Dialog>
  );
}
