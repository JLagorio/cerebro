import { useEffect, useRef, useSyncExternalStore, type CSSProperties } from 'react';
import { Button } from '@/components/ui/Button';
import type { ConnectionStatus } from '@/lib/generated/actions';
import { hasNativeCredentialImport } from '@/lib/ipc';
import { credentialImportRefusal, credentialImportSession } from './managedCredentialSession';

const accountButtonStyle: CSSProperties = {
  maxWidth: '100%',
  whiteSpace: 'normal',
  overflowWrap: 'anywhere',
  height: 'auto',
  minHeight: 'var(--control-h-sm)',
  paddingBlock: 4,
};

export interface ManagedAccountCredentialProps {
  active: boolean;
  selected: ConnectionStatus | null;
  blocked: boolean;
  onSettled: (connectionId: string) => void;
  session?: typeof credentialImportSession;
}

export function ManagedAccountCredential({
  active,
  selected,
  blocked,
  onSettled,
  session = credentialImportSession,
}: ManagedAccountCredentialProps) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const notify = useRef(onSettled);
  notify.current = onSettled;
  const notified = useRef<string | null>(null);
  useEffect(() => {
    if (active && selected !== null) session.reconcile(selected);
  }, [active, selected, session]);
  useEffect(() => {
    if (!active || state.phase !== 'pending' || state.busy || state.failure !== null) return;
    const timer = window.setTimeout(() => {
      void session.refresh();
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [active, state, session]);
  useEffect(() => {
    if (!active || state.phase !== 'terminal' || state.attempt === null) return;
    const key = `${state.attempt.attemptId}:${state.attempt.state}`;
    if (notified.current === key) return;
    notified.current = key;
    notify.current(state.attempt.connectionId);
  }, [active, state.phase, state.attempt]);

  const original = state.selection?.login;
  const inProgress = ['starting', 'pending', 'unknown'].includes(state.phase);
  const installedAtOldRevision =
    state.attempt?.state === 'installed' &&
    selected?.connectionId === state.attempt.connectionId &&
    selected.revision <= state.attempt.expectedRevision;
  const failed =
    state.attempt?.state === 'failed'
      ? (credentialImportRefusal(state.attempt.error) ??
        'Credential import failed. Refresh account status before trying again.')
      : null;
  return (
    <div hidden={!active} className="flex flex-col gap-2 border-t border-n-200 pt-3">
      <p className="m-0 text-ui text-(--text-meta)">
        Import the selected GitHub CLI credential into macOS Keychain. Actions require separate
        permission.
      </p>
      {!hasNativeCredentialImport() ? (
        <p className="m-0 text-ui text-(--text-meta)">
          Credential import is available in the macOS desktop app.
        </p>
      ) : (
        selected !== null &&
        selected.health !== 'unavailable' && (
          <div>
            <Button
              size="sm"
              style={accountButtonStyle}
              disabled={blocked || state.busy || inProgress || installedAtOldRevision}
              onClick={() => {
                void session.begin(selected);
              }}
            >
              {selected.health === 'ready'
                ? `Replace credential for ${selected.login}`
                : `Import credential for ${selected.login}`}
            </Button>
          </div>
        )
      )}
      {selected === null && state.phase === 'idle' && (
        <p className="m-0 text-ui text-(--text-meta)">
          Select an account above to import its credential.
        </p>
      )}
      {selected?.account === null &&
        selected.health === 'sign_in_required' &&
        state.phase === 'idle' && (
          <p className="m-0 text-ui text-(--text-meta)">
            No credential recorded for {selected.login}.
          </p>
        )}
      {state.phase === 'starting' && (
        <p role="status" className="m-0 text-ui text-n-800">
          Starting credential import for {original}…
        </p>
      )}
      {state.phase === 'pending' && (
        <p role="status" className="m-0 text-ui text-n-800">
          Importing credential for {original}…
        </p>
      )}
      {state.attempt?.state === 'installed' && (
        <p role="status" className="m-0 text-ui text-n-800">
          Credential stored for {original}.
        </p>
      )}
      {state.attempt?.state === 'cancelled' && (
        <p role="status" className="m-0 text-ui text-n-800">
          Import cancelled for {original}. Refresh account status to check any pending cleanup.
        </p>
      )}
      {(state.failure !== null || failed !== null) && (
        <p
          role="alert"
          data-testid={
            state.failure !== null && state.phase === 'pending' ? 'section-unavailable' : undefined
          }
          className="m-0 text-ui text-warn-700"
        >
          {state.failure ?? failed}
        </p>
      )}
      {state.phase === 'pending' && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={state.busy}
            onClick={() => {
              void session.refresh();
            }}
          >
            Check import status
          </Button>
          <Button
            size="sm"
            disabled={state.busy}
            onClick={() => {
              void session.cancel();
            }}
            style={accountButtonStyle}
          >
            Cancel import for {original}
          </Button>
        </div>
      )}
    </div>
  );
}
