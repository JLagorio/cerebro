import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { useVaultActionGuard } from '@/hooks/useVaultActionGuard';
import * as ipc from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';
import { useUndoStore } from '@/stores/undoStore';
import { sha256Hex } from '@/lib/sha256';
import { readCanvas } from '@/engine/scene/jsonCanvas';
import {
  canCreateRecoveryPage,
  canExportRawRecovery,
  copyRecovery,
  discardRecovery,
  holdRecovery,
  inspectRawRecovery,
  recoveryDrafts,
  recoveryEpoch,
  recoveryHoldFor,
  resumeRecovery,
  saveRecoveryAs,
  subscribeRecovery,
  type RecoveryDraft,
  type RecoveryRef,
  type RecoveryResult,
  type RawRestoreChoice,
} from './deletedDraftRecovery';

function words(result: RecoveryResult): string | null {
  switch (result.kind) {
    case 'copied':
      return 'Copied. Your original draft is still kept.';
    case 'exported':
      return 'Recovery file saved. Your original draft is still kept.';
    case 'created':
      return `Created ${result.path}. Your original draft is still kept.${result.refreshFailed ? ' The page list could not be refreshed.' : ''}`;
    case 'blocked':
      return result.reason === 'in_flight'
        ? 'Wait for the pending operation. Your draft is kept.'
        : result.reason === 'changed'
          ? 'The draft changed. Review its latest text and try again.'
          : 'This draft cannot be saved as a page. Save a recovery file instead.';
    case 'failed':
      return result.message;
    default:
      return null;
  }
}
function RecoveryCard({ draft, index }: { draft: RecoveryDraft; index: number }) {
  const { key } = draft.ref;
  const start = useVaultActionGuard(
    JSON.stringify([key.vaultId, key.path, key.ownerId, draft.ref.instanceId]),
  );
  const [target, setTarget] = useState<'checking' | 'missing' | 'present' | 'unavailable'>(
    'checking',
  );
  const [probe, setProbe] = useState(0),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<RecoveryRef | null>(null),
    [saveAs, setSaveAs] = useState<RecoveryRef | null>(null);
  const [destination, setDestination] = useState(key.path.replace(/\.md$/, '-recovered.md'));
  const [rawChoice, setRawChoice] = useState<RawRestoreChoice | null>(null);
  const readRaw = async () => {
    const text = await ipc.readNote(key.vaultId, key.path);
    return { text, hash: sha256Hex(text) };
  };
  const readRestored = async () => {
    if (draft.payload.kind === 'canvas') {
      const result = await ipc.readCanvasFile(key.vaultId, key.path);
      if (!result.ok || !readCanvas(result.content).ok) throw new Error('unreadable');
    } else if (draft.payload.body?.format === 'source') {
      await ipc.readNoteSource(key.vaultId, key.path);
    } else {
      await ipc.readNote(key.vaultId, key.path);
    }
  };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const current = start();
    let live = true;
    setTarget('checking');
    void ipc
      .probeDraftTarget(key.vaultId, key.path)
      .then((answer) => {
        if (!live || !current()) return;
        setTarget(answer.kind);
        if (answer.kind === 'missing') holdRecovery(draft.ref);
      })
      .catch(() => {
        if (live && current()) setTarget('unavailable');
      });
    return () => {
      live = false;
    };
  }, [key.vaultId, key.path, draft.ref, probe, start]);
  const run = async (work: (current: () => boolean) => Promise<RecoveryResult>) => {
    const current = start();
    setBusy(true);
    setMessage(null);
    try {
      const result = await work(current);
      if (current()) setMessage(words(result));
    } finally {
      // Release only this card's completed operation lock. Result messages and
      // owner mutations remain guarded by the originating vault epoch.
      if (mounted.current) setBusy(false);
    }
  };
  const doors = {
    choose: ipc.chooseDraftExport,
    commit: ipc.commitDraftExport,
    cancel: ipc.cancelDraftExport,
    create: ipc.createRecoveredPage,
    refresh: () => useVaultStore.getState().rescan(),
    record: (batch: import('@/engine/batch').BatchApplied) =>
      useUndoStore.getState().pushBatch('Recover draft as new page', key.vaultId, batch.files),
  };
  const label = draft.payload.field
    ? `Property: ${draft.payload.field.name}`
    : key.ownerId === 'peek'
      ? 'Preview draft'
      : `Page draft ${index + 1}`;
  return (
    <section
      className="my-4 rounded-lg border border-n-200 bg-surface-raised p-4"
      aria-label={label}
      data-recovery-owner={key.ownerId}
    >
      <h2 className="m-0 text-section-title font-semibold">{label}</h2>
      <p className="text-sm text-n-600">{key.path}</p>
      {draft.state.failure !== null && (
        <p role="alert">
          Could not save this draft. It is kept; reload the restored file to review its current
          version, or copy your draft.
        </p>
      )}
      {draft.deferredAdmission && (
        <p role="status">
          Another draft owns this path after a move. This separate draft is kept; copy, save as, or
          discard only this draft.
        </p>
      )}
      <p role="status">
        {target === 'missing'
          ? 'The original file is missing. Your unsaved draft is kept in this session.'
          : target === 'unavailable'
            ? 'Could not check the original file. Your draft is kept.'
            : target === 'present'
              ? 'The original file exists. Reload to reconcile your retained draft.'
              : 'Checking the original file. Your draft is kept.'}
      </p>
      <p className="text-sm text-n-600">
        Original properties are unavailable. Recovery does not reconstruct them.
      </p>
      {draft.state.inFlightGeneration !== null && (
        <p>Copy takes a snapshot while a write is pending. A later save result is separate.</p>
      )}
      <textarea
        aria-label={`${label} retained text`}
        readOnly
        value={draft.payload.field?.text ?? draft.payload.body?.text ?? ''}
        className="min-h-32 w-full rounded-md border border-n-200 bg-transparent p-3 font-mono text-sm"
      />
      {Object.keys(draft.payload.children).length > 0 && (
        <details>
          <summary>
            Child drafts are kept separately; they have not been saved into the body.
          </summary>
          {Object.entries(draft.payload.children).map(([name, text]) => (
            <div key={name}>
              <h3>{name}</h3>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{text}</pre>
            </div>
          ))}
        </details>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            void run((current) => copyRecovery(draft.ref, false, ipc.writeClipboard, current))
          }
        >
          {draft.payload.field ? 'Copy value' : 'Copy body'}
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            void run((current) => copyRecovery(draft.ref, true, ipc.writeClipboard, current))
          }
        >
          Copy recovery data
        </Button>
        <Button size="sm" disabled={busy} onClick={() => setSaveAs(draft.ref)}>
          Save as…
        </Button>
        <Button size="sm" disabled={busy || draft.busy} onClick={() => setConfirm(draft.ref)}>
          Discard this draft
        </Button>
        <Button
          size="sm"
          disabled={busy || draft.deferredAdmission}
          onClick={() => {
            if (target !== 'present') {
              setProbe((value) => value + 1);
              return;
            }
            void run(async (current) => {
              const answer = await ipc.probeDraftTarget(key.vaultId, key.path);
              if (!current()) return { kind: 'retired' };
              if (answer.kind !== 'present') {
                setProbe((value) => value + 1);
                return { kind: 'blocked', reason: 'unavailable' };
              }
              const checked =
                draft.payload.kind === 'mermaid'
                  ? await inspectRawRecovery(draft.ref, current, readRaw)
                  : await resumeRecovery(draft.ref, current, readRestored);
              if (checked.kind === 'restore_choice') {
                if (current()) setRawChoice(checked.choice);
                return { kind: 'cancelled' };
              }
              const result = checked;
              if (result.kind !== 'resumed') return result;
              try {
                await useVaultStore.getState().rescan();
              } catch {
                return {
                  kind: 'failed',
                  message: 'Could not refresh the restored page. Your draft is kept.',
                };
              }
              return result;
            });
          }}
        >
          {target === 'present' ? 'Reload restored page' : 'Check again'}
        </Button>
      </div>
      {rawChoice && (
        <section aria-label="Restored diagram choice">
          <p>
            The restored file differs from your draft. Choose which complete source to keep; no
            choice writes automatically.
          </p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{rawChoice.source.text}</pre>
          <div className="flex gap-2">
            {(['mine', 'theirs'] as const).map((pick) => (
              <Button
                key={pick}
                disabled={busy || draft.busy}
                onClick={() =>
                  void run(async (current) => {
                    const result = await inspectRawRecovery(rawChoice.ref, current, readRaw, {
                      source: rawChoice.source,
                      pick,
                    });
                    if (result.kind === 'restore_choice')
                      return { kind: 'blocked', reason: 'changed' };
                    if (current()) setRawChoice(null);
                    return result;
                  })
                }
              >
                {pick === 'mine' ? 'Use my draft' : 'Use restored file'}
              </Button>
            ))}
          </div>
          <p>
            Use my draft saves your exact body against this file version. Use restored file replaces
            your local body with these bytes.
          </p>
        </section>
      )}
      {message && <p role="status">{message}</p>}
      <Dialog
        open={confirm !== null}
        title="Discard retained draft?"
        onClose={() => setConfirm(null)}
        primaryAction={{
          label: 'Discard permanently',
          disabled: busy || draft.busy,
          onClick: () => {
            const ref = confirm;
            if (!ref) return;
            const current = start();
            if (!current()) return;
            const result = discardRecovery(ref);
            setConfirm(null);
            if (current()) setMessage(words(result));
          },
        }}
        secondaryAction={{ label: 'Keep draft', onClick: () => setConfirm(null) }}
      >
        <p>
          This discards {label.toLowerCase()} for {key.path}, including{' '}
          {Object.keys(draft.payload.children).length} child draft groups. Copy or export first if
          you want to keep them. Other page drafts, properties, grants and comments are not
          submitted or discarded.
        </p>
      </Dialog>
      <Dialog
        open={saveAs !== null}
        title="Save retained draft as"
        onClose={() => {
          if (!busy) setSaveAs(null);
        }}
        secondaryAction={{ label: 'Cancel', disabled: busy, onClick: () => setSaveAs(null) }}
      >
        <p>
          A recovery file keeps the exact body and all child drafts as data. It does not restore the
          original file.
        </p>
        <Button
          disabled={busy}
          onClick={() => {
            const ref = saveAs;
            if (ref) void run((current) => saveRecoveryAs(ref, { kind: 'bundle' }, current, doors));
          }}
        >
          Save recovery file
        </Button>
        {canExportRawRecovery(draft) && (
          <Button
            disabled={busy}
            onClick={() => {
              const ref = saveAs;
              if (ref) void run((current) => saveRecoveryAs(ref, { kind: 'raw' }, current, doors));
            }}
          >
            Save source copy
          </Button>
        )}
        {canCreateRecoveryPage(draft) ? (
          <div className="mt-4">
            <label>
              New page path
              <Input
                ariaLabel="New recovery page path"
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
              />
            </label>
            <p>
              Body only. Original properties and pending property drafts are not applied. The
              original draft is kept.
            </p>
            <Button
              disabled={busy || draft.busy || target !== 'missing'}
              onClick={() => {
                const ref = saveAs;
                if (ref)
                  void run((current) =>
                    saveRecoveryAs(ref, { kind: 'page', path: destination }, current, doors),
                  );
              }}
            >
              Create new page
            </Button>
          </div>
        ) : (
          <p>
            This draft needs a recovery file; uncommitted children and governed projections cannot
            be recreated as an ordinary page here.
          </p>
        )}
        {message && <p role="status">{message}</p>}
      </Dialog>
    </section>
  );
}
/** A missing host never needs to reconstruct an Entry or mount its writers. */
export function DeletedDraftRecovery({
  vaultId,
  path,
  fallback,
  frame,
}: {
  vaultId: string | null;
  path: string;
  fallback: ReactNode;
  frame?: (content: ReactNode) => ReactNode;
}) {
  useSyncExternalStore(subscribeRecovery, recoveryEpoch, recoveryEpoch);
  const drafts = vaultId === null ? [] : recoveryDrafts({ vaultId, path });
  if (!drafts.length) return fallback;
  const content = (
    <div className="min-w-0 flex-1 overflow-auto p-6" data-testid="deleted-draft-recovery">
      <h1 className="m-0 text-page-title">Recover unsaved draft</h1>
      {drafts.map((draft, index) => (
        <RecoveryCard key={draft.ref.instanceId} draft={draft} index={index} />
      ))}
    </div>
  );
  return frame ? frame(content) : content;
}
export function useRecoveryHold(vaultId: string | null, path: string): boolean {
  const read = useCallback(
    () => vaultId !== null && recoveryHoldFor({ vaultId, path }),
    [vaultId, path],
  );
  return useSyncExternalStore(subscribeRecovery, read, read);
}
