import { sha256Hex } from '@/lib/sha256';
import { acceptSelectedEditorVersion, useVaultStore } from '@/stores/vaultStore';
import type { DocumentOwner, SaveOutcome } from './documentOwner';
import { selectedTitleText } from './selectedTitleDraft';
/** Called only after DocumentOwner verifies an acknowledgement, never from IPC. */
export function acceptSelectedTitleOutcome(owner: DocumentOwner, outcome: SaveOutcome): void {
  if (outcome.kind !== 'acknowledged' || !owner.selectedTarget) return;
  const write = outcome.write;
  if (write.kind !== 'selected_applied' && write.kind !== 'selected_unchanged') return;
  if (write.kind === 'selected_applied' && write.reconcileRequired) return;
  const version = write.kind === 'selected_applied' ? write.currentVersion : write.version;
  const body = owner.snapshot().mergeBase?.raw;
  if (body === undefined || sha256Hex(body) !== version.bodyHash ||
    !acceptSelectedEditorVersion(owner.key.vaultId, owner.key.path, owner.selectedTarget, version)) return;
  const state = useVaultStore.getState();
  const entry = state.entries.find(item => item.path === owner.key.path);
  if (!entry || state.vaultPath !== owner.key.vaultId || state.entriesVault !== owner.key.vaultId ||
    entry.authority?.workspaceId !== owner.selectedTarget.workspaceId ||
    entry.authority?.recordId !== owner.selectedTarget.recordId ||
    entry.authority.bodyHash !== version.bodyHash) return;
  useVaultStore.setState({ entries: state.entries.map(item => item === entry ?
    { ...item, title: selectedTitleText(body, item.title).trim() } : item) });
}
