import type {
  WorkflowContext,
  WorkflowDraft,
  WorkflowOperationDraft,
  WorkflowDraftSnapshot,
  WorkflowPublication,
  WorkflowDocument,
  WorkflowSaveRequest,
  WorkflowPublishRequest,
  WorkflowValidation,
  WorkflowErrorCode,
  WorkflowUnpublishRequest,
  WorkflowUnpublishAck,
} from '@/lib/generated/workflows';
export interface WorkflowEditorApi {
  unpublish?(request: WorkflowUnpublishRequest): Promise<WorkflowUnpublishAck>;
  save(request: WorkflowSaveRequest): Promise<WorkflowDraftSnapshot>;
  publish(request: WorkflowPublishRequest): Promise<WorkflowPublication>;
  document(context: WorkflowContext, id: string): Promise<WorkflowDocument>;
  validate(context: WorkflowContext, draft: WorkflowDraft): Promise<WorkflowValidation>;
}
export interface WorkflowEditorState {
  context: WorkflowContext;
  draft: WorkflowDraft;
  saved: WorkflowDraftSnapshot | null;
  publication: WorkflowPublication | null;
  publicationRevision: number;
  unpublishRequest: WorkflowUnpublishRequest | null;
  unpublishAck: WorkflowUnpublishAck | null;
  remote: WorkflowDocument | null;
  phase: 'idle' | 'saving' | 'publishing' | 'unpublishing' | 'refreshing' | 'unknown' | 'conflict';
  dirty: boolean;
  validation: WorkflowValidation | null;
  failure: string | null;
}
const copyContext = (value: WorkflowContext): WorkflowContext => ({
  vaultId: value.vaultId,
  storeUuid: value.storeUuid,
});
const sameContext = (a: WorkflowContext, b: WorkflowContext) =>
  a.vaultId === b.vaultId && a.storeUuid === b.storeUuid;
function copyOperation(value: WorkflowOperationDraft): WorkflowOperationDraft {
  switch (value.kind) {
    case 'read':
      return {
        kind: value.kind,
        queryJson: value.queryJson,
        outputSchemaJson: value.outputSchemaJson,
        nextStepId: value.nextStepId,
      };
    case 'transform':
      return {
        kind: value.kind,
        mappingJson: value.mappingJson,
        outputSchemaJson: value.outputSchemaJson,
        nextStepId: value.nextStepId,
      };
    case 'condition':
      return {
        kind: value.kind,
        predicateJson: value.predicateJson,
        ifTrue: value.ifTrue,
        ifFalse: value.ifFalse,
      };
    case 'action':
      return {
        kind: value.kind,
        actionId: value.actionId,
        definitionDigest: value.definitionDigest,
        connectionId: value.connectionId,
        accountId: value.accountId,
        inputJson: value.inputJson,
        nextStepId: value.nextStepId,
      };
    case 'timer':
      return { kind: value.kind, at: value.at, nextStepId: value.nextStepId };
    case 'external_input':
      return {
        kind: value.kind,
        schemaJson: value.schemaJson,
        expiresAt: value.expiresAt,
        nextStepId: value.nextStepId,
      };
    case 'result':
      return { kind: value.kind, outputJson: value.outputJson };
  }
}
export function copyWorkflowDraft(value: WorkflowDraft): WorkflowDraft {
  return {
    workflowId: value.workflowId,
    entryStepId: value.entryStepId,
    inputSchemaJson: value.inputSchemaJson,
    triggerJson: value.triggerJson,
    steps: value.steps.map((step) => ({
      stepId: step.stepId,
      label: step.label,
      operation: copyOperation(step.operation),
    })),
  };
}
// RawValue preserves JSON tokens and interior whitespace, but excludes the four
// JSON whitespace characters surrounding the value. Compare only that carrier
// normalization; never parse numbers or normalize a JSON token's spelling.
const jsonEdges = (value: string) => value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
function comparableDraft(value: WorkflowDraft): string {
  const copy = copyWorkflowDraft(value);
  copy.inputSchemaJson = jsonEdges(copy.inputSchemaJson);
  copy.triggerJson = jsonEdges(copy.triggerJson);
  for (const step of copy.steps) {
    const operation = step.operation;
    switch (operation.kind) {
      case 'read':
        operation.queryJson = jsonEdges(operation.queryJson);
        operation.outputSchemaJson = jsonEdges(operation.outputSchemaJson);
        break;
      case 'transform':
        operation.mappingJson = jsonEdges(operation.mappingJson);
        operation.outputSchemaJson = jsonEdges(operation.outputSchemaJson);
        break;
      case 'condition':
        operation.predicateJson = jsonEdges(operation.predicateJson);
        break;
      case 'action':
        operation.inputJson = jsonEdges(operation.inputJson);
        break;
      case 'external_input':
        operation.schemaJson = jsonEdges(operation.schemaJson);
        break;
      case 'result':
        operation.outputJson = jsonEdges(operation.outputJson);
        break;
      case 'timer':
        break;
    }
  }
  return JSON.stringify(copy);
}
const sameDraft = (a: WorkflowDraft, b: WorkflowDraft) => comparableDraft(a) === comparableDraft(b);
const copySaved = (value: WorkflowDraftSnapshot): WorkflowDraftSnapshot => ({
  etag: value.etag,
  draft: copyWorkflowDraft(value.draft),
});
const copyPublication = (value: WorkflowPublication): WorkflowPublication => ({
  version: { workflowId: value.version.workflowId, definitionHash: value.version.definitionHash },
  revision: value.revision,
});
const samePublication = (a: WorkflowPublication | null, b: WorkflowPublication) =>
  a !== null &&
  a.revision === b.revision &&
  a.version.workflowId === b.version.workflowId &&
  a.version.definitionHash === b.version.definitionHash;
const copyUnpublish = (value: WorkflowUnpublishRequest): WorkflowUnpublishRequest => ({
  context: copyContext(value.context),
  requestKey: value.requestKey,
  publication: copyPublication(value.publication),
});
const copyUnpublishAck = (value: WorkflowUnpublishAck): WorkflowUnpublishAck => ({
  context: copyContext(value.context),
  requestKey: value.requestKey,
  original: copyPublication(value.original),
  publicationRevision: value.publicationRevision,
  replayed: value.replayed,
});
function copyDocument(value: WorkflowDocument): WorkflowDocument {
  return {
    context: copyContext(value.context),
    workflowId: value.workflowId,
    publicationRevision: value.publicationRevision,
    draft: value.draft === null ? null : copySaved(value.draft),
    publication: value.publication === null ? null : copyPublication(value.publication),
    versions: value.versions.map((version) => ({
      workflowId: version.workflowId,
      definitionHash: version.definitionHash,
    })),
    versionsTruncated: value.versionsTruncated,
    activation:
      value.activation.state === 'enabled'
        ? {
            state: 'enabled',
            revision: value.activation.revision,
            version: {
              workflowId: value.activation.version.workflowId,
              definitionHash: value.activation.version.definitionHash,
            },
          }
        : value.activation.state === 'disabled'
          ? { state: 'disabled', revision: value.activation.revision }
          : { state: 'unavailable' },
  };
}
const busy = (state: WorkflowEditorState) =>
  ['saving', 'publishing', 'unpublishing', 'refreshing'].includes(state.phase);
const hex = (value: string) => /^[0-9a-f]{64}$/.test(value);
function errorCode(value: unknown): WorkflowErrorCode {
  const code = typeof value === 'object' && value !== null && 'code' in value ? value.code : null;
  switch (code) {
    case 'invalid_input':
    case 'invalid_definition':
    case 'unsupported_format':
    case 'limit_exceeded':
    case 'conflict':
    case 'stale':
    case 'denied':
      return code;
    default:
      return 'unavailable';
  }
}
export interface WorkflowEditorOptions {
  publicationRevision?: number;
  newRequestKey?: () => string;
}
/** One original editor owner, retained by its Library session; no browser archive. */
export function createWorkflowEditorSession(
  api: WorkflowEditorApi,
  context: WorkflowContext,
  draft: WorkflowDraft,
  saved: WorkflowDraftSnapshot | null = null,
  publication: WorkflowPublication | null = null,
  options: WorkflowEditorOptions = {},
) {
  const original = copyContext(context);
  const id = draft.workflowId;
  let state: WorkflowEditorState = {
    context: original,
    draft: copyWorkflowDraft(draft),
    saved: saved === null ? null : copySaved(saved),
    publication: publication === null ? null : copyPublication(publication),
    publicationRevision: options.publicationRevision ?? publication?.revision ?? 0,
    unpublishRequest: null,
    unpublishAck: null,
    remote: null,
    phase: 'idle',
    dirty: saved === null || !sameDraft(draft, saved.draft),
    validation: null,
    failure: null,
  };
  let retired = false;
  let pendingUnpublish: WorkflowUnpublishRequest | null = null;
  let validationSequence = 0;
  const listeners = new Set<() => void>();
  const update = (next: Partial<WorkflowEditorState>) => {
    state = { ...state, ...next };
    state.dirty = state.saved === null || !sameDraft(state.draft, state.saved.draft);
    for (const listener of listeners) listener();
  };
  const refused = (value: unknown) => {
    const code = errorCode(value);
    const known = [
      'invalid_input',
      'invalid_definition',
      'unsupported_format',
      'limit_exceeded',
    ].includes(code);
    update({
      phase: code === 'conflict' || code === 'stale' ? 'conflict' : known ? 'idle' : 'unknown',
      failure: code,
    });
  };
  return {
    getSnapshot: () => state,
    unpublish: async (): Promise<void> => {
      if (retired || busy(state)) return;
      if (api.unpublish === undefined) {
        update({ failure: 'unavailable' });
        return;
      }
      if (pendingUnpublish === null) {
        if (state.phase !== 'idle' || state.publication === null) return;
        const publication = copyPublication(state.publication);
        if (
          publication.version.workflowId !== id ||
          !hex(publication.version.definitionHash) ||
          !Number.isSafeInteger(publication.revision) ||
          publication.revision <= 0 ||
          publication.revision >= Number.MAX_SAFE_INTEGER ||
          state.publicationRevision !== publication.revision
        ) {
          update({ failure: 'invalid_input' });
          return;
        }
        let requestKey: string;
        try {
          requestKey = options.newRequestKey?.() ?? crypto.randomUUID().replaceAll('-', '');
        } catch {
          update({ failure: 'unavailable' });
          return;
        }
        if (!/^[0-9a-f]{32}$/.test(requestKey)) {
          update({ failure: 'invalid_input' });
          return;
        }
        pendingUnpublish = { context: copyContext(original), requestKey, publication };
        update({
          unpublishRequest: copyUnpublish(pendingUnpublish),
          unpublishAck: null,
          phase: 'unpublishing',
          failure: null,
        });
      }
      const requested = copyUnpublish(pendingUnpublish);
      update({ phase: 'unpublishing', failure: null });
      try {
        const result = await api.unpublish(copyUnpublish(requested));
        if (
          !sameContext(result.context, original) ||
          result.requestKey !== requested.requestKey ||
          !samePublication(result.original, requested.publication) ||
          !Number.isSafeInteger(result.publicationRevision) ||
          result.publicationRevision !== requested.publication.revision + 1 ||
          typeof result.replayed !== 'boolean'
        )
          throw new Error('unmatched acknowledgement');
        // A historical acknowledgement settles only this original request. A newer
        // explicitly observed publication must survive unchanged.
        const clearsTarget =
          samePublication(state.publication, requested.publication) &&
          state.publicationRevision === requested.publication.revision;
        const revision =
          clearsTarget ||
          (state.publication === null && state.publicationRevision <= result.publicationRevision)
            ? result.publicationRevision
            : state.publicationRevision;
        pendingUnpublish = null;
        update({
          publication: clearsTarget ? null : state.publication,
          publicationRevision: revision,
          unpublishRequest: null,
          unpublishAck: copyUnpublishAck(result),
          phase: 'idle',
          failure: null,
        });
      } catch (error) {
        const code = errorCode(error);
        update({
          phase: code === 'conflict' || code === 'stale' ? 'conflict' : 'unknown',
          failure: code,
        });
      }
    },
    retire: (): boolean => {
      if (retired) return true;
      // Automatic owner release separately requires a clean draft. Explicit
      // registry disposal may close an idle local draft, but never unresolved work.
      if (pendingUnpublish !== null || state.phase !== 'idle') return false;
      retired = true;
      validationSequence++;
      listeners.clear();
      return true;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    edit: (value: WorkflowDraft) => {
      if (retired || value.workflowId !== id) return;
      validationSequence++;
      update({ draft: copyWorkflowDraft(value), validation: null });
    },
    save: async (): Promise<void> => {
      if (retired || state.phase !== 'idle' || !state.dirty) return;
      const requested = copyWorkflowDraft(state.draft);
      const etag = state.saved?.etag ?? null;
      update({ phase: 'saving', failure: null, remote: null });
      try {
        const result = await api.save({
          context: copyContext(original),
          draft: copyWorkflowDraft(requested),
          expectedEtag: etag,
        });
        if (!hex(result.etag) || !sameDraft(result.draft, requested))
          throw new Error('unmatched acknowledgement');
        update({ saved: copySaved(result), phase: 'idle' });
      } catch (error) {
        refused(error);
      }
    },
    publish: async (): Promise<void> => {
      if (retired || state.phase !== 'idle' || state.dirty || state.saved === null) return;
      if (
        !Number.isSafeInteger(state.publicationRevision) ||
        state.publicationRevision < 0 ||
        state.publicationRevision >= Number.MAX_SAFE_INTEGER
      ) {
        update({ failure: 'invalid_input' });
        return;
      }
      const etag = state.saved.etag;
      const revision = state.publicationRevision === 0 ? null : state.publicationRevision;
      update({ phase: 'publishing', failure: null, remote: null });
      try {
        const result = await api.publish({
          context: copyContext(original),
          workflowId: id,
          expectedDraftEtag: etag,
          expectedPublicationRevision: revision,
        });
        if (
          result.version.workflowId !== id ||
          !hex(result.version.definitionHash) ||
          !Number.isSafeInteger(result.revision) ||
          result.revision !== (revision ?? 0) + 1
        )
          throw new Error('unmatched acknowledgement');
        update({
          publication: copyPublication(result),
          publicationRevision: result.revision,
          phase: 'idle',
        });
      } catch (error) {
        refused(error);
      }
    },
    refresh: async (current: WorkflowContext): Promise<void> => {
      if (retired || busy(state) || !sameContext(current, original)) return;
      const previous = state.phase;
      update({ phase: 'refreshing', failure: null });
      try {
        const result = await api.document(copyContext(original), id);
        if (
          !sameContext(result.context, original) ||
          result.workflowId !== id ||
          (result.draft !== null && result.draft.draft.workflowId !== id)
        )
          throw new Error('unmatched document');
        update({
          remote: copyDocument(result),
          phase: previous === 'unknown' ? 'unknown' : 'conflict',
        });
      } catch {
        update({ phase: previous, failure: 'unavailable' });
      }
    },
    acceptRemoteRevision: () => {
      if (retired || busy(state) || state.remote === null) return;
      const remote = state.remote;
      update({
        saved: remote.draft === null ? null : copySaved(remote.draft),
        publication: remote.publication === null ? null : copyPublication(remote.publication),
        publicationRevision: remote.publicationRevision,
        remote: null,
        phase: pendingUnpublish === null ? 'idle' : 'unknown',
        failure: null,
      });
    },
    validate: async (): Promise<void> => {
      if (retired) return;
      const requested = copyWorkflowDraft(state.draft);
      const sequence = ++validationSequence;
      try {
        const result = await api.validate(copyContext(original), copyWorkflowDraft(requested));
        if (sequence !== validationSequence || !sameDraft(requested, state.draft)) return;
        update({
          validation: {
            valid: result.valid,
            diagnostics: result.diagnostics.map((item) => ({
              code: errorCode(item),
              stepId: item.stepId,
              field: item.field,
            })),
          },
          failure: null,
        });
      } catch {
        if (sequence === validationSequence) update({ failure: 'unavailable' });
      }
    },
  };
}
