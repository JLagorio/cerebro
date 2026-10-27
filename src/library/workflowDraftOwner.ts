import {
  createWorkflowEditorSession,
  type WorkflowEditorApi,
  type WorkflowEditorState,
} from './workflowEditorSession';
import editorPolicy from '../../shared/workflows/editor.v1.json';
import {
  workflowSave,
  workflowPublish,
  workflowUnpublish,
  workflowDocument,
  workflowValidate,
} from '@/lib/ipc';
import type {
  WorkflowContext,
  WorkflowDraft,
  WorkflowDraftSnapshot,
  WorkflowPublication,
} from '@/lib/generated/workflows';
import type { SaveParticipant } from '@/editor/saveParticipants';
const owners = new Map<string, WorkflowDraftOwner>();
const ownerSources = new WeakMap<WorkflowDraftOwner, WorkflowEditorApi>();
const ownerIdentities = new WeakMap<
  WorkflowDraftOwner,
  { vault: string; vaultId: string; storeUuid: string; workflowId: string }
>();
const listeners = new Set<() => void>();
let revision = 0;
const changed = () => {
  revision++;
  for (const listener of [...listeners]) listener();
};
const ownerKey = (vault: string, context: WorkflowContext, workflowId: string) =>
  JSON.stringify([vault, context.vaultId, context.storeUuid, workflowId]);
const nativeEditorApi: WorkflowEditorApi = {
  save: workflowSave,
  publish: workflowPublish,
  unpublish: workflowUnpublish,
  document: workflowDocument,
  validate: workflowValidate,
};
export interface WorkflowDraftOwner {
  session: ReturnType<typeof createWorkflowEditorSession>;
  participant: SaveParticipant;
  mount: () => () => void;
}
/** The existing save registry retains unsaved/ambiguous editors after unmount. */
export function retainWorkflowDraft(
  vault: string,
  context: WorkflowContext,
  draft: WorkflowDraft,
  saved: WorkflowDraftSnapshot | null,
  publication: WorkflowPublication | null,
  api: WorkflowEditorApi = nativeEditorApi,
  publicationRevision: number = publication?.revision ?? 0,
): WorkflowDraftOwner | null {
  const id = ownerKey(vault, context, draft.workflowId);
  const existing = owners.get(id);
  if (existing !== undefined) return ownerSources.get(existing) === api ? existing : null;
  if (
    editorPolicy.formatVersion !== 1 ||
    !Number.isSafeInteger(editorPolicy.maxRetainedSessions) ||
    editorPolicy.maxRetainedSessions < 1 ||
    owners.size >= editorPolicy.maxRetainedSessions
  )
    return null;
  const session = createWorkflowEditorSession(
    {
      save: api.save,
      publish: api.publish,
      document: api.document,
      validate: api.validate,
      ...(api.unpublish === undefined ? {} : { unpublish: api.unpublish }),
    },
    context,
    draft,
    saved,
    publication,
    { publicationRevision },
  );
  const key = {
    vaultId: vault,
    path: '.cerebro/workflows/' + draft.workflowId + '/draft.json',
    ownerId: 'workflow:' + context.storeUuid + ':' + draft.workflowId,
  };
  let generation = session.getSnapshot().dirty ? 1 : 0;
  let acknowledged = 0;
  let latest = JSON.stringify(session.getSnapshot().draft);
  const held = () => session.getSnapshot().dirty || session.getSnapshot().phase !== 'idle';
  let mounts = 0;
  let mountedOnce = false;
  let retired = false;
  let releaseSequence = 0;
  const release = () => {
    if (retired || !session.retire()) return;
    retired = true;
    releaseSequence++;
    unsubscribe();
    if (owners.get(id) === owner) {
      owners.delete(id);
      changed();
    }
  };
  const releaseIfSettled = () => {
    const sequence = ++releaseSequence;
    if (!mountedOnce || mounts !== 0 || held() || retired) return;
    queueMicrotask(() => {
      if (sequence === releaseSequence && mounts === 0 && !held() && !retired) release();
    });
  };
  const unsubscribe = session.subscribe(() => {
    const next = JSON.stringify(session.getSnapshot().draft);
    if (next !== latest) {
      generation++;
      latest = next;
    }
    if (!held()) acknowledged = generation;
    releaseIfSettled();
    changed();
  });
  const participant: SaveParticipant = {
    key,
    identity: session,
    prepare: () => {},
    snapshot: () => ({
      latestDraft: latest,
      generation,
      acknowledgedGeneration: acknowledged,
      inFlightGeneration: ['saving', 'publishing', 'unpublishing'].includes(
        session.getSnapshot().phase,
      )
        ? generation
        : null,
      failure: null,
      reconcileRequired: ['unknown', 'conflict'].includes(session.getSnapshot().phase),
    }),
    blocked: () =>
      held()
        ? ['unknown', 'conflict'].includes(session.getSnapshot().phase)
          ? 'reconcile'
          : 'choice'
        : null,
    flush: async () =>
      held()
        ? {
            kind: 'blocked',
            ownerId: key.ownerId,
            generation,
            reason: ['unknown', 'conflict'].includes(session.getSnapshot().phase)
              ? 'reconcile'
              : 'choice',
          }
        : { kind: 'clean', ownerId: key.ownerId, generation },
    retention: { held, release },
  };
  const owner: WorkflowDraftOwner = {
    session,
    participant,
    mount: () => {
      if (retired) return () => {};
      mounts++;
      mountedOnce = true;
      releaseSequence++;
      let live = true;
      return () => {
        if (!live) return;
        live = false;
        mounts--;
        releaseIfSettled();
      };
    },
  };
  owners.set(id, owner);
  ownerSources.set(owner, api);
  ownerIdentities.set(owner, {
    vault,
    vaultId: context.vaultId,
    storeUuid: context.storeUuid,
    workflowId: draft.workflowId,
  });
  changed();
  return owner;
}

/** Bounded projection of the existing original editor owners, never another store. */
export function retainedWorkflowDrafts(
  vault: string,
  context: WorkflowContext,
  api: WorkflowEditorApi = nativeEditorApi,
): { workflowId: string; dirty: boolean; phase: WorkflowEditorState['phase'] }[] {
  const result: { workflowId: string; dirty: boolean; phase: WorkflowEditorState['phase'] }[] = [];
  for (const owner of owners.values()) {
    const identity = ownerIdentities.get(owner);
    if (
      identity === undefined ||
      identity.vault !== vault ||
      identity.vaultId !== context.vaultId ||
      identity.storeUuid !== context.storeUuid ||
      ownerSources.get(owner) !== api
    )
      continue;
    const state = owner.session.getSnapshot();
    if (state.dirty || state.phase !== 'idle')
      result.push({ workflowId: identity.workflowId, dirty: state.dirty, phase: state.phase });
  }
  return result;
}
export function findRetainedWorkflowDraft(
  vault: string,
  context: WorkflowContext,
  id: string,
  api: WorkflowEditorApi = nativeEditorApi,
): WorkflowDraftOwner | null {
  const owner = owners.get(ownerKey(vault, context, id));
  return owner !== undefined && ownerSources.get(owner) === api ? owner : null;
}
export function subscribeWorkflowDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function workflowDraftRevision(): number {
  return revision;
}
