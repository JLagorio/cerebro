import type {
  WorkflowContext,
  WorkflowPermissions,
  WorkflowScheduleAck,
  WorkflowScheduleChangeRequest,
  WorkflowScheduleEnableRequest,
  WorkflowScheduleMonitorAck,
  WorkflowSchedulePreview,
  WorkflowScheduleView,
  WorkflowVersionRef,
} from '@/lib/generated/workflows';
export interface WorkflowScheduleApi {
  read: (context: WorkflowContext, workflowId: string) => Promise<WorkflowScheduleView>;
  enable: (request: WorkflowScheduleEnableRequest) => Promise<WorkflowScheduleAck>;
  pause: (request: WorkflowScheduleChangeRequest) => Promise<WorkflowScheduleAck>;
  remove: (request: WorkflowScheduleChangeRequest) => Promise<WorkflowScheduleAck>;
  wake: (context: WorkflowContext) => Promise<WorkflowScheduleMonitorAck>;
  preview: (context: WorkflowContext, workflowId: string) => Promise<WorkflowSchedulePreview>;
}
export interface ScheduleEnableInput {
  version: WorkflowVersionRef;
  expectedRevision: number;
  inputJson: string;
  permissions: WorkflowPermissions;
}
export interface WorkflowScheduleState {
  phase: 'idle' | 'loading' | 'mutating' | 'unknown';
  busy: boolean;
  uncertain: boolean;
  view: WorkflowScheduleView | null;
  ack: WorkflowScheduleAck | null;
  preview: WorkflowSchedulePreview | null;
  failure: string | null;
}

const contextCopy = (value: WorkflowContext): WorkflowContext => ({
  vaultId: value.vaultId,
  storeUuid: value.storeUuid,
});
const versionCopy = (value: WorkflowVersionRef): WorkflowVersionRef => ({
  workflowId: value.workflowId,
  definitionHash: value.definitionHash,
});
const sameContext = (a: WorkflowContext, b: WorkflowContext) =>
  a.vaultId === b.vaultId && a.storeUuid === b.storeUuid;
const sameVersion = (a: WorkflowVersionRef, b: WorkflowVersionRef) =>
  a.workflowId === b.workflowId && a.definitionHash === b.definitionHash;
const permissionsCopy = (value: WorkflowPermissions): WorkflowPermissions => ({
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
const count = (value: number) => Number.isSafeInteger(value) && value >= 0;
const hex = (value: string, size: number) =>
  typeof value === 'string' && value.length === size && /^[a-f0-9]+$/.test(value);
type Configuration = NonNullable<WorkflowScheduleView['configuration']>;
function configurationCopy(value: Configuration, workflow: string): Configuration {
  if (
    value.version.workflowId !== workflow ||
    !hex(value.version.definitionHash, 64) ||
    !hex(value.activationId, 32) ||
    !hex(value.epoch, 32) ||
    !count(value.revision) ||
    value.revision === 0 ||
    !['enabled', 'paused', 'removed'].includes(value.state)
  )
    throw new Error('identity');
  for (const digest of [
    value.configurationDigest,
    value.inputDigest,
    value.permissionDigest,
    value.triggerDigest,
  ])
    if (!hex(digest, 64)) throw new Error('digest');
  for (const number of [value.anchorMs, value.cursorMs, value.skippedCount, value.coalescedCount])
    if (!count(number)) throw new Error('counter');
  for (const number of [value.observedAtMs, value.firstSkippedMs, value.lastSkippedMs])
    if (number !== null && !count(number)) throw new Error('counter');
  if (
    typeof value.recoveryHeld !== 'boolean' ||
    typeof value.coverageKnown !== 'boolean' ||
    (value.inputJson !== null && typeof value.inputJson !== 'string')
  )
    throw new Error('configuration');
  return {
    activationId: value.activationId,
    version: versionCopy(value.version),
    state: value.state,
    revision: value.revision,
    epoch: value.epoch,
    configurationDigest: value.configurationDigest,
    inputDigest: value.inputDigest,
    permissionDigest: value.permissionDigest,
    triggerDigest: value.triggerDigest,
    anchorMs: value.anchorMs,
    cursorMs: value.cursorMs,
    recoveryHeld: value.recoveryHeld,
    coverageKnown: value.coverageKnown,
    skippedCount: value.skippedCount,
    coalescedCount: value.coalescedCount,
    observedAtMs: value.observedAtMs,
    firstSkippedMs: value.firstSkippedMs,
    lastSkippedMs: value.lastSkippedMs,
    inputJson: value.inputJson,
    permissions: value.permissions === null ? null : permissionsCopy(value.permissions),
  };
}
type Pending =
  | { operation: 'enable'; request: WorkflowScheduleEnableRequest }
  | {
      operation: 'pause' | 'remove';
      request: WorkflowScheduleChangeRequest;
      version: WorkflowVersionRef;
      epoch: string;
    };
function pendingCopy(value: Pending): Pending {
  if (value.operation === 'enable')
    return {
      operation: 'enable',
      request: {
        context: contextCopy(value.request.context),
        version: versionCopy(value.request.version),
        requestKey: value.request.requestKey,
        expectedRevision: value.request.expectedRevision,
        inputJson: value.request.inputJson,
        permissions: permissionsCopy(value.request.permissions),
      },
    };
  return {
    operation: value.operation,
    version: versionCopy(value.version),
    epoch: value.epoch,
    request: {
      context: contextCopy(value.request.context),
      workflowId: value.request.workflowId,
      requestKey: value.request.requestKey,
      expectedRevision: value.request.expectedRevision,
    },
  };
}
/** Original UI request ownership only; every native configuration/permission remains authoritative. */
export function createWorkflowScheduleSession(
  service: WorkflowScheduleApi,
  selected: WorkflowContext,
  workflowId: string,
  newKey: () => string,
) {
  const context = contextCopy(selected);
  const api: WorkflowScheduleApi = {
    read: service.read,
    enable: service.enable,
    pause: service.pause,
    remove: service.remove,
    wake: service.wake,
    preview: service.preview,
  };
  let state: WorkflowScheduleState = {
    phase: 'idle',
    busy: false,
    uncertain: false,
    view: null,
    ack: null,
    preview: null,
    failure: null,
  };
  let pending: Pending | null = null;
  let sequence = 0;
  let previewSequence = 0;
  let retired = false;
  const listeners = new Set<() => void>();
  const publish = (next: Partial<WorkflowScheduleState>) => {
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener();
  };
  const matches = (value: { context: WorkflowContext; workflowId: string }) =>
    sameContext(value.context, context) && value.workflowId === workflowId;
  const viewCopy = (value: WorkflowScheduleView): WorkflowScheduleView => {
    if (
      !matches(value) ||
      !['watching', 'stopped', 'unavailable'].includes(value.monitoring) ||
      ![
        'unconfigured',
        'ready',
        'paused',
        'removed',
        'recovery_held',
        'needs_access',
        'unavailable',
      ].includes(value.readiness)
    )
      throw new Error('scope');
    return {
      context: contextCopy(value.context),
      workflowId: value.workflowId,
      configuration:
        value.configuration === null ? null : configurationCopy(value.configuration, workflowId),
      readiness: value.readiness,
      monitoring: value.monitoring,
    };
  };
  const ackCopy = (value: WorkflowScheduleAck, original: Pending): WorkflowScheduleAck => {
    const expectedVersion =
      original.operation === 'enable' ? original.request.version : original.version;
    const expectedState =
      original.operation === 'enable'
        ? 'enabled'
        : original.operation === 'pause'
          ? 'paused'
          : 'removed';
    if (
      !matches(value) ||
      value.receipt.operation !== original.operation ||
      value.receipt.state !== expectedState ||
      value.receipt.revision !== original.request.expectedRevision + 1 ||
      !count(value.receipt.revision) ||
      !hex(value.receipt.epoch, 32) ||
      !sameVersion(value.receipt.version, expectedVersion) ||
      (original.operation !== 'enable' && value.receipt.epoch !== original.epoch) ||
      typeof value.replayed !== 'boolean' ||
      (value.monitoring !== null &&
        !['queued', 'observed', 'busy', 'unavailable'].includes(value.monitoring))
    )
      throw new Error('receipt');
    const current = configurationCopy(value.current, workflowId);
    if (
      current.revision < value.receipt.revision ||
      (!value.replayed &&
        (current.revision !== value.receipt.revision ||
          current.epoch !== value.receipt.epoch ||
          current.state !== value.receipt.state ||
          !sameVersion(current.version, value.receipt.version)))
    )
      throw new Error('current');
    return {
      context: contextCopy(value.context),
      workflowId: value.workflowId,
      current,
      receipt: {
        operation: value.receipt.operation,
        revision: value.receipt.revision,
        epoch: value.receipt.epoch,
        state: value.receipt.state,
        version: versionCopy(value.receipt.version),
      },
      replayed: value.replayed,
      monitoring: value.monitoring,
    };
  };
  const send = async (): Promise<void> => {
    if (retired || pending === null || state.busy) return;
    const original = pending;
    sequence++;
    previewSequence++;
    publish({ phase: 'mutating', busy: true, preview: null, failure: null });
    try {
      const dispatch = pendingCopy(original);
      const value =
        dispatch.operation === 'enable'
          ? await api.enable(dispatch.request)
          : dispatch.operation === 'pause'
            ? await api.pause(dispatch.request)
            : await api.remove(dispatch.request);
      const ack = ackCopy(value, original);
      pending = null;
      const monitoring =
        ack.monitoring === 'queued' || ack.monitoring === 'observed'
          ? 'watching'
          : ack.monitoring === 'unavailable'
            ? 'unavailable'
            : ack.monitoring === 'busy'
              ? 'stopped'
              : (state.view?.monitoring ?? 'stopped');
      const readiness = ack.current.recoveryHeld
        ? 'recovery_held'
        : ack.current.state === 'paused'
          ? 'paused'
          : ack.current.state === 'removed'
            ? 'removed'
            : 'unavailable';
      publish({
        phase: 'idle',
        busy: false,
        uncertain: false,
        ack,
        view: {
          context: contextCopy(context),
          workflowId,
          configuration: configurationCopy(ack.current, workflowId),
          monitoring,
          readiness,
        },
        failure: null,
      });
    } catch (error) {
      const code =
        error !== null && typeof error === 'object' && 'code' in error ? error.code : null;
      // Only a definite refusal of this first attempt permits a new request.
      // A later refusal cannot erase a preceding ambiguous committed attempt.
      if (
        !state.uncertain &&
        [
          'invalid_input',
          'invalid_definition',
          'unsupported_format',
          'limit_exceeded',
          'conflict',
          'stale',
          'denied',
        ].includes(String(code))
      ) {
        pending = null;
        publish({
          phase: 'idle',
          busy: false,
          uncertain: false,
          failure:
            code === 'invalid_input'
              ? 'The automatic run input was rejected. Edit it and try again.'
              : 'The configuration request was refused. Refresh the original selection before trying again.',
        });
      } else
        publish({
          phase: 'unknown',
          busy: false,
          uncertain: true,
          failure:
            'Could not confirm this configuration request. Check the original request before making another change.',
        });
    }
  };
  const ready = () => !retired && !state.busy && !state.uncertain && state.view !== null;
  const revision = () => state.view?.configuration?.revision ?? 0;
  const stale = () =>
    publish({
      failure:
        'The displayed configuration changed. Refresh and review it before changing automatic runs.',
    });
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      if (retired) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retire: (): boolean => {
      if (retired) return true;
      if (state.busy || state.uncertain || pending !== null) return false;
      retired = true;
      sequence++;
      previewSequence++;
      listeners.clear();
      state = {
        phase: 'idle',
        busy: false,
        uncertain: false,
        view: null,
        ack: null,
        preview: null,
        failure: null,
      };
      return true;
    },
    refresh: async (): Promise<void> => {
      if (retired || state.busy) return;
      const current = ++sequence;
      previewSequence++;
      publish({ phase: 'loading', busy: true, preview: null, failure: null });
      try {
        const next = viewCopy(await api.read(contextCopy(context), workflowId));
        if (current !== sequence) return;
        const old = state.view?.configuration;
        if (
          old !== null &&
          old !== undefined &&
          (next.configuration === null ||
            next.configuration.activationId !== old.activationId ||
            next.configuration.revision < old.revision)
        )
          throw new Error('stale');
        publish({
          view: next,
          phase: state.uncertain ? 'unknown' : 'idle',
          busy: false,
          failure: null,
        });
      } catch {
        if (current === sequence)
          publish({
            phase: state.uncertain ? 'unknown' : 'idle',
            busy: false,
            failure: 'Automatic run configuration could not be read.',
          });
      }
    },
    enable: async (input: ScheduleEnableInput): Promise<void> => {
      if (!ready()) return;
      if (input.version.workflowId !== workflowId || input.expectedRevision !== revision()) {
        stale();
        return;
      }
      try {
        pending = pendingCopy({
          operation: 'enable',
          request: {
            context: contextCopy(context),
            version: input.version,
            expectedRevision: input.expectedRevision,
            inputJson: input.inputJson,
            permissions: input.permissions,
            requestKey: newKey(),
          },
        });
      } catch {
        publish({
          failure: 'Could not prepare the configuration request. Your input is retained.',
        });
        return;
      }
      await send();
    },
    change: async (operation: 'pause' | 'remove', expectedRevision: number): Promise<void> => {
      if (!ready()) return;
      const current = state.view!.configuration;
      if (current === null || expectedRevision !== current.revision) {
        stale();
        return;
      }
      try {
        pending = {
          operation,
          request: {
            context: contextCopy(context),
            workflowId,
            expectedRevision,
            requestKey: newKey(),
          },
          version: versionCopy(current.version),
          epoch: current.epoch,
        };
      } catch {
        publish({ failure: 'Could not prepare the configuration request.' });
        return;
      }
      await send();
    },
    retry: async (current: WorkflowContext): Promise<void> => {
      if (retired || state.busy || !state.uncertain || pending === null) return;
      if (!sameContext(current, context)) {
        publish({ failure: 'Return to the original vault and store to check this request.' });
        return;
      }
      await send();
    },
    wake: async (): Promise<void> => {
      if (!ready() || state.view!.configuration?.state !== 'enabled') return;
      sequence++;
      previewSequence++;
      publish({ busy: true, preview: null, failure: null });
      try {
        const value = await api.wake(contextCopy(context));
        if (
          !sameContext(value.context, context) ||
          !['queued', 'observed', 'busy', 'unavailable'].includes(value.monitoring)
        )
          throw new Error('scope');
        const monitoring =
          value.monitoring === 'queued' || value.monitoring === 'observed'
            ? 'watching'
            : value.monitoring === 'busy'
              ? 'stopped'
              : 'unavailable';
        publish({
          busy: false,
          view: { ...state.view!, monitoring },
          failure:
            monitoring === 'watching'
              ? null
              : 'Monitoring could not be started. The saved configuration is unchanged.',
        });
      } catch {
        publish({
          busy: false,
          view: { ...state.view!, monitoring: 'unavailable' },
          failure:
            'Monitoring could not be confirmed. Refresh its state or resume monitoring explicitly.',
        });
      }
    },
    preview: async (): Promise<void> => {
      if (!ready() || state.view!.configuration === null) return;
      const original = state.view!.configuration;
      const current = ++previewSequence;
      try {
        const value = await api.preview(contextCopy(context), workflowId);
        if (
          current !== previewSequence ||
          state.view?.configuration?.revision !== original.revision ||
          state.view.configuration.epoch !== original.epoch
        )
          return;
        if (
          !matches(value) ||
          value.revision !== original.revision ||
          value.epoch !== original.epoch ||
          !count(value.cursorMs) ||
          !count(value.skippedCount) ||
          !count(value.coalescedCount) ||
          (value.dueAtMs !== null && !count(value.dueAtMs)) ||
          typeof value.coverageKnown !== 'boolean' ||
          !['idle', 'due', 'paused', 'not_ready', 'recovery_held', 'clock_backwards'].includes(
            value.disposition,
          )
        )
          throw new Error('scope');
        publish({
          preview: {
            context: contextCopy(value.context),
            workflowId: value.workflowId,
            revision: value.revision,
            epoch: value.epoch,
            disposition: value.disposition,
            coverageKnown: value.coverageKnown,
            dueAtMs: value.dueAtMs,
            cursorMs: value.cursorMs,
            skippedCount: value.skippedCount,
            coalescedCount: value.coalescedCount,
          },
          failure: null,
        });
      } catch {
        if (current === previewSequence)
          publish({
            preview: null,
            failure: 'The next native observation could not be previewed.',
          });
      }
    },
  };
}
