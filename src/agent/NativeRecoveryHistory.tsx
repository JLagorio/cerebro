import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Item, ItemContent, ItemTitle } from '@/components/ai/Item';
import { Button } from '@/components/ui/Button';
import type { InvocationState } from '@/lib/generated/actions';
import type { NativeRecoveryRoot } from './types';
import { RecoveryInspection } from './recoveryInspection';

const labels: Record<InvocationState, string> = {
  prepared: 'Prepared',
  awaiting_approval: 'Waiting for approval',
  ready: 'Ready',
  dispatched: 'Dispatched',
  succeeded: 'Succeeded',
  failed: 'Failed',
  outcome_unknown: 'Outcome unknown',
  cancelled: 'Cancelled',
};
const missing = 'The original run is not available from this reply.';

export function NativeRecoveryHistory({ root }: { root: NativeRecoveryRoot | null }) {
  return (
    <section aria-label="Managed action history" className="min-w-0">
      <h3 className="m-0 mb-1 text-sm font-medium text-n-800">Managed action history</h3>
      {root === null ? (
        <p className="m-0 text-sm text-n-600">{missing}</p>
      ) : (
        <OriginalRunHistory runId={root.runId} vaultPath={root.vaultPath} opening={root.opening} />
      )}
    </section>
  );
}

function OriginalRunHistory({ runId, vaultPath, opening }: NativeRecoveryRoot) {
  const read = useMemo(
    () => new RecoveryInspection({ runId, vaultPath, opening }),
    [runId, vaultPath, opening],
  );
  const state = useSyncExternalStore(read.subscribe, read.snapshot, read.snapshot);
  useEffect(() => read.start(), [read]);
  if (state.kind === 'retired') return <p className="m-0 text-sm text-n-600">{missing}</p>;
  return (
    <div className="flex min-w-0 flex-col gap-2 text-sm text-n-700">
      {state.kind === 'loading' && (
        <p role="status" className="m-0">
          Reading managed action history…
        </p>
      )}
      {state.kind === 'unavailable' && (
        <p role="status" className="m-0">
          Managed action history is unavailable.
        </p>
      )}
      {state.kind === 'loaded' && (
        <>
          {state.value.brokerInventory.state === 'incomplete' && (
            <p className="m-0">Managed action history is incomplete.</p>
          )}
          {state.value.brokerInventory.state === 'complete' &&
            state.value.brokerInventory.observedCount === 0 &&
            state.value.effects.length === 0 && (
              <p className="m-0">No managed actions were recorded for this run.</p>
            )}
          {state.value.effects.map((row) => (
            <Item key={row.effect.invocationId} variant="outline" size="sm">
              <ItemContent className="min-w-0">
                <ItemTitle>{labels[row.effect.state]}</ItemTitle>
                {row.detailsRead === 'available' && row.details !== null ? (
                  <>
                    {row.details.account !== null && (
                      <p className="m-0">{row.details.account.label}</p>
                    )}
                    <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
                      {row.details.preview.summary}
                    </p>
                    {row.details.target !== null && (
                      <p className="m-0 [overflow-wrap:anywhere]">{row.details.target.label}</p>
                    )}
                  </>
                ) : (
                  <p className="m-0">
                    {row.detailsRead === 'denied'
                      ? 'Action details are no longer accessible.'
                      : 'Action details are unavailable.'}
                  </p>
                )}
              </ItemContent>
            </Item>
          ))}
          <p className="m-0 text-xs text-n-600">
            Actions outside managed connectors are not covered.
          </p>
          <p className="m-0 text-xs text-n-600">
            Other attempts in this conversation are not covered.
          </p>
        </>
      )}
      <Button
        className="self-start"
        size="sm"
        variant="ghost"
        disabled={state.kind === 'loading'}
        onClick={() => void read.refresh()}
      >
        Refresh action history
      </Button>
    </div>
  );
}
