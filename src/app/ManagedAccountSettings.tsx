import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ManagedAccountCredential } from './ManagedAccountCredential';
import type { ConnectionStatus, ManagedConnectionPage } from '@/lib/generated/actions';
import {
  managedConnectionAdd,
  managedConnectionDisable,
  managedConnections,
  managedConnectionStatus,
} from '@/lib/ipc';
import {
  beginManagedAccountMutation,
  detachManagedAccountMutation,
  managedAccountRefusal,
  reconcileManagedAccountMutation,
  settleManagedAccountMutation,
  useManagedAccountSession,
  type ManagedAccountMutation,
} from './managedAccountSession';

type StatusRead =
  { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; value: ConnectionStatus };
type Selection = Pick<ConnectionStatus, 'connectionId' | 'login'>;
type CatalogWalk = {
  readonly uncertainty: ManagedAccountMutation | null;
  nextCursor: string | null;
};

function healthWords(health: ConnectionStatus['health']): string {
  switch (health) {
    case 'sign_in_required':
      return 'Sign in required';
    case 'disabled':
      return 'Disabled in Cerebro';
    case 'ready':
      return 'Credential recorded';
    case 'unsupported':
      return 'Unsupported';
    case 'unavailable':
      return 'Status unavailable';
  }
}

/** App-owned metadata only. Native authentication supplies the account owner;
 * neither the selected vault nor Claude Code's connector toggle is authority. */
export function ManagedAccountSettings({ active }: { active: boolean }) {
  const login = useManagedAccountSession((session) => session.login);
  const busy = useManagedAccountSession((session) => session.pending !== null);
  const uncertain = useManagedAccountSession((session) => session.uncertain);
  const feedback = useManagedAccountSession((session) => session.feedback);
  const [page, setPage] = useState<ManagedConnectionPage | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [listUnavailable, setListUnavailable] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [status, setStatus] = useState<StatusRead>({ kind: 'loading' });
  const lifetime = useRef({ mounted: false, active: false, generation: 0 });
  const consumer = useRef(Symbol('managed account settings'));
  const listSequence = useRef(0);
  const statusSequence = useRef(0);
  const selectionSequence = useRef(0);
  const selected = useRef<Selection | null>(null);
  const currentStatus = useRef<StatusRead>({ kind: 'loading' });
  const currentPage = useRef<ManagedConnectionPage | null>(null);
  const catalogWalk = useRef<CatalogWalk | null>(null);

  const owns = useCallback((generation: number) => {
    const owner = lifetime.current;
    return owner.mounted && owner.active && owner.generation === generation;
  }, []);

  const readList = useCallback(
    (cursor: string | null, explicit: boolean) => {
      if (!lifetime.current.active) return;
      const session = useManagedAccountSession.getState();
      // Only a head started after settlement can establish reconciliation
      // evidence. A continuation inherits its head and cannot upgrade it.
      const walk: CatalogWalk | null =
        cursor === null
          ? {
              uncertainty:
                session.pending === null && session.uncertain?.kind === 'add'
                  ? session.uncertain
                  : null,
              nextCursor: null,
            }
          : catalogWalk.current;
      if (walk === null || walk.nextCursor !== cursor) return;
      catalogWalk.current = walk;
      const generation = lifetime.current.generation;
      const sequence = ++listSequence.current;
      setListBusy(true);
      setListUnavailable(false);
      if (cursor === null) {
        currentPage.current = null;
        setPage(null);
      }
      void managedConnections(cursor).then(
        (next) => {
          if (
            !owns(generation) ||
            sequence !== listSequence.current ||
            catalogWalk.current !== walk
          )
            return;
          const previous = cursor === null ? [] : (currentPage.current?.items ?? []);
          const items = new Map(previous.map((item) => [item.connectionId, item]));
          for (const item of next.items) items.set(item.connectionId, item);
          const merged = { items: [...items.values()], nextCursor: next.nextCursor };
          currentPage.current = merged;
          walk.nextCursor = next.nextCursor;
          setPage(merged);
          setListBusy(false);
          if (explicit && next.nextCursor === null && walk.uncertainty !== null) {
            reconcileManagedAccountMutation(walk.uncertainty);
          }
        },
        () => {
          if (
            !owns(generation) ||
            sequence !== listSequence.current ||
            catalogWalk.current !== walk
          )
            return;
          if (cursor === null) catalogWalk.current = null;
          setListBusy(false);
          setListUnavailable(true);
        },
      );
    },
    [owns],
  );

  const readStatus = useCallback(
    (account: Selection, explicit: boolean) => {
      if (!lifetime.current.active) return;
      const generation = lifetime.current.generation;
      const selectedAt = selectionSequence.current;
      const sequence = ++statusSequence.current;
      const uncertaintyAtRead = useManagedAccountSession.getState().uncertain;
      currentStatus.current = { kind: 'loading' };
      setStatus(currentStatus.current);
      const isCurrent = () =>
        owns(generation) &&
        sequence === statusSequence.current &&
        selectedAt === selectionSequence.current &&
        selected.current?.connectionId === account.connectionId;
      void managedConnectionStatus(account.connectionId).then(
        (value) => {
          if (!isCurrent()) return;
          const next: StatusRead =
            value.connectionId === account.connectionId
              ? { kind: 'ready', value }
              : { kind: 'unavailable' };
          currentStatus.current = next;
          setStatus(next);
          if (
            explicit &&
            next.kind === 'ready' &&
            next.value.health !== 'unavailable' &&
            uncertaintyAtRead?.kind === 'disable' &&
            uncertaintyAtRead.connectionId === account.connectionId
          ) {
            reconcileManagedAccountMutation(uncertaintyAtRead);
          }
        },
        () => {
          if (!isCurrent()) return;
          currentStatus.current = { kind: 'unavailable' };
          setStatus(currentStatus.current);
        },
      );
    },
    [owns],
  );

  useEffect(() => {
    const owner = lifetime.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.generation += 1;
    };
  }, []);

  useEffect(() => {
    const owner = lifetime.current;
    const consumerId = consumer.current;
    owner.active = active;
    owner.generation += 1;
    if (!active) return;
    const refresh = () => {
      // Read-only display can refresh during an unresolved write, including in
      // a new visit. Automatic reads never clear its app-session barrier.
      readList(null, false);
      if (selected.current !== null) readStatus(selected.current, false);
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      owner.active = false;
      owner.generation += 1;
      listSequence.current += 1;
      statusSequence.current += 1;
      detachManagedAccountMutation(consumerId);
      window.removeEventListener('focus', refresh);
    };
  }, [active, readList, readStatus]);

  const select = (account: Selection) => {
    if (!active) return;
    selected.current = account;
    selectionSequence.current += 1;
    setSelection(account);
    readStatus(account, false);
  };

  const mutate = (mutation: ManagedAccountMutation) => {
    if (!active) return;
    if (mutation.kind === 'add' && mutation.login.trim() === '') return;
    const generation = lifetime.current.generation;
    const selectedAt = selectionSequence.current;
    const token = beginManagedAccountMutation(mutation, consumer.current);
    if (token === null) return;
    const result =
      mutation.kind === 'add'
        ? managedConnectionAdd('github.com', mutation.login)
        : managedConnectionDisable(mutation.connectionId, mutation.expectedRevision);
    void result.then(
      (next) => {
        if (mutation.kind === 'disable' && next.connectionId !== mutation.connectionId) {
          settleManagedAccountMutation(token, 'unknown');
          return;
        }
        const publish = settleManagedAccountMutation(token, 'confirmed');
        if (!publish || !owns(generation)) return;
        // Invalidate list reads started before this confirmed mutation. A list
        // already loaded keeps its cursor; an unread list is read after settlement.
        listSequence.current += 1;
        setListBusy(false);
        if (currentPage.current !== null) {
          const items = new Map(currentPage.current.items.map((item) => [item.connectionId, item]));
          items.set(next.connectionId, next);
          const updated = { ...currentPage.current, items: [...items.values()] };
          currentPage.current = updated;
          setPage(updated);
        }
        if (currentPage.current === null) readList(null, false);
        if (mutation.kind === 'add') {
          if (selectedAt !== selectionSequence.current) return;
          selected.current = next;
          selectionSequence.current += 1;
          setSelection(next);
        } else if (selected.current?.connectionId !== mutation.connectionId) {
          return;
        }
        // Current account identity wins over intermediate selections. Invalidate
        // its precommit reread; another selected account keeps its own read.
        statusSequence.current += 1;
        currentStatus.current = { kind: 'ready', value: next };
        setStatus(currentStatus.current);
      },
      (error: unknown) => {
        const words = managedAccountRefusal(error);
        const publish = settleManagedAccountMutation(
          token,
          words === null ? 'unknown' : 'refused',
          words,
        );
        if (!publish || !owns(generation)) return;
        if (words === null) {
          if (mutation.kind === 'add') {
            // A new opaque ID may sort anywhere in the bounded catalog. Start
            // reconciliation at its beginning and retain the barrier through
            // the final page rather than treating a truncated page as absence.
            listSequence.current += 1;
            currentPage.current = null;
            catalogWalk.current = null;
            setPage(null);
            setListBusy(false);
          }
        } else if (
          mutation.kind === 'disable' &&
          selected.current?.connectionId === mutation.connectionId
        ) {
          currentStatus.current = { kind: 'unavailable' };
          setStatus(currentStatus.current);
        }
      },
    );
  };

  const current = status.kind === 'ready' ? status.value : null;
  const statusUnavailable = status.kind === 'unavailable' || current?.health === 'unavailable';

  return (
    <section
      aria-label="Managed accounts"
      hidden={!active}
      className="mt-5 flex flex-col gap-3 border-t border-n-200 pt-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-ui font-semibold text-n-900">Managed accounts</h3>
        <Button size="sm" disabled={busy} onClick={() => readList(null, true)}>
          Refresh managed accounts
        </Button>
      </div>
      <p className="m-0 text-ui text-(--text-meta)">
        Choose an account, then import its credential in the macOS desktop app. Adding a selection
        does not sign in or grant access to actions.
      </p>
      {listBusy && (
        <p role="status" className="m-0 text-ui text-(--text-meta)">
          Reading managed accounts…
        </p>
      )}
      {listUnavailable && (
        <p data-testid="section-unavailable" className="m-0 text-ui text-warn-700">
          Managed accounts are unavailable. Refresh to check again.
        </p>
      )}
      {page !== null && !listUnavailable && page.items.length === 0 && selection === null && (
        <p className="m-0 text-ui text-(--text-meta)">No managed accounts.</p>
      )}
      {page !== null && page.items.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Account selections">
          {page.items.map((account) => (
            <li key={account.connectionId}>
              <Button
                size="sm"
                aria-pressed={selection?.connectionId === account.connectionId}
                onClick={() => select(account)}
              >
                {account.login}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {page?.nextCursor != null && (
        <div>
          <Button
            size="sm"
            disabled={listBusy || busy}
            onClick={() => readList(page.nextCursor, true)}
          >
            Load more accounts
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-ui text-n-800">
          GitHub login
          <Input
            ariaLabel="GitHub login"
            value={login}
            onChange={(event) => useManagedAccountSession.setState({ login: event.target.value })}
            width="100%"
          />
        </label>
        <span className="pb-1 text-ui text-(--text-meta)">github.com</span>
        <Button
          size="sm"
          disabled={busy || uncertain !== null || login.trim() === ''}
          onClick={() => mutate({ kind: 'add', login })}
        >
          Add account selection
        </Button>
      </div>
      {feedback !== null && (
        <p role="alert" className="m-0 text-ui text-warn-700">
          {feedback}
        </p>
      )}
      <ManagedAccountCredential
        active={active}
        selected={statusUnavailable ? null : current}
        blocked={busy || uncertain !== null}
        onSettled={(connectionId) => {
          const account = selected.current;
          if (account !== null && account.connectionId === connectionId) readStatus(account, true);
        }}
      />
      {selection !== null && (
        <div
          role="group"
          aria-label={`Managed account ${selection.login}`}
          className="flex flex-col gap-2 rounded-lg border border-n-200 p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-ui font-medium text-n-900">{selection.login} · github.com</span>
            <Button size="sm" disabled={busy} onClick={() => readStatus(selection, true)}>
              Refresh account status
            </Button>
          </div>
          {status.kind === 'loading' && (
            <p role="status" className="m-0 text-ui text-(--text-meta)">
              Reading account status…
            </p>
          )}
          {statusUnavailable ? (
            <p data-testid="section-unavailable" className="m-0 text-ui text-warn-700">
              Account status is unavailable. Refresh before changing this account.
            </p>
          ) : (
            current !== null && (
              <>
                <p role="status" className="m-0 text-ui text-n-800">
                  {healthWords(current.health)}
                </p>
                <p className="m-0 text-meta text-(--text-meta)">
                  Status observed {current.observedAt}
                </p>
                {current.cleanupPending && (
                  <p className="m-0 text-ui text-warn-700">
                    Stored credential removal is pending; the credential has not been removed.
                  </p>
                )}
                <p className="m-0 text-ui text-(--text-meta)">
                  Remote revocation was not attempted.
                </p>
                {current.health !== 'disabled' && (
                  <>
                    <p className="m-0 text-ui text-(--text-meta)">
                      Disable in Cerebro disables this selection locally. Credential removal may
                      remain pending. It does not revoke access at GitHub.
                    </p>
                    <div>
                      <Button
                        size="sm"
                        disabled={busy || uncertain !== null}
                        onClick={() => {
                          const latest = currentStatus.current;
                          if (
                            latest.kind !== 'ready' ||
                            latest.value.connectionId !== selected.current?.connectionId
                          )
                            return;
                          mutate({
                            kind: 'disable',
                            connectionId: latest.value.connectionId,
                            login: latest.value.login,
                            expectedRevision: latest.value.revision,
                          });
                        }}
                      >
                        Disable in Cerebro
                      </Button>
                    </div>
                  </>
                )}
              </>
            )
          )}
        </div>
      )}
    </section>
  );
}
