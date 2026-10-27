import { useState,useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import type { SelectedMetadataFieldOwner } from './selectedMetadataFieldOwner';
import { MergeChoices } from './MergeChoices';
import { DeletedDraftRecovery } from './DeletedDraftRecoveryFace';
/** Presentation of the existing property's original-request owner, never a
 * second write intent or reconstruction of a request from exported data. */
export function SelectedMetadataRecovery({owner,showStatus=true,onRecoveryOpenChange,onRecoveryActionStart}:{owner:SelectedMetadataFieldOwner;showStatus?:boolean;onRecoveryOpenChange?:(open:boolean)=>void;onRecoveryActionStart?:()=>void}){
 const state=useSyncExternalStore(owner.subscribe,owner.getSnapshot,owner.getSnapshot);const[recovery,setRecovery]=useState(false);
 const current=state.comparison;
 const preview=current===null?'':current.value.kind==='absent'?'(property absent)':current.value.value.kind==='string'?JSON.stringify(current.value.value.value):JSON.stringify(current.value.value);
 const busy=state.busy;const compare=()=>{void owner.compare();};
 return <section aria-label={'Property save for '+owner.scope.path+': '+owner.scope.field} className="min-w-0 text-ui text-n-800">
  {showStatus&&<p role="status">{state.message??'Property draft kept for '+owner.scope.path+'.'}</p>}
  <div className="flex flex-wrap gap-2" onMouseDownCapture={event=>event.preventDefault()}>
   {state.phase==='unknown'&&<Button type="button" size="sm" variant="ghost" disabled={busy} onClick={event=>{event.stopPropagation();onRecoveryActionStart?.();void owner.retry();}}>Check save</Button>}
   {state.phase==='failed'&&<Button type="button" size="sm" variant="ghost" disabled={busy} onClick={event=>{event.stopPropagation();onRecoveryActionStart?.();void owner.retry();}}>Retry saving property</Button>}
   {state.request!==null&&<Button type="button" size="sm" variant="ghost" disabled={busy} onClick={event=>{event.stopPropagation();compare();}}>Compare versions</Button>}
   {state.phase==='idle'&&state.generation!==state.acknowledgedGeneration&&<Button type="button" size="sm" variant="ghost" disabled={busy} onClick={()=>{void owner.flush();}}>Save property</Button>}
   <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={event=>{event.stopPropagation();const open=!recovery;onRecoveryOpenChange?.(open);setRecovery(open);}}>Copy or export draft</Button>
  </div>
  {current!==null&&(!current.editable||current.coherence!=='paired')&&<p className="text-n-600">{current.readOnlyReason??'Keeping this draft requires a paired editable property.'}</p>}
  <MergeChoices choices={current===null?[]:[{id:'metadata-field',mine:owner.intentPreview(),theirs:preview,firstBlockId:null}]}
   description="Compare this one property's exact values. A changed comparison requires another explicit choice."
   disabled={busy} keepMineDisabled={current!==null&&(!current.editable||current.coherence!=='paired'||current.observedBodyHash!==current.version.bodyHash)}
   mineLabel="Keep mine" currentLabel="Use current" onPick={(_id,pick)=>{onRecoveryActionStart?.();void owner.choose(pick==='mine'?'mine':'current');}}/>
  <Dialog open={recovery} title="Retained property draft" onClose={()=>{onRecoveryOpenChange?.(false);setRecovery(false);}}><DeletedDraftRecovery vaultId={owner.scope.vault} path={owner.scope.path} fallback={<p>The original property draft has settled.</p>}/></Dialog>
 </section>;
}
