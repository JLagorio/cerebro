import { useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/Button';
import { useOpenPath } from '@/app/useOpenPath';
import { useVaultStore } from '@/stores/vaultStore';
import type {
  WorkspaceBackupDisposition,
  WorkspaceBackupLabels,
  WorkspaceBackupSummary,
} from '@/lib/generated/workspace';
import type { BackupWorkflow } from './backupWorkflow';
import { workspaceBackupWorkflow } from './useWorkspaceBackup';

function Locations({ labels }: { labels: WorkspaceBackupLabels }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {(
        [
          ['Source', labels.source],
          ['Backup', labels.input],
          ['Destination', labels.output],
        ] as const
      ).map(([label, path]) =>
        path ? (
          <div key={label} className="contents">
            <dt className="text-(--text-meta)">{label}</dt>
            <dd className="min-w-0 break-all [font-family:var(--font-mono)]">{path}</dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}
function Summary({ summary }: { summary: WorkspaceBackupSummary }) {
  const bytes = /^\d{1,30}$/.test(summary.totalBytes)
    ? `${BigInt(summary.totalBytes).toLocaleString()} bytes`
    : 'Size unavailable';
  return (
    <div className="space-y-2 text-xs">
      <p>
        {summary.partCount} parts · {bytes}
      </p>
      {summary.omissions.length > 0 && (
        <div>
          <p className="font-medium">Not included</p>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {summary.omissions.map((value, index) => (
              <li key={`${index}:${value}`}>{value.replaceAll('_', ' ')}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
function Disposition({ value }: { value: WorkspaceBackupDisposition }) {
  const messages: Record<WorkspaceBackupDisposition['kind'], string> = {
    none_created: 'No output was created.',
    creation_uncertain:
      'Creation could not be confirmed. Check the selected location before another attempt.',
    incomplete: 'An incomplete copy remains at this location. It has been kept for inspection.',
    completion_unknown: 'Completion is unknown. Check the selected copy before another attempt.',
    completed: 'The copy completed.',
    completed_but_response_unavailable:
      'The copy completed, but its detailed response is unavailable.',
  };
  const location = 'location' in value ? value.location : null;
  return (
    <div className="space-y-1 text-xs">
      <p>{messages[value.kind]}</p>
      {location && (
        <>
          <p className="break-all [font-family:var(--font-mono)]">{location.displayLocation}</p>
          <p className="text-(--text-meta)">
            {location.verification === 'verified'
              ? 'Location verified when the operation ended.'
              : location.verification === 'original_spelling_only'
                ? 'Original location shown; the copy may have moved.'
                : 'The location could not be verified.'}
          </p>
        </>
      )}
    </div>
  );
}
function choiceExpiry(value?: string | null) {
  if (!value || !/^\d{1,16}$/.test(value)) return null;
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;
}
export function WorkspaceBackupSettings({
  workflow = workspaceBackupWorkflow,
}: {
  workflow?: BackupWorkflow;
}) {
  const state = useSyncExternalStore(
    workflow.subscribe,
    workflow.getSnapshot,
    workflow.getSnapshot,
  );
  const currentVault = useVaultStore((value) => value.vaultPath);
  const openPath = useOpenPath();
  const { availability, operation } = state;
  const active =
    !!state.busy ||
    state.uncertain ||
    ['choosing', 'pending', 'running'].includes(operation?.kind ?? 'none');
  const canCreate = availability?.kind === 'available' || availability?.kind === 'preview';
  const canCheck =
    availability?.kind === 'preview' ||
    (availability && 'checkRestore' in availability && availability.checkRestore);
  const review = operation?.kind === 'pending' ? operation.review : null;
  const expiry = choiceExpiry(review?.expiresAt);
  return (
    <section
      aria-label="Backups"
      className="mt-5 flex flex-col gap-3 border-t border-n-200 pt-4 text-sm"
    >
      <div>
        <h3 className="font-semibold">Backups</h3>
        <p className="mt-1 text-(--text-meta)">
          Keep a complete copy of saved pages and workspace metadata.
        </p>
      </div>
      {availability === null && !state.message && (
        <p role="status" className="text-xs text-(--text-meta)">
          Reading backup availability…
        </p>
      )}
      {availability?.kind === 'unsupported_current_vault' && (
        <p className="text-xs text-(--text-meta)">{availability.message}</p>
      )}
      {availability?.kind === 'unsupported_platform' && (
        <p className="text-xs text-(--text-meta)">Backups are not available on this platform.</p>
      )}
      {availability?.kind === 'preview' && (
        <p className="text-xs text-(--text-meta)">{availability.message}</p>
      )}
      {availability?.kind === 'unavailable' && (
        <p role="alert" data-testid="section-unavailable" className="text-xs">
          {availability.refusal.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={active || !canCreate}
          onClick={() => void workflow.chooseCreate()}
        >
          Create backup…
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={active || !canCheck}
          onClick={() => void workflow.check()}
        >
          Check a backup…
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={active || !canCheck}
          onClick={() => void workflow.check()}
        >
          Restore a separate copy…
        </Button>
      </div>
      {state.busy && (
        <p role="status" className="text-xs">
          {state.busy === 'saving'
            ? 'Saving open pages…'
            : state.busy === 'choosing'
              ? 'Complete the choice in the system dialog…'
              : state.busy === 'cancelling'
                ? 'Releasing the pending choice…'
                : 'Starting the copy…'}
        </p>
      )}
      {state.message && (
        <p
          role="alert"
          data-testid={state.uncertain ? 'section-unavailable' : undefined}
          className="text-xs"
        >
          {state.message}
        </p>
      )}
      {state.blocked.length > 0 && (
        <ul aria-label="Drafts that need saving" className="space-y-1">
          {state.blocked.map(({ key, participantId }) => (
            <li key={participantId}>
              {key.vaultId === currentVault && key.path ? (
                <Button variant="ghost" size="sm" onClick={() => openPath(key.path)}>
                  {key.path}
                </Button>
              ) : (
                <span className="text-xs">
                  {key.path || 'Retained draft'} · open its original vault to finish saving
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {state.refusal && <Disposition value={state.refusal.output} />}
      {review && (
        <div
          className="space-y-3 rounded-lg border border-n-200 bg-n-25 p-3"
          aria-label="Review backup operation"
        >
          <p className="font-medium">
            {review.mode === 'create'
              ? 'Review new backup'
              : review.mode === 'check'
                ? 'Backup checked'
                : 'Review separate restore'}
          </p>
          <Locations labels={review.labels} />
          {review.summary && <Summary summary={review.summary} />}
          <p className="text-xs text-(--text-meta)">
            {review.mode === 'create'
              ? 'Open pages must finish saving first. The copy contains saved content at the snapshot; later draft edits may be outside it.'
              : review.mode === 'restore'
                ? 'Creates a separate inactive copy with Pages and Workspace data folders. A separate activation step is required before it can be opened as a workspace.'
                : 'This check validates the selected bundle. Restore validates it again before creating a separate copy.'}
          </p>
          {expiry && (
            <p className="text-xs text-(--text-meta)">
              Choice expires at {expiry}. The desktop app checks expiry when you continue.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {review.mode === 'check' ? (
              <Button
                size="sm"
                disabled={!!state.busy || state.uncertain}
                onClick={() => void workflow.chooseRestore()}
              >
                Choose restore destination…
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={!!state.busy || state.uncertain}
                onClick={() => void workflow.commit()}
              >
                {review.mode === 'create'
                  ? 'Save pages and create backup'
                  : 'Restore separate copy'}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={!!state.busy}
              onClick={() => void workflow.cancel()}
            >
              Cancel choice
            </Button>
          </div>
        </div>
      )}
      {operation?.kind === 'choosing' && !state.busy && (
        <p role="status" className="text-xs">
          A backup choice is open in the desktop app.
        </p>
      )}
      {operation?.kind === 'running' && (
        <div
          role="status"
          aria-label="Backup in progress"
          className="space-y-2 rounded-lg border border-n-200 bg-n-25 p-3"
        >
          <p className="font-medium">
            {operation.mode === 'restore' ? 'Restoring a separate copy…' : 'Creating backup…'}
          </p>
          <Locations labels={operation.labels} />
          <p className="text-xs text-(--text-meta)">
            You can leave Settings while this runs. Quitting the app can leave an incomplete copy.
          </p>
        </div>
      )}
      {operation?.kind === 'terminal' && (
        <div
          aria-label="Backup result"
          className="space-y-2 rounded-lg border border-n-200 bg-n-25 p-3"
        >
          <p className="font-medium">
            {operation.result.kind === 'completed'
              ? operation.mode === 'restore'
                ? 'Separate copy restored'
                : 'Backup completed'
              : 'Backup needs attention'}
          </p>
          <Locations labels={operation.labels} />
          {operation.result.kind === 'completed' ? (
            <>
              {operation.result.summary && <Summary summary={operation.result.summary} />}
              <Disposition value={operation.result.output} />
            </>
          ) : (
            <>
              <p className="text-xs">{operation.result.refusal.message}</p>
              <Disposition value={operation.result.refusal.output} />
            </>
          )}
          {operation.mode === 'restore' && operation.result.kind === 'completed' && (
            <p className="text-xs text-(--text-meta)">The restored copy is inactive.</p>
          )}
        </div>
      )}
      {operation?.kind === 'preview' && (
        <p className="text-xs text-(--text-meta)">{operation.message}</p>
      )}
      <div>
        <Button
          variant="ghost"
          size="sm"
          disabled={!!state.busy}
          onClick={() => {
            void workflow.refresh(true);
            void workflow.refreshAvailability();
          }}
        >
          Check status
        </Button>
      </div>
    </section>
  );
}
