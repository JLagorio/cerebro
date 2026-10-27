/** Transport only: limits come from the native journal/shared artifact. */
export type RecoveryOutcome =
  | { kind: 'off' }
  | { kind: 'not_retained'; reason: string }
  | { kind: 'retained' | 'pending'; id: string; evicted: number }
  | { kind: 'without_copy' };
export interface RecoveryVersion {
  id: string;
  path: string;
  beforeHash: string;
  afterHash: string;
  capturedAt: number;
  bytes: number;
  state: 'pending' | 'committed' | 'ambiguous';
  attribution: string;
}
export interface RecoveryLimits {
  schemaVersion: number;
  retentionSeconds: number;
  globalBytes: number;
  entryBytes: number;
  maxEntries: number;
  maxVaults: number;
  maxPathBytes: number;
  maxBypasses: number;
  bypassSeconds: number;
}
export interface RecoveryStatus {
  enabled: boolean;
  retainedBytes: number;
  entries: number;
  pending: number;
  ambiguous: number;
  limits: RecoveryLimits;
}
export interface RecoveryFailure {
  reason: string;
  expiresAt: number;
}
