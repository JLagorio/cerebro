// Generated from Rust-owned JSON Schema. Do not edit.

// Regenerate with the commands in shared/workspace/README.md.

export type SafeCounter = number;

export type WorkflowAccessView = {
  admissionEpoch: SafeCounter;
  context: WorkflowContext;
  current: WorkflowPermissions;
  original: WorkflowPermissions;
  runId: string;
};

export type WorkflowAccountPermission = {
  account: string;
  action: string;
  capabilities: Array<string>;
  connection: string;
  definition: string;
  inputDigest: string | null;
  inputScope: WorkflowInputScope;
};

export type WorkflowActionAnswer = {
  allow: boolean;
  approvalId: string;
  context: WorkflowContext;
  editedInputJson: string | null;
  expectedApprovalRevision: SafeCounter;
  expectedInvocationRevision: SafeCounter;
  invocationId: string;
  runId: string;
};

export type WorkflowActivationView =
  | { state: 'unavailable' }
  | { revision: SafeCounter; state: 'disabled' }
  | { revision: SafeCounter; state: 'enabled'; version: WorkflowVersionRef };

export type WorkflowAdmission = 'ready' | 'busy' | 'unavailable';

export type WorkflowCatalog = {
  context: WorkflowContext;
  items: Array<WorkflowListItem>;
  nextCursor: string | null;
  truncated: boolean;
};

export type WorkflowContext = { storeUuid: string; vaultId: string };

export type WorkflowDiagnostic = {
  code: WorkflowErrorCode;
  field: string | null;
  stepId: string | null;
};

export type WorkflowDocument = {
  activation: WorkflowActivationView;
  context: WorkflowContext;
  draft: WorkflowDraftSnapshot | null;
  publication: WorkflowPublication | null;
  publicationRevision: SafeCounter;
  versions: Array<WorkflowVersionRef>;
  versionsTruncated: boolean;
  workflowId: string;
};

export type WorkflowDraft = {
  entryStepId: string;
  inputSchemaJson: string;
  steps: Array<WorkflowStepDraft>;
  triggerJson: string;
  workflowId: string;
};

export type WorkflowDraftSnapshot = { draft: WorkflowDraft; etag: string };

export type WorkflowError = { code: WorkflowErrorCode; diagnostics: Array<WorkflowDiagnostic> };

export type WorkflowErrorCode =
  | 'invalid_input'
  | 'invalid_definition'
  | 'unsupported_format'
  | 'limit_exceeded'
  | 'conflict'
  | 'stale'
  | 'denied'
  | 'unavailable';

export type WorkflowInputScope = 'all_valid_inputs' | 'exact_canonical_input';

export type WorkflowListItem = {
  publication: WorkflowPublication | null;
  readable: boolean;
  workflowId: string;
};

export type WorkflowMonitorState = 'watching' | 'stopped' | 'unavailable';

export type WorkflowMonitoring = 'queued' | 'observed' | 'busy' | 'unavailable';

export type WorkflowOperationDraft =
  | { kind: 'read'; nextStepId: string; outputSchemaJson: string; queryJson: string }
  | { kind: 'transform'; mappingJson: string; nextStepId: string; outputSchemaJson: string }
  | { ifFalse: string; ifTrue: string; kind: 'condition'; predicateJson: string }
  | {
      accountId: string;
      actionId: string;
      connectionId: string;
      definitionDigest: string;
      inputJson: string;
      kind: 'action';
      nextStepId: string;
    }
  | { at: string; kind: 'timer'; nextStepId: string }
  | { expiresAt: string; kind: 'external_input'; nextStepId: string; schemaJson: string }
  | { kind: 'result'; outputJson: string };

export type WorkflowPermissions = {
  accounts: Array<WorkflowAccountPermission>;
  queryRecords: boolean;
  readPrefixes: Array<string>;
};

export type WorkflowPublication = { revision: SafeCounter; version: WorkflowVersionRef };

export type WorkflowPublishRequest = {
  context: WorkflowContext;
  expectedDraftEtag: string;
  expectedPublicationRevision: SafeCounter | null;
  workflowId: string;
};

export type WorkflowReauthorizeRequest = {
  context: WorkflowContext;
  expectedEpoch: SafeCounter;
  permissions: WorkflowPermissions;
  runId: string;
};

export type WorkflowRunCatalog = {
  context: WorkflowContext;
  items: Array<WorkflowRunListItem>;
  nextCursor: string | null;
  truncated: boolean;
};

export type WorkflowRunListItem = {
  admissionEpoch: SafeCounter;
  reason: string | null;
  revision: SafeCounter;
  runId: string;
  startedAt: string;
  state: WorkflowRunState;
  updatedAt: string;
  version: WorkflowVersionRef;
};

export type WorkflowRunRequest = {
  context: WorkflowContext;
  expectedEpoch: SafeCounter;
  expectedRevision: SafeCounter;
  runId: string;
};

export type WorkflowRunState =
  'queued' | 'running' | 'waiting' | 'blocked' | 'succeeded' | 'failed' | 'cancelled';

export type WorkflowRunView = {
  admissionEpoch: SafeCounter;
  cancelRequested: boolean;
  configurationDigest: string;
  context: WorkflowContext;
  inputDigest: string;
  nativeRunId: string;
  reason: string | null;
  revision: SafeCounter;
  runId: string;
  state: WorkflowRunState;
  steps: Array<WorkflowStepView>;
  version: WorkflowVersionRef;
};

export type WorkflowSaveRequest = {
  context: WorkflowContext;
  draft: WorkflowDraft;
  expectedEtag: string | null;
};

export type WorkflowScheduleAck = {
  context: WorkflowContext;
  current: WorkflowScheduleConfiguration;
  monitoring: WorkflowMonitoring | null;
  receipt: WorkflowScheduleReceipt;
  replayed: boolean;
  workflowId: string;
};

export type WorkflowScheduleChangeRequest = {
  context: WorkflowContext;
  expectedRevision: SafeCounter;
  requestKey: string;
  workflowId: string;
};

export type WorkflowScheduleConfiguration = {
  activationId: string;
  anchorMs: SafeCounter;
  coalescedCount: SafeCounter;
  configurationDigest: string;
  coverageKnown: boolean;
  cursorMs: SafeCounter;
  epoch: string;
  firstSkippedMs: SafeCounter | null;
  inputDigest: string;
  inputJson: string | null;
  lastSkippedMs: SafeCounter | null;
  observedAtMs: SafeCounter | null;
  permissionDigest: string;
  permissions: WorkflowPermissions | null;
  recoveryHeld: boolean;
  revision: SafeCounter;
  skippedCount: SafeCounter;
  state: WorkflowScheduleState;
  triggerDigest: string;
  version: WorkflowVersionRef;
};

export type WorkflowScheduleDisposition =
  'idle' | 'due' | 'paused' | 'not_ready' | 'recovery_held' | 'clock_backwards';

export type WorkflowScheduleEnableRequest = {
  context: WorkflowContext;
  expectedRevision: SafeCounter;
  inputJson: string;
  permissions: WorkflowPermissions;
  requestKey: string;
  version: WorkflowVersionRef;
};

export type WorkflowScheduleMonitorAck = {
  context: WorkflowContext;
  monitoring: WorkflowMonitoring;
};

export type WorkflowScheduleOperation = 'enable' | 'pause' | 'remove';

export type WorkflowSchedulePreview = {
  coalescedCount: SafeCounter;
  context: WorkflowContext;
  coverageKnown: boolean;
  cursorMs: SafeCounter;
  disposition: WorkflowScheduleDisposition;
  dueAtMs: SafeCounter | null;
  epoch: string;
  revision: SafeCounter;
  skippedCount: SafeCounter;
  workflowId: string;
};

export type WorkflowScheduleReadiness =
  | 'unconfigured'
  | 'ready'
  | 'paused'
  | 'removed'
  | 'recovery_held'
  | 'needs_access'
  | 'unavailable';

export type WorkflowScheduleReceipt = {
  epoch: string;
  operation: WorkflowScheduleOperation;
  revision: SafeCounter;
  state: WorkflowScheduleState;
  version: WorkflowVersionRef;
};

export type WorkflowScheduleState = 'enabled' | 'paused' | 'removed';

export type WorkflowScheduleView = {
  configuration: WorkflowScheduleConfiguration | null;
  context: WorkflowContext;
  monitoring: WorkflowMonitorState;
  readiness: WorkflowScheduleReadiness;
  workflowId: string;
};

export type WorkflowStartAck = {
  admission: WorkflowAdmission;
  admissionEpoch: SafeCounter;
  context: WorkflowContext;
  created: boolean;
  revision: SafeCounter;
  runId: string;
  version: WorkflowVersionRef;
};

export type WorkflowStartRequest = {
  context: WorkflowContext;
  inputJson: string;
  permissions: WorkflowPermissions;
  startKey: string;
  version: WorkflowVersionRef;
};

export type WorkflowStepDraft = {
  label: string;
  operation: WorkflowOperationDraft;
  stepId: string;
};

export type WorkflowStepKind =
  'read' | 'transform' | 'condition' | 'action' | 'timer' | 'external_input' | 'result';

export type WorkflowStepState =
  'pending' | 'running' | 'waiting' | 'blocked' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

export type WorkflowStepView = {
  input: WorkflowValueView;
  invocationId: string | null;
  kind: WorkflowStepKind;
  label: string;
  ordinal: SafeCounter;
  output: WorkflowValueView;
  reason: string | null;
  state: WorkflowStepState;
  stepId: string;
  wait: WorkflowWaitView | null;
};

export type WorkflowUnpublishAck = {
  context: WorkflowContext;
  original: WorkflowPublication;
  publicationRevision: SafeCounter;
  replayed: boolean;
  requestKey: string;
};

export type WorkflowUnpublishRequest = {
  context: WorkflowContext;
  publication: WorkflowPublication;
  requestKey: string;
};

export type WorkflowValidation = { diagnostics: Array<WorkflowDiagnostic>; valid: boolean };

export type WorkflowValueDetail = { digest: string; json: string };

export type WorkflowValueRequest = {
  context: WorkflowContext;
  digest: string;
  role: WorkflowValueRole;
  runId: string;
  stepId: string;
};

export type WorkflowValueRole = 'run_input' | 'step_input' | 'step_output';

export type WorkflowValueView =
  | { bytes: SafeCounter; digest: string; state: 'available' }
  | { state: 'not_recorded' }
  | { digest: string; state: 'not_retained' }
  | { state: 'unavailable' };

export type WorkflowVersionRef = { definitionHash: string; workflowId: string };

export type WorkflowWaitAnswer = {
  context: WorkflowContext;
  continuationId: string;
  expectedRevision: SafeCounter;
  inputJson: string;
  runId: string;
  signalKey: string;
};

export type WorkflowWaitKind = 'timer' | 'external_input' | 'person_approval';

export type WorkflowWaitState = 'pending' | 'consumed' | 'cancelled' | 'expired';

export type WorkflowWaitView = {
  continuationId: string;
  dueAt: string | null;
  expiresAt: string | null;
  kind: WorkflowWaitKind;
  revision: SafeCounter;
  schemaJson: string | null;
  state: WorkflowWaitState;
};
