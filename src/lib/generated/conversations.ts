// Generated from Rust-owned JSON Schema. Do not edit.

// Regenerate with the commands in shared/workspace/README.md.

export type ArchiveContext = { storeUuid: string; vaultId: string };

export type ArchiveError = { code: ArchiveErrorCode; message: string };

export type ArchiveErrorCode = 'invalid' | 'conflict' | 'denied' | 'unavailable';

export type ArchiveMessage = {
  assistantMessageId: string;
  attemptId: string;
  completedAt: string | null;
  content: CompletedContent | null;
  contentState: ContentState;
  expiresAt: string | null;
  importedAt: string | null;
  origin: ContentOrigin;
  persistence: PersistenceState;
  runId: string | null;
  sessionId: string | null;
  userMessageId: string;
};

export type ArchiveSetting = {
  budgetBytes: SafeCounter;
  choice: RetentionChoice;
  context: ArchiveContext;
  logicalBytes: SafeCounter;
  revision: SafeCounter;
};

export type ArchiveThread = {
  branchMessageId: string | null;
  contentState: ContentState;
  createdAt: string;
  id: string;
  parentThreadId: string | null;
  sessionId: string | null;
  title: string | null;
  titleExpiresAt: string | null;
  updatedAt: string;
};

export type ArchiveTurnV1 = {
  availability: Availability;
  blocks: Array<Block>;
  lastUuid?: string | null;
  references: Array<Reference>;
  version: number;
};

export type AttemptBinding = {
  assistantMessageId: string;
  branchMessageId: string | null;
  displayMessage: DisplayMessage;
  parentThreadId: string | null;
  threadId: string;
  userMessageId: string;
};

export type Availability = 'complete' | 'partial' | 'unavailable';

export type Block =
  | { kind: 'text'; messageId: string; text: string }
  | { kind: 'tool'; name: string; state: string; toolId: string }
  | { kind: 'child'; summary: string; toolId: string };

export type CleanupState = 'completed' | 'deferred' | 'failed';

export type CompletedContent = {
  answer: ArchiveTurnV1;
  completionStatus: string;
  displayMessage: DisplayMessage;
  version: number;
};

export type ContentOrigin = 'native_run' | 'browser_cache';

export type ContentState = 'retained' | 'metadata_only' | 'expired';

export type DeleteResult =
  | { cleanup: CleanupState; state: 'deleted' }
  | { state: 'already_deleted' }
  | { owners: Array<string>; state: 'blocked_active' };

export type DisplayMessage = {
  addressedLabel: string | null;
  attachmentRefs: Array<string>;
  text: string;
};

export type ExportFormat = 'json' | 'markdown';

export type ExportResult =
  { state: 'cancelled' } | { partial: boolean; path: string; state: 'saved' };

export type ImportBatch = {
  attempts: Array<LegacyAttempt>;
  sourceVaultPath: string;
  threadId: string;
};

export type ImportItem =
  | { assistantMessageId: string; attemptId: string; state: 'retained'; userMessageId: string }
  | { assistantMessageId: string; reason: ImportSkip; state: 'skipped'; userMessageId: string };

export type ImportResult = {
  confirmed: Array<ImportedIdentity>;
  context: ArchiveContext;
  items: Array<ImportItem>;
};

export type ImportSkip =
  | 'off'
  | 'unknown_completion'
  | 'expired'
  | 'unavailable'
  | 'already_recorded'
  | 'conflict'
  | 'blocked_active';

export type ImportedIdentity = {
  assistantMessageId: string;
  attemptId: string;
  expiresAt: string | null;
  importedAt: string;
  threadId: string;
  userMessageId: string;
};

export type LegacyAttempt = {
  answer: ArchiveTurnV1;
  assistantMessageId: string;
  completedAt: SafeCounter | null;
  displayMessage: DisplayMessage;
  sessionId: string | null;
  userMessageId: string;
};

export type MessagePage = {
  context: ArchiveContext;
  items: Array<ArchiveMessage>;
  nextCursor: string | null;
  threadId: string;
};

export type PersistenceState = 'retained' | 'off' | 'expired' | 'unavailable' | 'deleted';

export type PruneResult = {
  cleanup: CleanupState;
  context: ArchiveContext;
  logicalBytesReleased: SafeCounter;
  removedMessages: SafeCounter;
  removedSearchRows: SafeCounter;
  safeReason: string | null;
};

export type Reference =
  | { kind: 'source'; toolId: string; url: string }
  | { invocationId: string; kind: 'effect' }
  | { kind: 'artifact'; path: string };

export type RetentionChoice = 'off' | 'days30' | 'days90' | 'forever';

export type SafeCounter = number;

export type ThreadPage = {
  context: ArchiveContext;
  items: Array<ArchiveThread>;
  nextCursor: string | null;
};
