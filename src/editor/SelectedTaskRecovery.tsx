import { Button } from '@/components/ui/Button';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SelectedEditorSnapshot } from '@/lib/generated/workspace';
import { readEditorBody } from '@/lib/ipc';
import { useVaultActionGuard } from '@/hooks/useVaultActionGuard';
import { acceptSelectedEditorVersion, useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import type { DocumentOwner, SaveOutcome } from './documentOwner';
import { MergeChoices } from './MergeChoices';
import { RecoverySaveStatus, recoveryOutcomeText } from './RecoverySaveStatus';
import { sameSelectedObservation, selectedSnapshotFor } from './selectedSnapshot';
import { retireRefusedTask, selectedTaskRefusalMessage } from './selectedTaskOwner';
import { acceptSelectedTitleOutcome } from './selectedTitleOutcome';
import { prepareSelectedTitle, TITLE_CHILD } from './selectedTitleDraft';
interface Choice { requestKey: string; generation: number; snapshot: SelectedEditorSnapshot }
/** The same existing owner/whole-page choice pipeline, hosted outside an editor.
 * Native requests, receipts and recovery decisions remain in DocumentOwner. */
export function SelectedTaskRecovery({ owner, kind = 'task' }: { owner: DocumentOwner; kind?: 'task' | 'title' }) {
  const isTitle = kind === 'title';
  const [state, setState] = useState(() => owner.snapshot());
  const [choice, setChoice] = useState<Choice | null>(null);
  const choiceRef = useRef<Choice | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startAction = useVaultActionGuard(owner.key.vaultId + ':' + owner.key.path + ':' + owner.key.ownerId);
  const remember = useCallback((next: Choice | null) => { choiceRef.current = next; setChoice(next); }, []);
  useEffect(() => {
    mounted.current = true; setState(owner.snapshot());
    const stop = owner.subscribe(() => setState(owner.snapshot()));
    return () => { mounted.current = false; stop(); };
  }, [owner]);
  const read = useCallback(async () => {
    if (!owner.selectedTarget) throw new Error('Original selected page target is unavailable.');
    const snapshot = await readEditorBody(owner.key.vaultId, owner.key.path, owner.selectedTarget);
    if (!selectedSnapshotFor(snapshot, owner.key.path, owner.selectedTarget)) throw new Error('Original selected page observation changed.');
    return snapshot;
  }, [owner]);
  const load = useCallback(async () => {
    const current = startAction(); const before = owner.snapshot(); const selected = before.selectedSave;
    if (!current()) return;
    if (selected === undefined && before.reconcileRequired === true &&
      before.generation === before.acknowledgedGeneration && !owner.recoveryBusy()) {
      try {
        const observed = await read(); const after = owner.snapshot();
        if (!current() || after.selectedSave !== undefined || owner.recoveryBusy() ||
          after.generation !== before.generation || after.generation !== after.acknowledgedGeneration ||
          after.reconcileRequired !== true) return;
        // The receipt already confirmed this generated tick. Refresh the local
        // clean owner from an exact current observation; this makes no write.
        owner.finishReconcile(); owner.acceptExternal(observed.body);
        await useVaultStore.getState().rescan();
      } catch { if (current()) setError('The page save is confirmed, but its current page could not refresh. Retry the comparison.'); }
      return;
    }
    if (selected?.status !== 'reconcile') return;
    try {
      const snapshot = await read(); const after = owner.snapshot();
      if (!current() || after.generation !== before.generation ||
        after.selectedSave?.status !== 'reconcile' || after.selectedSave.requestKey !== selected.requestKey) return;
      remember({ requestKey: selected.requestKey, generation: after.generation, snapshot }); setError(null);
    } catch { if (current()) setError('The original page could not be compared. Its draft and earlier attempt are kept.'); }
  }, [owner, read, remember, startAction]);
  const ownerBusy = owner.recoveryBusy();
  const selectedStatus = state.selectedSave?.status;
  const selectedKey = state.selectedSave?.requestKey;
  const selectedAbsent = state.selectedSave === undefined;
  useEffect(() => {
    if (selectedStatus === 'reconcile' ||
      (selectedAbsent && state.reconcileRequired === true &&
        state.generation === state.acknowledgedGeneration && !ownerBusy)) void load();
    else remember(null);
  }, [load, remember, ownerBusy, selectedStatus, selectedKey, selectedAbsent,
    state.generation, state.acknowledgedGeneration, state.reconcileRequired]);
  const catchUp = useCallback(async (outcome: SaveOutcome, current: () => boolean) => {
    if (outcome.kind === 'failed') {
      if (isTitle) {
        if (current()) setError('The title was not saved. Your authored page draft is kept. Compare the current page before changing this attempt.');
        return;
      }
      if (current()) {
        useUiStore.getState().toast(selectedTaskRefusalMessage(owner, outcome.code) ?? "The task changed before its checked edit could be saved. Review the refreshed page before trying again.");
        const refresh = useVaultStore.getState().rescan();
        retireRefusedTask(owner); await refresh;
      } else retireRefusedTask(owner);
      return;
    }
    if (outcome.kind !== 'acknowledged' || !current()) return;
    if (isTitle) acceptSelectedTitleOutcome(owner, outcome);
    const write = outcome.write;
    if (write.kind !== 'selected_applied' && write.kind !== 'selected_unchanged') return;
    if (write.kind === 'selected_applied' && write.recovery != null) {
      const message = recoveryOutcomeText(write.recovery);
      if (message) useUiStore.getState().toast(message);
    }
    if (write.kind === 'selected_applied' && write.reconcileRequired) {
      const observed = await read();
      if (!current() || owner.snapshot().selectedSave !== undefined || owner.recoveryBusy()) return;
      owner.finishReconcile(); owner.acceptExternal(observed.body);
    } else {
      const version = write.kind === 'selected_applied' ? write.currentVersion : write.version;
      if (owner.selectedTarget) acceptSelectedEditorVersion(owner.key.vaultId, owner.key.path, owner.selectedTarget, version);
    }
    await useVaultStore.getState().rescan();
  }, [owner, read, isTitle]);
  const check = () => {
    const current = startAction();
    void owner.retry().then(outcome => catchUp(outcome, current)).catch(() => {
      if (current()) setError('The save was checked, but the page could not refresh. The original owner is kept.');
    });
  };
  const pick = async (which: 'mine' | 'theirs') => {
    const original = choiceRef.current; if (!original || busy.current) return;
    const current = startAction(); const before = owner.snapshot();
    if (before.selectedSave?.status !== 'reconcile' || before.selectedSave.requestKey !== original.requestKey) return;
    busy.current = true; setWorking(true); setError(null);
    try {
      const observed = await read(); const after = owner.snapshot();
      if (!current() || choiceRef.current !== original || after.selectedSave?.status !== 'reconcile' ||
        after.selectedSave.requestKey !== original.requestKey) return;
      if (after.generation !== original.generation || !sameSelectedObservation(original.snapshot, observed)) {
        remember({ requestKey: original.requestKey, generation: after.generation, snapshot: observed }); return;
      }
      if (which === 'mine' && (!observed.editable || observed.coherence !== 'paired')) {
        setError(observed.readOnlyReason ?? 'The page must have a paired editable body before keeping this page draft. You can use the new body without writing.'); return;
      }
      if (!owner.settleSelectedReconcile({ requestKey: original.requestKey, generation: after.generation, snapshot: observed, choice: which })) return;
      remember(null);
      if (which === 'mine') await catchUp(await owner.flush(), current);
      else if (current()) await useVaultStore.getState().rescan();
    } catch { if (current()) setError('The original page could not be compared or refreshed. The draft remains owned.'); }
    finally { busy.current = false; if (mounted.current) setWorking(false); }
  };
  const incompleteTitle = isTitle && state.childDrafts?.[TITLE_CHILD] !== undefined;
  return <div aria-label={(isTitle ? 'Title save for ' : 'Task save for ') + owner.key.path}>
    {incompleteTitle && <p role="status">Incomplete title draft kept for {owner.key.path}. Reopen its title cell to finish it.</p>}
    {isTitle && state.failure !== null && state.selectedSave === undefined && <>
      <p role="status">The title was not saved. Your authored page draft is kept.</p>
      <Button size="sm" variant="ghost" type="button" disabled={owner.recoveryBusy()} onClick={() => { owner.compareSelectedRefusal(); }}>Compare current page</Button>
    </>}
    {isTitle && state.failure === null && state.selectedSave === undefined && !state.reconcileRequired &&
      state.generation !== state.acknowledgedGeneration && <><p role="status">Title draft kept for {owner.key.path}.</p><Button size="sm" variant="ghost" type="button" disabled={owner.recoveryBusy() || incompleteTitle} onClick={() => {
        prepareSelectedTitle(owner); const current = startAction();
        void owner.flush().then(outcome => catchUp(outcome, current)).catch(() => { if (current()) setError('The title draft remains owned; its save could not be checked.'); });
      }}>Save title</Button></>}
    <RecoverySaveStatus owner={owner} onCheck={check} />
    {error && <p data-testid="section-unavailable">{error} <Button size="sm" variant="ghost" type="button" onClick={() => { void load(); }}>Retry page comparison</Button></p>}
    {choice !== null && (!choice.snapshot.editable || choice.snapshot.coherence !== 'paired') &&
      <p role="status">{choice.snapshot.readOnlyReason ?? 'Keeping this page draft requires a paired editable page. Use new keeps the current body without writing.'}</p>}
    <MergeChoices choices={choice === null ? [] : [{ id: 'task-page', mine: state.latestDraft, theirs: choice.snapshot.body, firstBlockId: null }]}
      description={state.selectedSave?.reason === 'refused' ? "The title save was refused. Compare the complete page versions before choosing." : "The earlier page save could not be confirmed. Compare the complete page versions before choosing."}
      disabled={working} keepMineDisabled={choice !== null && (!choice.snapshot.editable || choice.snapshot.coherence !== 'paired')}
      onPick={(_id, which) => { void pick(which); }} />
  </div>;
}
