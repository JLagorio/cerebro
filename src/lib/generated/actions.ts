// Generated from Rust-owned JSON Schema. Do not edit.

// Regenerate with the commands in shared/workspace/README.md.

export type AccountBinding = {
  accountId: string;
  accountRevision: number;
  issuer: string;
  scopeDigest: string;
  subject: string;
};

export type AcquisitionState = 'pending' | 'installed' | 'cancelled' | 'failed';

export type ActionAttemptSummary = {
  attemptId: string;
  dispatchedAt: string | null;
  observedAt: string | null;
  ordinal: SafeCounter;
  outcomeSummary: string | null;
  receiptId: string | null;
  remoteEffectReference: string | null;
  state: InvocationState;
};

export type ActionCatalogPage = {
  descriptors: Array<ActionDescriptor>;
  nextCursor: string | null;
  snapshotDigest: string;
};

export type ActionDefinition = {
  actionId: string;
  adapterRevision: string;
  cancel: boolean;
  definitionDigest: string;
  effectClass: EffectClass;
  inputSchema: string;
  inputSchemaDigest: string;
  outputSchema: string;
  outputSchemaDigest: string;
  reconcile: boolean;
  requiredCapabilities: Array<string>;
  retry: RetryContract;
};

export type ActionDefinitionView = {
  actionId: string;
  adapterRevision: string;
  cancel: boolean;
  definitionDigest: string;
  effectClass: EffectClass;
  inputSchema: string;
  inputSchemaDigest: string;
  outputSchema: string;
  outputSchemaDigest: string;
  reconcile: boolean;
  requiredCapabilities: Array<string>;
  retry: RetryContract;
};

export type ActionDescriptor = {
  actionId: string;
  definitionDigest: string;
  status: CatalogStatus;
};

export type ActionEffectDetails = {
  account: EffectAccount | null;
  approval: EffectApproval | null;
  attempts: Array<ActionAttemptSummary>;
  definitionDigest: string;
  effect: ActionEffectRef;
  inputDigest: string;
  preview: SafeEffectPreview;
  revision: SafeCounter;
  target: EffectTarget | null;
};

export type ActionEffectRef = {
  accountLabel: string | null;
  approvalId: string | null;
  canReconcile: boolean;
  canRetry: boolean;
  invocationId: string;
  state: InvocationState;
};

export type ActionError = {
  code: ActionErrorCode;
  message: string;
  retryDisposition: RetryDisposition;
};

export type ActionErrorCode =
  | 'invalid_input'
  | 'unsupported_schema'
  | 'limit_exceeded'
  | 'definition_mismatch'
  | 'not_found'
  | 'request_key_conflict'
  | 'revision_conflict'
  | 'denied'
  | 'unavailable';

export type ActionReadError = {
  code: ActionReadErrorCode;
  message: string;
  retryDisposition: RetryDisposition;
};

export type ActionReadErrorCode = 'not_found' | 'denied' | 'unavailable';

export type ActionSubjectView = {
  actorId: string;
  childJobId: string | null;
  clientId: string | null;
  runId: string;
  vaultId: string;
};

export type BrokerInventory = {
  inspectedRunIds: Array<string>;
  observedCount: SafeCounter;
  overflow: boolean;
  reasons: Array<HistoryReason>;
  state: InventoryState;
};

export type CatalogStatus =
  | { status: 'callable' }
  | { reason: string; status: 'unsupported' }
  | { reason: string; status: 'unavailable' };

export type ChatRecoveryInspection = {
  brokerInventory: BrokerInventory;
  effects: Array<HistoryEffect>;
  externalEffectsCoverage: ExternalEffectsCoverage;
  generationCoverage: GenerationCoverage;
  issues: Array<HistoryIssue>;
  origin: HistoryOrigin;
};

export type ConnectionError =
  | 'sign_in_required'
  | 'invalid_selection'
  | 'stale_revision'
  | 'not_found'
  | 'unavailable'
  | 'unsupported'
  | 'identity_mismatch'
  | 'cancelled'
  | 'source_changed'
  | 'unsafe_path'
  | 'invalid_config';

export type ConnectionHealth =
  'sign_in_required' | 'ready' | 'unavailable' | 'unsupported' | 'disabled';

export type ConnectionStatus = {
  account: AccountBinding | null;
  cleanupPending: boolean;
  connectionId: string;
  health: ConnectionHealth;
  login: string;
  observedAt: string;
  remoteRevocation: RemoteRevocation;
  revision: number;
  revocationGeneration: number;
  secretRevision: number;
};

export type CredentialAcquisitionView = {
  attemptId: string;
  connectionId: string;
  error: ConnectionError | null;
  expectedRevision: number;
  host: string;
  login: string;
  observedAt: string;
  revocationGeneration: number;
  state: AcquisitionState;
};

export type DetailsRead = 'available' | 'denied' | 'unavailable';

export type EffectAccount = { accountId: string; accountRevision: SafeCounter; label: string };

export type EffectApproval = {
  approvalId: string;
  approvedInputDigest: string | null;
  approvedPreview: SafeEffectPreview | null;
  askedInputDigest: string;
  expiresAt: string;
  revision: SafeCounter;
};

export type EffectClass =
  | 'read'
  | 'local_write'
  | 'external_draft'
  | 'external_mutation'
  | 'external_send'
  | 'external_publish'
  | 'external_delete';

export type EffectTarget = { kind: string; label: string; safeReference: string };

export type ExternalEffectsCoverage = {
  reason: ExternalEffectsReason;
  state: UnknownCoverageState;
};

export type ExternalEffectsReason = 'unbrokered_execution_not_covered';

export type GenerationCoverage = { reason: GenerationReason; state: UnknownCoverageState };

export type GenerationReason = 'root_only_no_generation_binding';

export type GrantInputSelection =
  { kind: 'all_valid_inputs' } | { input: string; kind: 'exact_canonical_input' };

export type GrantInputView =
  { kind: 'all_valid_inputs' } | { inputDigest: string; kind: 'exact_canonical_input' };

export type HistoryEffect = {
  details: ActionEffectDetails | null;
  detailsRead: DetailsRead;
  effect: ActionEffectRef;
  reason: HistoryReason | null;
};

export type HistoryIssue = { reason: HistoryReason };

export type HistoryOrigin = {
  actorId: string;
  appClosePrecision: string;
  cliSessionId: string;
  endedAt: string | null;
  historicalAppSessionId: string;
  nativeCloseKind: string | null;
  nativeClosedAt: string | null;
  outcome: string;
  rootAttemptId: string;
  runId: string;
  startedAt: string;
  storeId: string;
  vaultId: string;
};

export type HistoryReason =
  | 'invalid_record'
  | 'stored_payload_limit'
  | 'aggregate_limit'
  | 'output_limit'
  | 'overflow'
  | 'metadata_limit'
  | 'account_denied'
  | 'account_unavailable';

export type InventoryState = 'complete' | 'incomplete';

export type InvocationState =
  | 'prepared'
  | 'awaiting_approval'
  | 'ready'
  | 'dispatched'
  | 'succeeded'
  | 'failed'
  | 'outcome_unknown'
  | 'cancelled';

export type ManagedConnectionPage = { items: Array<ConnectionStatus>; nextCursor: string | null };

export type PrepareAction = {
  accountId: string;
  actionId: string;
  connectionId: string;
  definitionDigest: string;
  input: string;
  requestKey: string;
  snapshotDigest: string;
};

export type PreparedAction = {
  approvalId: string | null;
  effect: ActionEffectRef;
  preview: SafeEffectPreview;
};

export type PreviewField = { label: string; value: string };

export type RemoteRevocation = 'not_attempted';

export type RetryContract = 'never' | 'idempotent' | 'reconcile_first';

export type RetryDisposition = 'never' | 'refresh' | 'reconcile';

export type RunActionAccessView = {
  accessRequestId: string | null;
  accessRevision: string;
  accounts: Array<RunActionAccountChoice>;
  definitions: Array<ActionDefinition>;
  grants: Array<RunActionGrantView>;
  runId: string;
};

export type RunActionAccountChoice = {
  accountId: string;
  accountRevision: SafeCounter;
  connectionId: string;
  label: string;
  revocationGeneration: SafeCounter;
};

export type RunActionGrantSelection =
  | { expectedRevision: SafeCounter; grantId: string; kind: 'preserve' }
  | { kind: 'new'; selection: RunActionSelection };

export type RunActionGrantView = {
  accountId: string;
  actionId: string;
  available: boolean;
  connectionId: string;
  definitionDigest: string;
  grantId: string;
  inputScope: GrantInputView;
  revision: SafeCounter;
};

export type RunActionSelection = {
  accountId: string;
  accountRevision: SafeCounter;
  actionId: string;
  connectionId: string;
  definitionDigest: string;
  inputScope: GrantInputSelection;
  revocationGeneration: SafeCounter;
};

export type SafeCounter = number;

export type SafeEffectPreview = {
  fields: Array<PreviewField>;
  redactedFields: Array<string>;
  summary: string;
};

export type SetRunActionAccess = {
  completeRequestId: string | null;
  expectedAccessRevision: string;
  selections: Array<RunActionGrantSelection>;
};

export type SetRunActionAccessResult =
  | { requestClosed: boolean; sourceCurrent: boolean; state: 'changed'; view: RunActionAccessView }
  | { message: string; state: 'commit_unknown' }
  | { error: ActionError; state: 'refused' };

export type UnknownCoverageState = 'unknown';
