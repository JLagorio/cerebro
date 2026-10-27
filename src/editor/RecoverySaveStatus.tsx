import { Button } from '@/components/ui/Button';
import { useVaultActionGuard } from '@/hooks/useVaultActionGuard';
import { useVaultStore } from '@/stores/vaultStore';
import { useEffect, useState } from 'react';
import { recoveryFailure } from '@/lib/ipc';
import type { RecoveryOutcome } from '@/engine/recovery';
import type { EditorRecoveryView } from '@/lib/generated/workspace';
import type { DocumentOwner } from './documentOwner';

export function recoveryOutcomeText(outcome: RecoveryOutcome | EditorRecoveryView): string | null {
  switch (outcome.kind) {
    case 'off':
      return null;
    case 'without_copy':
      return 'Saved without a recovery copy. Protection remains enabled.';
    case 'not_retained':
      return outcome.reason === 'unchanged'
        ? null
        : `Recovery copy not retained: ${outcome.reason === 'privacy' ? 'this path is excluded for privacy' : outcome.reason === 'entry_limit' ? 'the previous file exceeds the copy size limit' : outcome.reason}.`;
    case 'pending':
      return 'Saved; the recovery copy is pending verification.';
    case 'retained':
      if (outcome.evicted == null)
        return 'Recovery copy retained; the original eviction count was not recorded.';
      return String(outcome.evicted) !== '0'
        ? `Recovery copy retained; ${outcome.evicted} older copies evicted.`
        : null;
  }
}
export function RecoverySaveStatus({
  owner,
  onCheck,
}: {
  owner: DocumentOwner;
  onCheck?: () => void;
}) {
  return (
    <OwnerRecoveryStatus
      key={`${owner.key.vaultId}:${owner.key.path}:${owner.key.ownerId}`}
      owner={owner}
      onCheck={onCheck}
    />
  );
}
function OwnerRecoveryStatus({ owner, onCheck }: { owner: DocumentOwner; onCheck?: () => void }) {
  const startAction = useVaultActionGuard(
    `${owner.key.vaultId}:${owner.key.path}:${owner.key.ownerId}`,
  );
  const [state, setState] = useState(() => owner.snapshot());
  const [permit, setPermit] = useState<{
    nonce: string;
    generation: number;
    expiresAt: number;
    owner: DocumentOwner;
    current: () => boolean;
    body: string;
    format: typeof state.bodyFormat;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setState(owner.snapshot());
    return owner.subscribe(() => setState(owner.snapshot()));
  }, [owner]);
  const failure = state.failure;
  useEffect(() => {
    setPermit(null);
    setError(null);
    if (
      !failure?.code.startsWith('recovery_required:') ||
      failure.generation !== state.generation ||
      state.inFlightGeneration !== null
    )
      return;
    const nonce = failure.code.slice('recovery_required:'.length);
    const origin = startAction();
    const stillCurrent = () => origin() && useVaultStore.getState().vaultPath === owner.key.vaultId;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void recoveryFailure(owner.key.vaultId, owner.key.path, nonce).then(
      (info) => {
        const latest = owner.snapshot();
        if (
          !current ||
          !stillCurrent() ||
          latest.generation !== state.generation ||
          latest.latestDraft !== state.latestDraft ||
          latest.bodyFormat !== state.bodyFormat ||
          latest.failure !== failure ||
          latest.inFlightGeneration !== null
        )
          return;
        const remaining = info.expiresAt * 1000 - Date.now();
        if (remaining <= 0) return;
        setPermit({
          nonce,
          generation: state.generation,
          expiresAt: info.expiresAt,
          owner,
          current: stillCurrent,
          body: state.latestDraft,
          format: state.bodyFormat,
        });
        timer = setTimeout(() => setPermit(null), remaining);
      },
      () => {
        if (current)
          setError('Recovery failure details could not be read. Retry save to try again.');
      },
    );
    return () => {
      current = false;
      if (timer) clearTimeout(timer);
    };
  }, [
    owner,
    startAction,
    failure,
    state.generation,
    state.latestDraft,
    state.bodyFormat,
    state.inFlightGeneration,
  ]);
  const valid =
    permit !== null &&
    permit.owner === owner &&
    permit.current() &&
    permit.body === state.latestDraft &&
    permit.format === state.bodyFormat &&
    permit.generation === state.generation &&
    state.failure?.code === `recovery_required:${permit.nonce}` &&
    state.inFlightGeneration === null;
  const outcome =
    state.recoveryAck?.generation === state.generation && state.failure === null
      ? recoveryOutcomeText(state.recoveryAck.outcome)
      : null;
  return (
    <>
      {state.selectedSave && (
        <p role="status">
          {state.selectedSave.status === 'reconcile'
            ? state.selectedSave.reason === 'refused'
              ? 'This save was refused. Compare your draft with the current page before saving again.'
              : 'The earlier save could not be confirmed. Compare your draft with the current page before saving again.'
            : 'This save is not yet confirmed. Your draft is kept while its original attempt is checked.'}
          {state.selectedSave.status !== 'reconcile' && (
            <>
              {' '}
              <Button
                size="sm"
                variant="ghost"
                type="button"
                disabled={state.inFlightGeneration !== null}
                onClick={() => {
                  if (onCheck) onCheck();
                  else void owner.retry();
                }}
              >
                Check save
              </Button>
            </>
          )}
        </p>
      )}
      {failure?.code.startsWith('recovery_required:') && (
        <p role="alert">
          The recovery copy could not be stored. Your draft is still unsaved. Retry save, or
          explicitly save this draft without a recovery copy.
        </p>
      )}
      {error && <p data-testid="section-unavailable">{error}</p>}
      {valid && (
        <Button
          size="sm"
          variant="ghost"
          type="button"
          onClick={() => {
            if (!permit.current() || permit.expiresAt * 1000 <= Date.now()) {
              setPermit(null);
              return;
            }
            const selected = permit;
            setPermit(null);
            void owner.saveWithoutRecoveryCopy(selected.nonce, selected.generation);
          }}
        >
          Save without a recovery copy
        </Button>
      )}
      {outcome && <p role="status">{outcome}</p>}
    </>
  );
}
