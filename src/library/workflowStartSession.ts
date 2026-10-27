import type { WorkflowContext, WorkflowStartAck, WorkflowStartRequest } from '@/lib/generated/workflows';
export type WorkflowStartInput = Omit<WorkflowStartRequest, 'startKey'>;
export interface WorkflowStartState {
  phase: 'idle' | 'starting' | 'unknown' | 'known';
  busy: boolean;
  ack: WorkflowStartAck | null;
  original: Pick<WorkflowStartRequest, 'context' | 'version'> | null;
  failure: string | null;
}
export interface WorkflowStartApi { start: (request: WorkflowStartRequest) => Promise<WorkflowStartAck>; }
const copyContext = (context: WorkflowContext): WorkflowContext => ({ vaultId: context.vaultId, storeUuid: context.storeUuid });
function copyRequest(input: WorkflowStartRequest): WorkflowStartRequest {
  return {
    context: copyContext(input.context),
    version: { workflowId: input.version.workflowId, definitionHash: input.version.definitionHash },
    startKey: input.startKey,
    inputJson: input.inputJson,
    permissions: {
      readPrefixes: [...input.permissions.readPrefixes],
      queryRecords: input.permissions.queryRecords,
      accounts: input.permissions.accounts.map((account) => ({
        connection: account.connection, account: account.account, action: account.action,
        definition: account.definition, capabilities: [...account.capabilities],
        inputScope: account.inputScope, inputDigest: account.inputDigest,
      })),
    },
  };
}
const sameContext = (left: WorkflowContext, right: WorkflowContext): boolean => left.vaultId === right.vaultId && left.storeUuid === right.storeUuid;
const count = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
function matches(value: WorkflowStartAck, request: WorkflowStartRequest): boolean {
  return value !== null && typeof value === 'object' && value.context !== null && typeof value.context === 'object' && value.version !== null && typeof value.version === 'object' &&
    sameContext(value.context, request.context) && value.version.workflowId === request.version.workflowId && value.version.definitionHash === request.version.definitionHash &&
    typeof value.runId === 'string' && /^[a-f0-9]{32}$/.test(value.runId) && count(value.revision) && count(value.admissionEpoch) &&
    typeof value.created === 'boolean' && ['ready', 'busy', 'unavailable'].includes(value.admission);
}
function copyAck(value: WorkflowStartAck): WorkflowStartAck {
  return { context: copyContext(value.context), version: { workflowId: value.version.workflowId, definitionHash: value.version.definitionHash }, runId: value.runId, revision: value.revision, admissionEpoch: value.admissionEpoch, created: value.created, admission: value.admission };
}
/** App-session pending start identity only; never browser storage or a completed-input archive. */
export function createWorkflowStartSession(api: WorkflowStartApi, newKey: () => string) {
  let state: WorkflowStartState = { phase: 'idle', busy: false, ack: null, original: null, failure: null };
  let pending: WorkflowStartRequest | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: Partial<WorkflowStartState>) => { state = { ...state, ...next }; for (const listener of listeners) listener(); };
  const send = async (): Promise<void> => {
    if (pending === null || state.busy) return;
    const original = pending;
    publish({ phase: 'starting', busy: true, failure: null });
    try {
      // Transport receives a copy; it cannot mutate the retained retry identity.
      const observed = await api.start(copyRequest(original));
      if (!matches(observed, original)) throw new Error('mismatched workflow acknowledgement');
      pending = null;
      publish({ phase: 'known', busy: false, ack: copyAck(observed), failure: null });
    } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'invalid_input') {
        pending = null;
        publish({ phase: 'idle', busy: false, original: null, ack: null, failure: 'The run input was rejected. Edit the input and try again.' });
        return;
      }
      publish({ phase: 'unknown', busy: false, ack: null, failure: 'Could not confirm this start. Check the original request before starting another run.' });
    }
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    begin: async (input: WorkflowStartInput): Promise<void> => {
      if (state.busy || state.phase !== 'idle') return;
      try {
        pending = copyRequest({ context: input.context, version: input.version, permissions: input.permissions, inputJson: input.inputJson, startKey: newKey() });
        publish({ original: { context: copyContext(pending.context), version: { workflowId: pending.version.workflowId, definitionHash: pending.version.definitionHash } }, ack: null, failure: null });
      } catch {
        pending = null;
        publish({ failure: 'Could not prepare this start. Your input is retained.' });
        return;
      }
      await send();
    },
    retry: async (current: WorkflowContext): Promise<void> => {
      if (state.busy || state.phase !== 'unknown' || pending === null) return;
      if (!sameContext(current, pending.context)) { publish({ failure: 'Return to the original vault and store to check this start.' }); return; }
      await send();
    },
    clearKnown: (): void => {
      if (state.phase !== 'known' || state.busy) return;
      pending = null;
      publish({ phase: 'idle', original: null, ack: null, failure: null });
    },
  };
}
