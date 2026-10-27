import type { SelectedEditorSnapshot, SelectedEditorTarget } from '@/lib/generated/workspace';
import { sha256Hex } from '@/lib/sha256';
/** Observation equality only; none of these values confers native authority. */
export function sameSelectedObservation(
  left: SelectedEditorSnapshot,
  right: SelectedEditorSnapshot,
): boolean {
  return (
    left.path === right.path &&
    left.target.workspaceId === right.target.workspaceId &&
    left.target.recordId === right.target.recordId &&
    left.body === right.body &&
    left.observedBodyHash === right.observedBodyHash &&
    left.editable === right.editable &&
    left.coherence === right.coherence &&
    left.version.kind === right.version.kind &&
    left.version.workspaceId === right.version.workspaceId &&
    left.version.recordId === right.version.recordId &&
    left.version.metadataRevision === right.version.metadataRevision &&
    left.version.metadataHash === right.version.metadataHash &&
    left.version.bodyHash === right.version.bodyHash
  );
}
export function selectedSnapshotFor(
  snapshot: SelectedEditorSnapshot,
  path: string,
  target: SelectedEditorTarget,
): boolean {
  return (
    snapshot.path === path &&
    snapshot.target.workspaceId === target.workspaceId &&
    snapshot.target.recordId === target.recordId &&
    snapshot.version.kind === 'sqlite_metadata' &&
    snapshot.version.workspaceId === target.workspaceId &&
    snapshot.version.recordId === target.recordId &&
    snapshot.observedBodyHash === sha256Hex(snapshot.body) &&
    (snapshot.coherence !== 'paired' || snapshot.version.bodyHash === snapshot.observedBodyHash)
  );
}
