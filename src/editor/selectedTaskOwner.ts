// Checklist composition over the existing retained owner and paired IPC door.
// This module has no storage, grant or recovery decision implementation.
import type { SelectedEditorSnapshot } from '@/lib/generated/workspace';
import { saveNoteBody } from '@/lib/ipc';
import { DocumentOwner, type DocumentWriteResult } from './documentOwner';
import { prepareSelectedTitle } from './selectedTitleDraft';
import {
  announceExternalWrites,
  registerSaveParticipant,
  releaseDocumentOwner,
  retainDocumentOwner,
  retainedDocumentOwner,
  unresolvedDocumentOwners,
} from './openPages';
const announced = new WeakSet<DocumentOwner>();
const managed = new WeakMap<DocumentOwner, { leases: number; releaseClean: () => void }>();
const lastFailure = new WeakMap<DocumentOwner, unknown>();
const prefix = 'checklist:';
const titlePrefix = 'title:';
export function selectedTitleOwners(vault: string): DocumentOwner[] {
  return unresolvedDocumentOwners().filter(
    (owner) =>
      owner.key.vaultId === vault &&
      owner.key.ownerId.startsWith(titlePrefix) &&
      owner.selectedTarget !== undefined,
  );
}
export function titleOwnerPresented(owner: DocumentOwner): boolean {
  return (managed.get(owner)?.leases ?? 0) > 0;
}
export function attachSelectedTitleOwner(owner: DocumentOwner): () => void {
  manage(owner);
  const slot = managed.get(owner)!;
  slot.leases += 1;
  let attached = true;
  return () => {
    if (!attached) return;
    attached = false;
    slot.leases -= 1;
    const state = owner.snapshot();
    owner.present(state.latestDraft, state.bodyFormat ?? 'source');
    slot.releaseClean();
  };
}
export function selectedTaskOwners(vault: string): DocumentOwner[] {
  return unresolvedDocumentOwners().filter(
    (owner) =>
      owner.key.vaultId === vault &&
      owner.key.ownerId.startsWith(prefix) &&
      owner.selectedTarget !== undefined,
  );
}
function manage(owner: DocumentOwner): void {
  if (managed.has(owner)) return;
  const stop = registerSaveParticipant({
    identity: owner,
    key: owner.key,
    prepare: () => {
      if (owner.key.ownerId.startsWith(titlePrefix)) prepareSelectedTitle(owner);
    },
    snapshot: () => owner.snapshot(),
    flush: () => owner.flush(),
  });
  let queued = false;
  const clean = () => {
    const state = owner.snapshot();
    return (
      !owner.recoveryBusy() &&
      state.selectedSave === undefined &&
      state.failure === null &&
      state.generation === state.acknowledgedGeneration &&
      state.reconcileRequired !== true &&
      Object.keys(state.childDrafts ?? {}).length === 0 &&
      (managed.get(owner)?.leases ?? 0) === 0
    );
  };
  const releaseClean = () => {
    if (queued || !clean()) return;
    queued = true;
    // Actual acknowledgement observers run before removing their presentation;
    // all original request/resources are already settled. Recheck before release.
    queueMicrotask(() => {
      queued = false;
      if (!clean()) return;
      unsubscribe();
      stop();
      releaseDocumentOwner(owner);
      managed.delete(owner);
    });
  };
  const unsubscribe = owner.subscribe(releaseClean);
  managed.set(owner, { leases: 0, releaseClean });
}
export function selectedTaskOwner(vault: string, snapshot: SelectedEditorSnapshot): DocumentOwner {
  return selectedTransformOwner(vault, snapshot, prefix);
}
export function selectedTitleOwner(vault: string, snapshot: SelectedEditorSnapshot): DocumentOwner {
  return selectedTransformOwner(vault, snapshot, titlePrefix);
}
function selectedTransformOwner(
  vault: string,
  snapshot: SelectedEditorSnapshot,
  ownerPrefix: string,
): DocumentOwner {
  const key = {
    vaultId: vault,
    path: snapshot.path,
    ownerId: ownerPrefix + snapshot.target.workspaceId + ':' + snapshot.target.recordId,
  };
  const retained = retainedDocumentOwner(key);
  if (retained !== undefined) {
    manage(retained);
    return retained;
  }
  const owner: DocumentOwner = retainDocumentOwner(
    key,
    snapshot.body,
    async (body, bodyFormat, recoveryBypass, _hash, destination, editorRequest) => {
      if (!destination || !editorRequest) throw new Error('selected_task_request_unavailable');
      let result: DocumentWriteResult | undefined;
      let failed = false;
      let failure: unknown;
      const write = async () => {
        lastFailure.delete(owner);
        try {
          result = await saveNoteBody({
            vault: destination.vaultId,
            path: destination.path,
            body,
            bodyFormat,
            recoveryBypass,
            editorRequest,
          });
        } catch (error) {
          failed = true;
          failure = error;
          lastFailure.set(owner, error);
        }
      };
      if (announced.has(owner)) await write();
      else await announceExternalWrites([destination.path], write);
      if (failed) throw failure;
      if (result === undefined) throw new Error('selected_task_outcome_unknown');
      return result;
    },
    snapshot.target,
  );
  if (ownerPrefix === titlePrefix) owner.present(snapshot.body, 'source');
  manage(owner);
  return owner;
}
/** The initial hook already holds this path through fresh read and refresh.
 * Later Check save/resolution uses the same callback's own announcement. */
export async function flushAnnouncedTask(owner: DocumentOwner) {
  announced.add(owner);
  try {
    return await owner.flush();
  } finally {
    announced.delete(owner);
  }
}
/** A generated tick with definite pre-intent refusal is not a user text draft.
 * Unknown/pending attempts are deliberately ineligible for retirement. */
export function retireRefusedTask(owner: DocumentOwner): void {
  if (
    owner.snapshot().selectedSave === undefined &&
    owner.snapshot().failure !== null &&
    !owner.recoveryBusy()
  )
    owner.retireRecovery();
}

/** undefined retains the existing stale-conflict refresh wording. Other
 * definite failures get finite feedback; private recovery nonces stay private. */
export function selectedTaskRefusalMessage(owner: DocumentOwner, code: string): string | undefined {
  if (code.startsWith('recovery_required:') || code === 'recovery_bypass_invalid')
    return 'The task was not saved because its recovery copy could not be stored. Open the page to review recovery options.';
  const failure = lastFailure.get(owner);
  if (
    typeof failure === 'object' &&
    failure !== null &&
    'kind' in failure &&
    failure.kind === 'selected_refused' &&
    'error' in failure &&
    typeof failure.error === 'object' &&
    failure.error !== null
  ) {
    const error = failure.error;
    if (
      'kind' in error &&
      ['stale_metadata', 'source_changed', 'wrong_identity'].includes(String(error.kind))
    )
      return undefined;
    if ('message' in error && typeof error.message === 'string')
      return 'The task was not saved. ' + error.message;
  }
  return 'The task save could not be started. Open the page to review it and try again.';
}
