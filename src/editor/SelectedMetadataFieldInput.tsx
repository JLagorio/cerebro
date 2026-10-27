import { useEffect,useId,useRef,useState,useSyncExternalStore } from 'react';
import type { Entry } from '@/engine/types';
import { useVaultActionGuard } from '@/hooks/useVaultActionGuard';
import { patchSelectedMetadata,readSelectedProperty,supportsSelectedEditor } from '@/lib/ipc';
import { getVaultOpening,useVaultStore } from '@/stores/vaultStore';
import { AnchoredFieldStatus } from '@/detail/AnchoredFieldStatus';
import { Switch } from '@/components/ui/Switch';
import { Button } from '@/components/ui/Button';
import { waitForDocumentAdmission } from './documentAdmission';
import { announceExternalWrites,flushOpenPageBodies,heldOpenPageBodies } from './openPages';
import { attachSelectedMetadataField,retainedSelectedMetadataField,type MetadataFieldApi,type MetadataFieldScope,type SelectedMetadataFieldOwner } from './selectedMetadataFieldOwner';
import { SelectedMetadataRecovery } from './SelectedMetadataRecovery';
/** The cell presents a field owner; it never composes frontmatter or body bytes. */
type EditorKind='text'|'checkbox'|'number'|'date';
const valueFits=(kind:EditorKind,value:ReturnType<SelectedMetadataFieldOwner['getValue']>)=>value.kind==='absent'||value.value.kind==='null'||value.value.kind===(kind==='checkbox'?'boolean':kind==='number'?'decimal':kind==='date'?'date':'string');
export function SelectedMetadataFieldInput({entry,vault,field,label,onEnd,kind='text',inputMode='text'}:{entry:Entry;vault:string;field:string;label:string;onEnd:()=>void;kind?:EditorKind;inputMode?:'text'|'email'|'tel'|'url'|'decimal'}){
 const original=useRef(entry);const [owner,setOwner]=useState<SelectedMetadataFieldOwner|null>(null);const [error,setError]=useState<string|null>(null);
 const startAction=useVaultActionGuard(vault+':'+entry.path+':'+entry.authority?.recordId+':'+field);
 useEffect(()=>{
  const source=original.current;const version=source.authority;const current=startAction();const opening=getVaultOpening();
  const valid=()=>current()&&getVaultOpening()===opening;let release:(()=>void)|undefined;
  const load=async()=>{
   if(!version||version.kind!=='sqlite_metadata'||!supportsSelectedEditor())throw new Error('Canonical property editing is unavailable here.');
   const scope:MetadataFieldScope={vault,path:source.path,field,target:{workspaceId:version.workspaceId,recordId:version.recordId}};
   const retained=retainedSelectedMetadataField(scope);
   if(retained){if(!valueFits(kind,retained.getValue()))throw new Error('An earlier typed property save is kept in Property saves. Resolve it before using another editor.');if(valid()){release=retained.attach();setOwner(retained);}return;}
   const key={vaultId:vault,path:source.path,ownerId:'selected-property:'+version.workspaceId+':'+version.recordId+':'+field};
   if(!await waitForDocumentAdmission(key,valid))return;
   const report=await flushOpenPageBodies();if(!valid())return;
   if(report.unresolvedOwnerIds.length||heldOpenPageBodies().includes(source.path))throw new Error('Finish the open page save before editing this property.');
   const observed=await readSelectedProperty(vault,source.path,scope.target,field);if(!valid())return;
   const active=useVaultStore.getState();const row=active.entries.find(item=>item.path===source.path);
   if(active.vaultPath!==vault||active.entriesVault!==vault||active.status!=='ready'||row?.authority?.workspaceId!==scope.target.workspaceId||row.authority.recordId!==scope.target.recordId)throw new Error('The original selected record changed. Reopen its property.');
   if(!observed.editable)throw new Error(observed.readOnlyReason??'This canonical property is read-only.');
   if(!valueFits(kind,observed.value))throw new Error('This stored value needs another typed editor. It is shown without converting it.');
   if(observed.coherence!=='paired'||observed.observedBodyHash!==observed.version.bodyHash)throw new Error('The body changed outside its paired metadata. Review the page before editing this property.');
   const api:MetadataFieldApi={
    read:originalScope=>readSelectedProperty(originalScope.vault,originalScope.path,originalScope.target,originalScope.field),
    patch:async(originalScope,request)=>{
     let result:Awaited<ReturnType<MetadataFieldApi['patch']>>|undefined;let failed=false;let failure:unknown;
     await announceExternalWrites([originalScope.path],async()=>{try{result=await patchSelectedMetadata(originalScope.vault,originalScope.path,request);}catch(error){failed=true;failure=error;}});
     if(failed)throw failure;if(result===undefined)throw new Error('Original field outcome is unavailable.');return result;
    },
    mintKey:()=>crypto.randomUUID(),
    accepted:originalScope=>{
     // Rescan only. A body ACK helper cannot project a changed metadata hash,
     // and unrelated properties may already be newer than the captured frame.
     const active=useVaultStore.getState();if(active.vaultPath!==originalScope.vault||active.entriesVault!==originalScope.vault)return;
     void announceExternalWrites([originalScope.path],async()=>{await useVaultStore.getState().rescan();});
    },
   };
   const attached=attachSelectedMetadataField(scope,observed,api);
   if(!attached)throw new Error('The requested canonical field could not be verified.');
   // No await between the final lifetime check and recording the exact release.
   release=attached.release;setOwner(attached.owner);
  };
  void load().catch(failure=>{if(valid())setError(failure instanceof Error?failure.message:'The requested property is unavailable.');});
  return()=>{release?.();};
 },[vault,field,startAction,kind]);
 if(owner===null)return <span className="inline-flex min-w-0 max-w-full flex-col items-start gap-1"><span role="status" className="text-ui text-n-700">{error??'Reading property…'}</span>{error&&<Button type="button" size="sm" variant="ghost" onClick={onEnd}>Done</Button>}</span>;
 return <ReadyMetadataField owner={owner} label={label} onEnd={onEnd} kind={kind} inputMode={inputMode}/>;
}
function ReadyMetadataField({owner,label,onEnd,kind,inputMode}:{owner:SelectedMetadataFieldOwner;label:string;onEnd:()=>void;kind:EditorKind;inputMode:'text'|'email'|'tel'|'url'|'decimal'}){
 const state=useSyncExternalStore(owner.subscribe,owner.getSnapshot,owner.getSnapshot);const startAction=useVaultActionGuard(owner.key.vaultId+':'+owner.key.path+':'+owner.key.ownerId);
 const recoveryFocus=useRef<{grid:HTMLElement;eligible:()=>boolean;afterClose:()=>boolean;stop:()=>void}|null>(null);
 const area=useRef<HTMLSpanElement>(null);const input=useRef<HTMLInputElement>(null);const ended=useRef(false);const suppressBlur=useRef(false);const end=useRef(onEnd);end.current=onEnd;const id=useId();
 useEffect(()=>{if(kind==='checkbox')input.current=area.current?.querySelector('input')??null;input.current?.focus();if(kind!=='checkbox')input.current?.select();},[owner,kind]);
 useEffect(()=>()=>{recoveryFocus.current?.stop();recoveryFocus.current=null;},[owner]);
 const beginRecoveryAction=()=>{
  recoveryFocus.current?.stop();recoveryFocus.current=null;
  const node=area.current;const grid=node?.closest<HTMLElement>('[role="grid"]');
  if(!node||!grid||!node.contains(document.activeElement))return;
  const current=startAction();const opening=getVaultOpening();let cancelled=false;
  const outsideFocus=(event:FocusEvent)=>{if(event.target instanceof Node&&event.target!==document.body&&!node.contains(event.target))cancelled=true;};
  const outsidePointer=(event:PointerEvent)=>{if(event.target instanceof Node&&!node.contains(event.target))cancelled=true;};
  const lostWindow=()=>{cancelled=true;};
  document.addEventListener('focusin',outsideFocus,true);document.addEventListener('pointerdown',outsidePointer,true);window.addEventListener('blur',lostWindow);
  const stop=()=>{document.removeEventListener('focusin',outsideFocus,true);document.removeEventListener('pointerdown',outsidePointer,true);window.removeEventListener('blur',lostWindow);};
  // The component may legitimately unmount when this known original settles.
  // Decide its lifetime guard before ending, then retain only opening/grid and
  // outside-intent checks for the single queued focus restoration.
  const afterClose=()=>!cancelled&&getVaultOpening()===opening&&useVaultStore.getState().vaultPath===owner.key.vaultId&&grid.isConnected&&!grid.closest('[inert], [data-parked="true"], [data-active="false"]')&&(document.activeElement===document.body||node.contains(document.activeElement));
  recoveryFocus.current={grid,eligible:()=>current()&&afterClose(),afterClose,stop};
 };
 // Explicit Use current completes the old presentation, including when that
 // current field has become readonly. A later editor must obtain admission anew.
 useEffect(()=>{
  if(!ended.current&&state.generation>0&&state.generation===state.acknowledgedGeneration&&!state.busy&&state.request===null&&state.phase==='idle'&&(kind!=='checkbox'||state.confirmed===null)){
   const host=area.current;const recorded=recoveryFocus.current;recoveryFocus.current=null;
   const grid=recorded?.grid??host?.closest<HTMLElement>('[role="grid"]');
   const restore=recorded?recorded.eligible():host?.contains(document.activeElement)===true;
   ended.current=true;end.current();
   if(restore)queueMicrotask(()=>{try{if(grid?.isConnected&&!grid.closest('[inert], [data-parked="true"], [data-active="false"]')&&(recorded?recorded.afterClose():document.activeElement===document.body||host?.contains(document.activeElement)))grid.focus({preventScroll:true});}finally{recorded?.stop();}});
   else recorded?.stop();
  }else if(!state.busy){recoveryFocus.current?.stop();recoveryFocus.current=null;}
 },[state,kind]);
 const finish=(restoreFocus=false)=>{
  if(ended.current)return;const node=area.current;const grid=node?.closest<HTMLElement>('[role="grid"]');const host=node?.parentElement;
  const ownsFocus=node?.contains(document.activeElement)===true||document.activeElement===document.body;
  ended.current=true;end.current();if(!restoreFocus||!ownsFocus)return;
  if(grid?.isConnected&&!grid.closest('[inert], [data-parked="true"], [data-active="false"]'))grid.focus({preventScroll:true});
  else requestAnimationFrame(()=>{
   if(document.activeElement!==null&&document.activeElement!==document.body)return;
   if(host?.isConnected&&!host.closest('[inert], [data-parked="true"], [data-active="false"]'))host.querySelector<HTMLButtonElement>('button[data-cell-primary]')?.focus({preventScroll:true});
  });
 };
 const save=(keyboard=false)=>{
  if(ended.current)return;const current=startAction();const opening=getVaultOpening();const field=input.current;const grid=field?.closest<HTMLElement>('[role="grid"]');
  void owner.flush().then(result=>{if(!current()||getVaultOpening()!==opening)return;if(result.kind==='committed'||result.kind==='clean'){
   if(kind!=='checkbox')finish();
   if(keyboard&&(document.activeElement===field||document.activeElement===document.body))queueMicrotask(()=>{if(grid?.isConnected)grid.focus();});
  }});
 };
 const blocked=state.busy||state.request!==null;const hasStatus=state.busy||state.message!==null;const value=owner.getValue();
 const checked=value.kind==='present'&&value.value.kind==='boolean'&&value.value.value;
 const unset=value.kind==='absent'||value.value.kind==='null';
 const description=value.kind==='absent'?'Not set':value.value.kind==='null'?'Null':checked?'On':'Off';
 return <span ref={area} className="relative flex min-w-0 max-w-full flex-1 flex-col gap-1" aria-busy={state.busy}>
  {kind==='checkbox'?<span className="inline-flex flex-wrap items-center gap-2" onClick={event=>event.stopPropagation()} onKeyDown={event=>{if(event.key==='Enter'||event.key===' ')event.stopPropagation();}}>
   <Switch ariaLabel={label} label={description} checked={checked} disabled={blocked} onChange={next=>{owner.editBoolean(next);save();}}/>
   {unset&&<Button size="sm" variant="ghost" disabled={blocked} onClick={()=>{owner.editBoolean(false);save();}}>Set off</Button>}
   <Button size="sm" variant="ghost" onClick={()=>finish(true)}>Done</Button>
  </span>:<input ref={input} type="text" inputMode={inputMode} placeholder={kind==='date'?'YYYY-MM-DD':undefined} aria-label={label} value={state.latestDraft} readOnly={blocked} aria-invalid={state.phase==='failed'||undefined} aria-describedby={hasStatus?id:undefined}
   className="min-h-7 w-full min-w-0 rounded-md border border-cortex-500 bg-surface-raised px-1.5 text-ui text-n-900 shadow-[var(--ring)] outline-none"
   onClick={event=>event.stopPropagation()} onChange={event=>kind==='number'?owner.editDecimal(event.target.value):kind==='date'?owner.editDate(event.target.value):owner.edit(event.target.value)}
   onBlur={()=>{if(!suppressBlur.current&&owner.getSnapshot().phase==='idle')save();}}
   onKeyDown={event=>{
    if(event.nativeEvent.isComposing){if(event.key==='Enter')event.stopPropagation();return;}
    if(event.key==='Enter'){event.preventDefault();event.stopPropagation();save(true);}
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(owner.recovery.retire())finish(true);}
   }}/>}
  <AnchoredFieldStatus anchor={input} id={id} error={state.phase==='failed'} floating>{state.busy?state.message??'Saving…':state.message}</AnchoredFieldStatus>
  {state.phase==='idle'&&state.request===null&&<button type="button" className="self-start text-xs text-n-600 underline" onMouseDown={event=>event.preventDefault()} onClick={event=>{event.stopPropagation();owner.remove();save();}}>Remove property</button>}
  <SelectedMetadataRecovery owner={owner} showStatus={false} onRecoveryActionStart={beginRecoveryAction} onRecoveryOpenChange={open=>{suppressBlur.current=open;}}/>
 </span>;
}
