import raw from '../../../shared/policy/recovery.v1.json?raw';
import type PolicyShape from '../../../shared/policy/recovery.v1.json';
import type { RecoveryLimits } from '@/engine/recovery';

export const RECOVERY_RAW = raw;
const policy: typeof PolicyShape = JSON.parse(RECOVERY_RAW);
export const recoveryLimits: RecoveryLimits = {
  schemaVersion: policy.schema_version,
  retentionSeconds: policy.retention_seconds,
  globalBytes: policy.global_bytes,
  entryBytes: policy.entry_bytes,
  maxEntries: policy.max_entries,
  maxVaults: policy.max_vaults,
  maxPathBytes: policy.max_path_bytes,
  maxBypasses: policy.max_bypasses,
  bypassSeconds: policy.bypass_seconds,
};
