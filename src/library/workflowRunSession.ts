import type { ActionEffectDetails } from '@/lib/generated/actions';
import type {
  WorkflowActionAnswer,
  WorkflowContext,
  WorkflowPermissions,
  WorkflowReauthorizeRequest,
  WorkflowRunRequest,
  WorkflowRunView,
  WorkflowStartAck,
  WorkflowValueDetail,
  WorkflowValueRequest,
  WorkflowWaitAnswer,
} from '@/lib/generated/workflows';
export interface WorkflowRunApi {
  run: (context: WorkflowContext, runId: string) => Promise<WorkflowRunView>;
  continue: (request: WorkflowRunRequest) => Promise<WorkflowStartAck>;
  cancel: (request: WorkflowRunRequest) => Promise<WorkflowRunView>;
  reauthorize: (request: WorkflowReauthorizeRequest) => Promise<WorkflowStartAck>;
  action: (
    context: WorkflowContext,
    runId: string,
    invocationId: string,
  ) => Promise<ActionEffectDetails>;
  answerAction: (request: WorkflowActionAnswer) => Promise<WorkflowRunView>;
  answerWait: (request: WorkflowWaitAnswer) => Promise<WorkflowRunView>;
  value: (request: WorkflowValueRequest) => Promise<WorkflowValueDetail>;
}
export interface WorkflowRunState {
  runId: string | null;
  run: WorkflowRunView | null;
  phase: 'idle' | 'loading' | 'mutating' | 'unknown' | 'unavailable';
  action: ActionEffectDetails | null;
  value: WorkflowValueDetail | null;
  waitPending: boolean;
  uncertain: boolean;
  failure:
    | 'read_unavailable'
    | 'command_unknown'
    | 'original_context_required'
    | 'invalid_input'
    | 'access_review_stale'
    | null;
}
const copyContext = (value: WorkflowContext): WorkflowContext => ({
  vaultId: value.vaultId,
  storeUuid: value.storeUuid,
});
const sameContext = (a: WorkflowContext, b: WorkflowContext) =>
  a.vaultId === b.vaultId && a.storeUuid === b.storeUuid;
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const copyPermissions = (value: WorkflowPermissions): WorkflowPermissions => ({
  queryRecords: value.queryRecords,
  readPrefixes: [...value.readPrefixes],
  accounts: value.accounts.map((item) => ({
    connection: item.connection,
    account: item.account,
    action: item.action,
    definition: item.definition,
    capabilities: [...item.capabilities],
    inputScope: item.inputScope,
    inputDigest: item.inputDigest,
  })),
});
function copyValue(
  value: WorkflowRunView['steps'][number]['input'],
): WorkflowRunView['steps'][number]['input'] {
  switch (value.state) {
    case 'available':
      return { state: value.state, digest: value.digest, bytes: value.bytes };
    case 'not_retained':
      return { state: value.state, digest: value.digest };
    case 'not_recorded':
    case 'unavailable':
      return { state: value.state };
  }
}
function copyRun(value: WorkflowRunView): WorkflowRunView {
  return {
    context: copyContext(value.context),
    version: { workflowId: value.version.workflowId, definitionHash: value.version.definitionHash },
    runId: value.runId,
    nativeRunId: value.nativeRunId,
    admissionEpoch: value.admissionEpoch,
    revision: value.revision,
    state: value.state,
    cancelRequested: value.cancelRequested,
    configurationDigest: value.configurationDigest,
    inputDigest: value.inputDigest,
    reason: value.reason,
    steps: value.steps.map((step) => ({
      stepId: step.stepId,
      label: step.label,
      kind: step.kind,
      state: step.state,
      ordinal: step.ordinal,
      invocationId: step.invocationId,
      reason: step.reason,
      input: copyValue(step.input),
      output: copyValue(step.output),
      wait:
        step.wait === null
          ? null
          : {
              continuationId: step.wait.continuationId,
              kind: step.wait.kind,
              state: step.wait.state,
              revision: step.wait.revision,
              schemaJson: step.wait.schemaJson,
              dueAt: step.wait.dueAt,
              expiresAt: step.wait.expiresAt,
            },
    })),
  };
}
const copyPreview = (value: ActionEffectDetails['preview']): ActionEffectDetails['preview'] => ({
  summary: value.summary,
  fields: value.fields.map((field) => ({ label: field.label, value: field.value })),
  redactedFields: [...value.redactedFields],
});
function copyAction(value: ActionEffectDetails): ActionEffectDetails {
  return {
    revision: value.revision,
    definitionDigest: value.definitionDigest,
    inputDigest: value.inputDigest,
    effect: {
      invocationId: value.effect.invocationId,
      state: value.effect.state,
      approvalId: value.effect.approvalId,
      accountLabel: value.effect.accountLabel,
      canRetry: value.effect.canRetry,
      canReconcile: value.effect.canReconcile,
    },
    preview: copyPreview(value.preview),
    target:
      value.target === null
        ? null
        : {
            kind: value.target.kind,
            label: value.target.label,
            safeReference: value.target.safeReference,
          },
    account:
      value.account === null
        ? null
        : {
            accountId: value.account.accountId,
            accountRevision: value.account.accountRevision,
            label: value.account.label,
          },
    approval:
      value.approval === null
        ? null
        : {
            approvalId: value.approval.approvalId,
            revision: value.approval.revision,
            expiresAt: value.approval.expiresAt,
            askedInputDigest: value.approval.askedInputDigest,
            approvedInputDigest: value.approval.approvedInputDigest,
            approvedPreview:
              value.approval.approvedPreview === null
                ? null
                : copyPreview(value.approval.approvedPreview),
          },
    attempts: value.attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      ordinal: attempt.ordinal,
      state: attempt.state,
      dispatchedAt: attempt.dispatchedAt,
      observedAt: attempt.observedAt,
      receiptId: attempt.receiptId,
      remoteEffectReference: attempt.remoteEffectReference,
      outcomeSummary: attempt.outcomeSummary,
    })),
  };
}
/** Original request controller only; native rows remain the execution authority. */
export function createWorkflowRunSession(
  service: WorkflowRunApi,
  selected: WorkflowContext,
  newKey: () => string,
) {
  const context = copyContext(selected);
  const api: WorkflowRunApi = {
    run: service.run,
    continue: service.continue,
    cancel: service.cancel,
    reauthorize: service.reauthorize,
    action: service.action,
    answerAction: service.answerAction,
    answerWait: service.answerWait,
    value: service.value,
  };
  let state: WorkflowRunState = {
    runId: null,
    run: null,
    phase: 'idle',
    action: null,
    value: null,
    waitPending: false,
    uncertain: false,
    failure: null,
  };
  let sequence = 0;
  let actionSequence = 0;
  let valueSequence = 0;
  let signal: WorkflowWaitAnswer | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: Partial<WorkflowRunState>) => {
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener();
  };
  const validRun = (value: WorkflowRunView, id: string, prior: WorkflowRunView | null) =>
    value !== null &&
    typeof value === 'object' &&
    sameContext(value.context, context) &&
    value.runId === id &&
    positive(value.revision) &&
    positive(value.admissionEpoch) &&
    (prior === null ||
      (value.version.workflowId === prior.version.workflowId &&
        value.version.definitionHash === prior.version.definitionHash &&
        value.nativeRunId === prior.nativeRunId &&
        value.revision >= prior.revision));
  const read = async (id: string, replace: boolean): Promise<void> => {
    if (
      state.phase === 'mutating' ||
      (replace && (signal !== null || (state.uncertain && state.runId !== id)))
    )
      return;
    const request = ++sequence;
    actionSequence++;
    valueSequence++;
    const prior = state.runId === id ? state.run : null;
    publish({ runId: id, run: prior, phase: 'loading', action: null, value: null, failure: null });
    try {
      const value = await api.run(copyContext(context), id);
      if (request !== sequence) return;
      if (!validRun(value, id, prior)) throw new Error('scope');
      publish({ run: copyRun(value), phase: 'idle', uncertain: false, failure: null });
    } catch {
      if (request === sequence) publish({ phase: 'unavailable', failure: 'read_unavailable' });
    }
  };
  const refresh = async (): Promise<void> => {
    if (state.runId !== null) await read(state.runId, false);
  };
  const actionable = () =>
    state.phase === 'idle' && !state.uncertain && state.run !== null && signal === null;
  const request = (run: WorkflowRunView): WorkflowRunRequest => ({
    context: copyContext(context),
    runId: run.runId,
    expectedEpoch: run.admissionEpoch,
    expectedRevision: run.revision,
  });
  const accept = (value: WorkflowRunView, original: WorkflowRunView) => {
    if (!validRun(value, original.runId, original)) throw new Error('scope');
    publish({ run: copyRun(value), phase: 'idle', action: null, value: null, failure: null });
  };
  const mutateRun = async (
    work: (original: WorkflowRunView) => Promise<WorkflowRunView>,
  ): Promise<void> => {
    if (!actionable()) return;
    const original = state.run!;
    sequence++;
    actionSequence++;
    valueSequence++;
    publish({ phase: 'mutating', value: null, failure: null });
    try {
      accept(await work(original), original);
    } catch {
      publish({ phase: 'unknown', uncertain: true, failure: 'command_unknown' });
    }
  };
  const mutateAdmission = async (
    work: (original: WorkflowRunView) => Promise<WorkflowStartAck>,
  ): Promise<void> => {
    if (!actionable()) return;
    const original = state.run!;
    sequence++;
    actionSequence++;
    valueSequence++;
    publish({ phase: 'mutating', value: null, failure: null });
    try {
      const ack = await work(original);
      if (
        !sameContext(ack.context, context) ||
        ack.runId !== original.runId ||
        ack.version.workflowId !== original.version.workflowId ||
        ack.version.definitionHash !== original.version.definitionHash ||
        !positive(ack.revision) ||
        ack.revision < original.revision ||
        !positive(ack.admissionEpoch) ||
        !['ready', 'busy', 'unavailable'].includes(ack.admission)
      )
        throw new Error('scope');
      publish({ phase: 'idle', action: null, failure: null });
      await refresh();
    } catch {
      publish({ phase: 'unknown', uncertain: true, failure: 'command_unknown' });
    }
  };
  const sendSignal = async (): Promise<void> => {
    if (signal === null || state.phase === 'mutating' || state.run === null) return;
    const pending = signal;
    const original = state.run;
    sequence++;
    actionSequence++;
    valueSequence++;
    publish({ phase: 'mutating', waitPending: true, failure: null, value: null });
    try {
      const value = await api.answerWait({
        context: copyContext(pending.context),
        runId: pending.runId,
        continuationId: pending.continuationId,
        expectedRevision: pending.expectedRevision,
        signalKey: pending.signalKey,
        inputJson: pending.inputJson,
      });
      if (!validRun(value, pending.runId, original)) throw new Error('scope');
      signal = null;
      publish({
        run: copyRun(value),
        phase: 'idle',
        waitPending: false,
        uncertain: false,
        failure: null,
        action: null,
      });
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'invalid_input'
      ) {
        signal = null;
        publish({ phase: 'idle', waitPending: false, uncertain: false, failure: 'invalid_input' });
      } else publish({ phase: 'unknown', uncertain: true, failure: 'command_unknown' });
    }
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open: async (id: string): Promise<void> => {
      if (state.uncertain && state.runId !== id) return;
      await read(id, true);
    },
    refresh,
    continueRun: async (): Promise<void> => {
      await mutateAdmission((original) => api.continue(request(original)));
    },
    cancel: async (): Promise<void> => {
      await mutateRun((original) => api.cancel(request(original)));
    },
    reauthorize: async (
      permissions: WorkflowPermissions,
      reviewed: { runId: string; admissionEpoch: number },
    ): Promise<boolean> => {
      if (!actionable()) return false;
      if (
        reviewed.runId !== state.run!.runId ||
        !positive(reviewed.admissionEpoch) ||
        reviewed.admissionEpoch !== state.run!.admissionEpoch
      ) {
        publish({ failure: 'access_review_stale' });
        return false;
      }
      const runId = reviewed.runId;
      const expectedEpoch = reviewed.admissionEpoch;
      const copied = copyPermissions(permissions);
      await mutateAdmission(() =>
        api.reauthorize({
          context: copyContext(context),
          runId,
          expectedEpoch,
          permissions: copied,
        }),
      );
      return state.phase === 'idle' && state.failure === null;
    },
    inspectAction: async (invocationId: string): Promise<void> => {
      if (
        state.run === null ||
        state.phase === 'mutating' ||
        !state.run.steps.some((step) => step.invocationId === invocationId)
      )
        return;
      const id = state.run.runId;
      const reading = ++actionSequence;
      publish({ action: null, failure: null });
      try {
        const value = await api.action(copyContext(context), id, invocationId);
        if (reading !== actionSequence || state.runId !== id) return;
        if (
          value.effect.invocationId !== invocationId ||
          !positive(value.revision) ||
          (value.approval !== null &&
            (!positive(value.approval.revision) ||
              value.effect.approvalId !== value.approval.approvalId))
        )
          throw new Error('scope');
        publish({ action: copyAction(value) });
      } catch {
        if (reading === actionSequence) publish({ failure: 'read_unavailable' });
      }
    },
    answerAction: async (allow: boolean, editedInputJson: string | null): Promise<void> => {
      const detail = state.action;
      if (
        detail === null ||
        detail.approval === null ||
        detail.effect.state !== 'awaiting_approval'
      )
        return;
      const approval = detail.approval;
      await mutateRun((original) =>
        api.answerAction({
          context: copyContext(context),
          runId: original.runId,
          invocationId: detail.effect.invocationId,
          approvalId: approval.approvalId,
          expectedInvocationRevision: detail.revision,
          expectedApprovalRevision: approval.revision,
          allow,
          editedInputJson,
        }),
      );
    },
    answerWait: async (stepId: string, inputJson: string): Promise<void> => {
      if (!actionable()) return;
      const original = state.run!;
      const wait = original.steps.find((step) => step.stepId === stepId)?.wait;
      if (wait?.kind !== 'external_input' || wait.state !== 'pending') return;
      try {
        signal = {
          context: copyContext(context),
          runId: original.runId,
          continuationId: wait.continuationId,
          expectedRevision: wait.revision,
          signalKey: newKey(),
          inputJson,
        };
      } catch {
        publish({ failure: 'read_unavailable' });
        return;
      }
      await sendSignal();
    },
    retryWait: async (current: WorkflowContext): Promise<void> => {
      if (signal === null) return;
      if (!sameContext(current, context)) {
        publish({ failure: 'original_context_required' });
        return;
      }
      await sendSignal();
    },
    readValue: async (
      selectedValue: Omit<WorkflowValueRequest, 'context' | 'runId'>,
    ): Promise<void> => {
      const original = state.run;
      if (original === null || state.phase === 'mutating') return;
      const step = original.steps.find((item) => item.stepId === selectedValue.stepId);
      const meta = selectedValue.role === 'step_input' ? step?.input : step?.output;
      if (
        selectedValue.role === 'run_input'
          ? selectedValue.digest !== original.inputDigest
          : meta?.state !== 'available' || meta.digest !== selectedValue.digest
      )
        return;
      const reading = ++valueSequence;
      publish({ value: null, failure: null });
      const wanted = {
        context: copyContext(context),
        runId: original.runId,
        role: selectedValue.role,
        stepId: selectedValue.stepId,
        digest: selectedValue.digest,
      };
      try {
        const value = await api.value(wanted);
        if (reading !== valueSequence || state.runId !== original.runId) return;
        if (value.digest !== wanted.digest || typeof value.json !== 'string')
          throw new Error('scope');
        publish({ value: { digest: value.digest, json: value.json } });
      } catch {
        if (reading === valueSequence) publish({ failure: 'read_unavailable' });
      }
    },
    clearPayload: (): void => {
      actionSequence++;
      valueSequence++;
      publish({ action: null, value: null });
    },
  };
}
