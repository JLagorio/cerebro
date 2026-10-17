import { MAIL, isMailPath } from '@/engine/mailPolicy';
import { MAIL_SWEEP_PATH, sweepAgentDraft, type MailPrunePlan } from '@/engine/mailSweep';
import { connectorStatus, mailGateRead } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { refusedAcrossVaults, useVaultStore } from '@/stores/vaultStore';
const words = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Re-read the gate and selected connector at the human action. Vault changes
 * permanently retire this action, even if the person switches back. */
export async function addSweepAgent(connector: string): Promise<string | null> {
  const state = useVaultStore.getState(),
    vault = state.vaultPath;
  if (vault === null || refusedAcrossVaults(state)) return null;
  let live = true;
  const unsubscribe = useVaultStore.subscribe((next, previous) => {
    if (next.vaultPath !== previous.vaultPath) live = false;
  });
  const current = () => live && useVaultStore.getState().vaultPath === vault;
  try {
    const [gate, rows] = await Promise.all([mailGateRead(vault), connectorStatus(vault)]);
    if (!current()) return null;
    if (gate.state !== 'open' || !gate.kinds.includes(MAIL.kinds.thread))
      throw new Error('Mail digests wait on the Gmail evidence pack (R14) for this vault.');
    const row = rows.find((row) => row.connector === connector);
    if (!row || row.refused)
      throw new Error(row?.refused ?? 'Choose an available Gmail connector.');
    const existing = useVaultStore
      .getState()
      .entries.find((entry) => entry.path === MAIL_SWEEP_PATH);
    const path =
      existing?.path ??
      (await useVaultStore.getState().createItem(sweepAgentDraft(row.connector, row.cli_name)));
    if (!current()) return null;
    useNavStore.getState().navigate({ kind: 'doc', path });
    return path;
  } catch (error) {
    if (current()) useUiStore.getState().toast(`Could not add Mail sweep: ${words(error)}`);
    return null;
  } finally {
    unsubscribe();
  }
}
/** Only MailSettings calls this on a person's Remove. The hashes and vault
 * belong to the visible preview; applyBatch supplies Trash and one Undo. */
export async function pruneDigests(plan: MailPrunePlan, vault: string): Promise<boolean> {
  const state = useVaultStore.getState();
  if (state.vaultPath !== vault || refusedAcrossVaults(state) || plan.ops.length === 0)
    return false;
  try {
    if (plan.ops.some((op) => op.op !== 'delete' || !isMailPath(op.path) || !op.expectHash))
      throw new Error('The mail removal preview is no longer valid.');
    return (
      (await state.applyBatch(plan.ops, {
        undo: `Removed ${plan.digests} mail ${plan.digests === 1 ? 'digest' : 'digests'}`,
      })) !== null
    );
  } catch (error) {
    if (useVaultStore.getState().vaultPath === vault)
      useUiStore.getState().toast(`Could not remove mail: ${words(error)}`);
    return false;
  }
}
