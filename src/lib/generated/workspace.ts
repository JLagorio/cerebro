// Generated from Rust-owned JSON Schema. Do not edit.

// Regenerate with the commands in shared/workspace/README.md.

export type AuthorityError = {
  code: StoreErrorCode;
  kind: AuthorityErrorKind;
  message: string;
  retryable: boolean;
};

export type AuthorityErrorKind =
  | 'selected_authority_unavailable'
  | 'context_unavailable'
  | 'binding_unavailable'
  | 'invalid_binding'
  | 'missing_marker'
  | 'invalid_format'
  | 'unsupported_format'
  | 'inactive_workspace'
  | 'unbound_workspace'
  | 'wrong_identity'
  | 'metadata_unavailable'
  | 'invalid_metadata'
  | 'unsupported_projection'
  | 'source_changed'
  | 'stale_metadata'
  | 'unsupported_operation'
  | 'source_limit'
  | 'busy'
  | 'recovery_required'
  | 'recovery_conflict'
  | 'artifact_pressure';

export type BackupErrorKind =
  | 'not_implemented'
  | 'unsupported_container'
  | 'unsupported_platform'
  | 'unsupported_dependency'
  | 'invalid_manifest'
  | 'invalid_path'
  | 'source_limit'
  | 'required_part_missing'
  | 'part_mismatch'
  | 'invalid_metadata'
  | 'invalid_ledger'
  | 'source_changed'
  | 'recovery_required'
  | 'destination_unavailable'
  | 'busy';

export type CommandReadError = string | AuthorityError;

export type EditorBodyCoherence = 'paired' | 'external_change';

export type EditorOperation = {
  operationId: string;
  path: string;
  receipt: EditorReceiptView;
  requestKey: string;
  target: SelectedEditorTarget;
  version: SelectedRecordVersion;
};

export type EditorReceiptView = {
  actor: string;
  approvedBy?: string | null;
  at: string;
  bodyAfterHash: string;
  bodyBeforeHash: string;
  epoch: string;
  metadataAfterHash: string;
  metadataBeforeHash: string;
  operation: string;
  previousRevision: string;
  recordId: string;
  revision: string;
  runId?: string | null;
  workspaceId: string;
};

export type EditorRecoveryView =
  | { kind: 'off' }
  | { kind: 'not_retained'; reason: string }
  | { evicted?: string | null; id: string; kind: 'retained' }
  | { evicted?: string | null; id: string; kind: 'pending' }
  | { kind: 'without_copy' };

export type EditorSavePhase = 'start' | 'resolve';

export type EditorSaveRefusal = { error: AuthorityError; kind: 'selected_refused' };

export type EditorSaveRequest = {
  expectedVersion?: SelectedRecordVersion | null;
  original?: EditorOperation | null;
  phase: EditorSavePhase;
  requestKey: string;
  target: SelectedEditorTarget;
};

export type EditorSaveResult =
  | {
      currentVersion: SelectedRecordVersion;
      kind: 'selected_applied';
      operation: EditorOperation;
      reconcileRequired: boolean;
      recovery?: EditorRecoveryView | null;
    }
  | { kind: 'selected_unchanged'; version: SelectedRecordVersion }
  | { error: AuthorityError; kind: 'selected_pending'; operation: EditorOperation }
  | { error: AuthorityError; kind: 'selected_outcome_unknown' };

export type LegacyRecordLocator = { path: string };

export type LegacyRecordSnapshot = { content: string; hash: string };

export type MetadataPatchOperation = {
  operationId: string;
  path: string;
  receipt: EditorReceiptView;
  requestKey: string;
  target: SelectedEditorTarget;
  version: SelectedRecordVersion;
};

export type MetadataPatchPhase = 'start' | 'resolve';

export type MetadataPatchRefusal = { error: AuthorityError; kind: 'metadata_refused' };

export type MetadataPatchRequest = {
  changes: Array<PropertyChange>;
  expectedVersion: SelectedRecordVersion;
  original?: MetadataPatchOperation | null;
  phase: MetadataPatchPhase;
  requestKey: string;
  target: SelectedEditorTarget;
};

export type MetadataPatchResult =
  | {
      currentVersion: SelectedRecordVersion;
      kind: 'applied';
      operation: MetadataPatchOperation;
      reconcileRequired: boolean;
    }
  | {
      currentVersion: SelectedRecordVersion;
      kind: 'unchanged';
      path: string;
      reconcileRequired: boolean;
      requestKey: string;
      target: SelectedEditorTarget;
      version: SelectedRecordVersion;
    }
  | { error: AuthorityError; kind: 'outcome_unknown'; requestKey: string };

export type PropertyChange =
  { key: string; op: 'set'; value: PropertyValue } | { key: string; op: 'remove' };

export type PropertyValue =
  | { kind: 'null' }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'decimal'; value: string }
  | { kind: 'array'; value: Array<PropertyValue> }
  | { kind: 'object'; value: Record<string, PropertyValue> }
  | { kind: 'date'; value: string }
  | { kind: 'instant'; value: string }
  | {
      fragment?: string | null;
      kind: 'relation';
      resolution: RelationResolution;
      spelling: string;
    };

export type RelationResolution =
  { status: 'unresolved' } | { status: 'ambiguous' } | { status: 'resolved'; targetId: string };

export type SelectedAuthorityKind = 'sqlite_metadata';

export type SelectedBodyObservation = { coherence: EditorBodyCoherence; observedBodyHash: string };

export type SelectedEditorSnapshot = {
  body: string;
  coherence: EditorBodyCoherence;
  editable: boolean;
  observedBodyHash: string;
  path: string;
  readOnlyReason?: string | null;
  target: SelectedEditorTarget;
  version: SelectedRecordVersion;
};

export type SelectedEditorTarget = { recordId: string; workspaceId: string };

export type SelectedEntryProperties = {
  unavailableLegacyKeys: Array<string>;
  value: PropertyValue;
};

export type SelectedMetadataAck =
  | { fullWidth: boolean; kind: 'applied'; version: SelectedRecordVersion }
  | { fullWidth: boolean; kind: 'unchanged'; version: SelectedRecordVersion };

export type SelectedMode = 'wide' | 'default';

export type SelectedPropertySnapshot = {
  coherence: EditorBodyCoherence;
  editable: boolean;
  field: string;
  observedBodyHash: string;
  path: string;
  readOnlyReason?: string | null;
  target: SelectedEditorTarget;
  value: SelectedPropertyValue;
  version: SelectedRecordVersion;
};

export type SelectedPropertyValue = { kind: 'absent' } | { kind: 'present'; value: PropertyValue };

export type SelectedRecordVersion = {
  bodyHash: string;
  kind: SelectedAuthorityKind;
  metadataHash: string;
  metadataRevision: string;
  recordId: string;
  workspaceId: string;
};

export type SelectedSavedViewColumn = { kind: string; name: string };

export type SelectedSavedViewFrame = {
  capped: boolean;
  columns: Array<SelectedSavedViewColumn>;
  configuration: PropertyValue;
  entries: Array<SelectedSavedViewRecord>;
  layout: SelectedSavedViewLayout;
  schemaEvidence: Array<SelectedSavedViewRecord>;
  shown: number;
  snapshotEpoch: string;
  timezone: string;
  today: string;
  total: number;
  typeRecord: SelectedSavedViewRecord;
  viewId: string;
  viewName: string;
};

export type SelectedSavedViewLayout = 'table' | 'list';

export type SelectedSavedViewRecord = {
  authority: SelectedRecordVersion;
  canonicalProperties: SelectedEntryProperties;
  createdAt: string;
  filename: string;
  folder: string;
  hash: string;
  modifiedAt: string;
  outgoingLinks: Array<string>;
  path: string;
  project?: string | null;
  snippet: string;
  title: string;
  type?: string | null;
};

export type SelectedSavedViewRequest = {
  expectedVersion: SelectedRecordVersion;
  target: SelectedEditorTarget;
  viewId: string;
};

export type StoreError = { code: StoreErrorCode; message: string; retryable: boolean };

export type StoreErrorCode = 'capability_unavailable';

export type ValueError = { code: ValueErrorCode; message: string; retryable: boolean };

export type ValueErrorCode = 'schema_invalid' | 'capability_unavailable';

export type ValueSchema = 'plain' | 'date' | 'instant';

export type WorkspaceBackupAvailability =
  | { checkRestore: boolean; kind: 'available'; sourceLabel: string }
  | { checkRestore: boolean; kind: 'unsupported_current_vault'; message: string }
  | { checkRestore: boolean; kind: 'unavailable'; refusal: WorkspaceBackupRefusal }
  | { kind: 'unsupported_platform' }
  | { kind: 'preview'; message: string };

export type WorkspaceBackupCancelResult =
  | { kind: 'cancelled' }
  | { kind: 'already_started'; operation: WorkspaceBackupOperation }
  | { kind: 'refused'; refusal: WorkspaceBackupRefusal }
  | { kind: 'preview'; message: string };

export type WorkspaceBackupChoiceResult =
  | { kind: 'cancelled' }
  | { kind: 'review'; review: WorkspaceBackupReview }
  | { kind: 'refused'; refusal: WorkspaceBackupRefusal }
  | { kind: 'preview'; message: string; mode: WorkspaceBackupMode };

export type WorkspaceBackupCommitResult =
  | {
      kind: 'started';
      labels: WorkspaceBackupLabels;
      mode: WorkspaceBackupMode;
      operationId: string;
    }
  | { kind: 'already_started'; operation: WorkspaceBackupOperation }
  | { kind: 'refused'; refusal: WorkspaceBackupRefusal }
  | { kind: 'preview'; message: string; mode: WorkspaceBackupMode };

export type WorkspaceBackupDisposition =
  | { kind: 'none_created' }
  | { kind: 'creation_uncertain'; location: WorkspaceBackupLocation }
  | { kind: 'incomplete'; location: WorkspaceBackupLocation }
  | { kind: 'completion_unknown'; location?: WorkspaceBackupLocation | null }
  | { kind: 'completed'; location: WorkspaceBackupLocation }
  | { kind: 'completed_but_response_unavailable'; location: WorkspaceBackupLocation };

export type WorkspaceBackupErrorView = { code: string; kind: BackupErrorKind; message: string };

export type WorkspaceBackupLabels = {
  input?: string | null;
  output?: string | null;
  source?: string | null;
};

export type WorkspaceBackupLocation = {
  displayLocation: string;
  verification: WorkspaceBackupLocationVerification;
};

export type WorkspaceBackupLocationVerification =
  'verified' | 'original_spelling_only' | 'unavailable';

export type WorkspaceBackupMode = 'create' | 'check' | 'restore';

export type WorkspaceBackupOperation =
  | { kind: 'none' }
  | {
      kind: 'choosing';
      labels: WorkspaceBackupLabels;
      mode: WorkspaceBackupMode;
      operationId: string;
    }
  | { kind: 'pending'; review: WorkspaceBackupReview }
  | {
      kind: 'running';
      labels: WorkspaceBackupLabels;
      mode: WorkspaceBackupMode;
      operationId: string;
    }
  | {
      kind: 'terminal';
      labels: WorkspaceBackupLabels;
      mode: WorkspaceBackupMode;
      operationId: string;
      result: WorkspaceBackupTerminal;
    }
  | { kind: 'unavailable'; refusal: WorkspaceBackupRefusal }
  | { kind: 'preview'; message: string };

export type WorkspaceBackupRefusal = {
  authority?: AuthorityError | null;
  backup?: WorkspaceBackupErrorView | null;
  kind: WorkspaceBackupRefusalKind;
  message: string;
  output: WorkspaceBackupDisposition;
};

export type WorkspaceBackupRefusalKind =
  | 'busy'
  | 'invalid_choice'
  | 'expired_choice'
  | 'wrong_window'
  | 'wrong_mode'
  | 'stale_opening'
  | 'output_overlap'
  | 'changed_choice'
  | 'destination_unavailable'
  | 'unsupported_current_vault'
  | 'unsupported_platform'
  | 'invalid_backup'
  | 'recovery_required'
  | 'unknown_outcome'
  | 'unavailable';

export type WorkspaceBackupReview = {
  expiresAt?: string | null;
  labels: WorkspaceBackupLabels;
  mode: WorkspaceBackupMode;
  operationId: string;
  summary?: WorkspaceBackupSummary | null;
  token: string;
};

export type WorkspaceBackupSummary = {
  omissions: Array<string>;
  partCount: number;
  portableVersion: number;
  schemaVersion: number;
  totalBytes: string;
  workspaceId: string;
};

export type WorkspaceBackupTerminal =
  | {
      kind: 'completed';
      output: WorkspaceBackupDisposition;
      summary?: WorkspaceBackupSummary | null;
      workspaceId?: string | null;
    }
  | { kind: 'refused'; refusal: WorkspaceBackupRefusal };
