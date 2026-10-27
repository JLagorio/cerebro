// @vitest-environment jsdom
import { act,cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import type { EditorOperation,EditorSaveRequest,EditorSaveResult,SelectedEditorSnapshot,SelectedRecordVersion } from '@/lib/generated/workspace';
import { makeEntry } from '@/test/factories';
import { sha256Hex } from '@/lib/sha256';
import { __resetRescans,useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { __resetOpenPages,flushOpenPages,unresolvedDocumentOwners } from '@/editor/openPages';
import { SelectedTitleRecoveryHost } from '@/editor/SelectedTitleRecoveryHost';
import { TitleCell } from './TitleCell';
const path='notes/page.md';const initial='# Old title\n\nOriginal body.\n';
const target={workspaceId:'915781f1-6812-478c-8063-3f41322547f5',recordId:'76b64da5-34b6-45f2-8ab2-e2779227ace3'};
let serial=0;let vault='';let visible=initial;let canonical:SelectedRecordVersion;let editable=true;
const version=(body:string,revision='9007199254740993'):SelectedRecordVersion=>({kind:'sqlite_metadata',...target,metadataRevision:revision,metadataHash:'a'.repeat(64),bodyHash:sha256Hex(body)});
const snapshot=():SelectedEditorSnapshot=>({path,target:{...target},body:visible,version:{...canonical},observedBodyHash:sha256Hex(visible),coherence:sha256Hex(visible)===canonical.bodyHash?'paired':'external_change',editable,readOnlyReason:editable?null:'This canonical page belongs to its governed writer.'});
function operation(request:EditorSaveRequest,body:string):EditorOperation{
 const after={...canonical,metadataRevision:(BigInt(canonical.metadataRevision)+1n).toString(),bodyHash:sha256Hex(body)};
 return{path,target:{...request.target},requestKey:request.requestKey,operationId:'351a1b0f-7b33-48c4-b96c-8dc6a702897e',version:after,receipt:{workspaceId:target.workspaceId,recordId:target.recordId,epoch:after.metadataRevision,previousRevision:canonical.metadataRevision,revision:after.metadataRevision,metadataBeforeHash:canonical.metadataHash,metadataAfterHash:after.metadataHash,bodyBeforeHash:canonical.bodyHash,bodyAfterHash:after.bodyHash,actor:'human:me',operation:'page.body',at:'2026-10-26T00:00:00Z'}};
}
function applied(request:EditorSaveRequest,body:string):EditorSaveResult{
 const original=request.original??operation(request,body);visible=body;canonical={...original.version};
 return{kind:'selected_applied',operation:original,currentVersion:{...canonical},reconcileRequired:false,recovery:null};
}
beforeEach(()=>{
 cleanup();__resetOpenPages();__resetRescans();vi.restoreAllMocks();vault='/selected-title-'+(++serial);visible=initial;canonical=version(initial);editable=true;
 useVaultStore.setState({vaultPath:vault,entriesVault:vault,status:'ready',error:null,entries:[makeEntry({path,title:'Old title',hash:canonical.bodyHash,authority:{...canonical},properties:{code:'007',full_width:false},relationships:{related:['keep']}})],views:[],folders:[],rescan:vi.fn(async()=>{})});
 useUiStore.setState({toast:vi.fn()});vi.spyOn(ipc,'supportsSelectedEditor').mockReturnValue(true);
 vi.spyOn(ipc,'readEditorBody').mockImplementation(async()=>snapshot());
 vi.spyOn(ipc,'readNoteSource').mockResolvedValue({content:initial,hash:sha256Hex(initial)});
 vi.spyOn(ipc,'setNoteTitle').mockResolvedValue(undefined);
 // Descriptive native replies; actual selected CAS/receipts are established
 // by native paired tests. Legacy fallback reaches the current wrong command.
 vi.spyOn(ipc,'saveNoteBody').mockImplementation(async({body,editorRequest})=>{if(!editorRequest)throw new Error('missing selected title request');return applied(editorRequest,body);});
});
afterEach(()=>{cleanup();__resetOpenPages();__resetRescans();vi.restoreAllMocks();});
function mount(){
 const onCommit=vi.fn((title:string)=>useVaultStore.getState().setTitle(path,title));
 const current=useVaultStore.getState().entries[0];
 const view=render(<><TitleCell entry={current} onCommit={onCommit}/><SelectedTitleRecoveryHost/></>);
 return{view,onCommit};
}
async function edit(title='New title'){
 fireEvent.click(screen.getByRole('button',{name:'Old title'}));
 const input=await screen.findByRole('textbox',{name:'Title'});fireEvent.change(input,{target:{value:title}});return input;
}
async function submit(input:HTMLElement){
 fireEvent.keyDown(input,{key:'Enter'});
 await waitFor(()=>expect(vi.mocked(ipc.saveNoteBody).mock.calls.length+vi.mocked(ipc.setNoteTitle).mock.calls.length).toBeGreaterThan(0));
 expect(ipc.saveNoteBody).toHaveBeenCalledOnce();expect(ipc.setNoteTitle).not.toHaveBeenCalled();expect(ipc.readNoteSource).not.toHaveBeenCalled();
}
function owner(){
 const found=unresolvedDocumentOwners().find(item=>item.key.vaultId===vault&&item.key.path===path&&item.selectedTarget?.recordId===target.recordId);
 expect(found).toBeDefined();if(!found)throw new Error('actual title body owner missing');return found;
}
it('selected TitleCell edits only the first H1 through existing paired CAS and preserves metadata projection',async()=>{
 visible='\ufeff# Old title\r\n\r\nOriginal **body**.\r\n# Second H1 stays\r\n';canonical=version(visible);
 useVaultStore.setState({entries:[{...useVaultStore.getState().entries[0],hash:canonical.bodyHash,authority:{...canonical}}]});
 const before={...canonical};const properties=useVaultStore.getState().entries[0].properties;const relations=useVaultStore.getState().entries[0].relationships;
 const{onCommit}=mount();const input=await edit();await submit(input);
 const call=vi.mocked(ipc.saveNoteBody).mock.calls[0][0];expect(call).toMatchObject({vault,path,body:'\ufeff# New title\r\n\r\nOriginal **body**.\r\n# Second H1 stays\r\n',bodyFormat:'source',editorRequest:{target,phase:'start',expectedVersion:before}});
 expect(onCommit).not.toHaveBeenCalled();expect(useVaultStore.getState().entries[0].properties).toBe(properties);expect(useVaultStore.getState().entries[0].relationships).toBe(relations);
});
it('selected title reads YAML-looking leading content as body and never reconstructs frontmatter',async()=>{
 visible='\ufeff---\r\ntype: Agent is body text here\r\n---\r\n# Old title\r\n\r\nKeep this exactly.\r\n';canonical=version(visible);
 useVaultStore.setState({entries:[{...useVaultStore.getState().entries[0],hash:canonical.bodyHash,authority:{...canonical}}]});
 mount();await submit(await edit());
 expect(vi.mocked(ipc.saveNoteBody).mock.calls[0][0].body).toBe(visible);
 expect(visible).toBe('\ufeff---\r\ntype: Agent is body text here\r\n---\r\n# New title\r\n\r\nKeep this exactly.\r\n');
});
it('metadata-only change after title draft capture refuses with its frozen original expectation',async()=>{
 mount();const input=await edit();const expected={...canonical};canonical={...canonical,metadataRevision:'9007199254740994',metadataHash:'b'.repeat(64)};
 vi.mocked(ipc.saveNoteBody).mockRejectedValue({kind:'selected_refused',error:{code:'capability_unavailable',kind:'stale_metadata',message:'Canonical metadata changed.',retryable:true}});
 await submit(input);const original=owner();await waitFor(()=>expect(original.snapshot().failure).not.toBeNull());
 expect(original.snapshot().latestDraft).toContain('# New title');
 await act(async()=>{await flushOpenPages();});
 expect(vi.mocked(ipc.saveNoteBody).mock.calls.every(([call])=>JSON.stringify(call.editorRequest?.expectedVersion)===JSON.stringify(expected))).toBe(true);
 expect(canonical.metadataHash).toBe('b'.repeat(64));expect(ipc.setNoteTitle).not.toHaveBeenCalled();
});
it('external body change with unchanged canonical version cannot be overwritten by a selected title tick',async()=>{
 mount();const input=await edit();const expected={...canonical};visible='# External title\n\nExternal exact bytes.\n';
 vi.mocked(ipc.saveNoteBody).mockRejectedValue({kind:'selected_refused',error:{code:'capability_unavailable',kind:'source_changed',message:'Observed body changed.',retryable:true}});
 await submit(input);await waitFor(()=>expect(owner().snapshot().failure).not.toBeNull());
 expect(vi.mocked(ipc.saveNoteBody).mock.calls[0][0].editorRequest).toMatchObject({expectedVersion:expected});expect(visible).toBe('# External title\n\nExternal exact bytes.\n');
});
it('pending title save outlives cell unmount and Check save resolves its original key/body exactly once',async()=>{
 vi.mocked(ipc.saveNoteBody).mockImplementationOnce(async({body,editorRequest})=>{if(!editorRequest)throw new Error('missing request');return{kind:'selected_pending',operation:operation(editorRequest,body),error:{code:'capability_unavailable',kind:'recovery_required',message:'Original save pending.',retryable:true}};});
 const{view}=mount();await submit(await edit());const original=owner();await waitFor(()=>expect(original.snapshot().selectedSave?.status).toBe('pending'));
 const first=vi.mocked(ipc.saveNoteBody).mock.calls[0][0];view.unmount();render(<SelectedTitleRecoveryHost/>);
 fireEvent.click(await screen.findByRole('button',{name:'Check save'}));await waitFor(()=>expect(ipc.saveNoteBody).toHaveBeenCalledTimes(2));
 const second=vi.mocked(ipc.saveNoteBody).mock.calls[1][0];expect(second.body).toBe(first.body);expect(second.editorRequest).toMatchObject({requestKey:first.editorRequest?.requestKey,phase:'resolve',expectedVersion:first.editorRequest?.expectedVersion});
 await act(async()=>{await flushOpenPages();});expect(ipc.saveNoteBody).toHaveBeenCalledTimes(2);expect(original.snapshot().selectedSave).toBeUndefined();
});
it('transport-unknown title request remains frozen across a barrier after cell unmount',async()=>{
 vi.mocked(ipc.saveNoteBody).mockRejectedValueOnce(new Error('lost original reply'));
 const{view}=mount();await submit(await edit());const original=owner();await waitFor(()=>expect(original.snapshot().selectedSave?.status).toBe('unknown'));
 const first=vi.mocked(ipc.saveNoteBody).mock.calls[0][0];view.unmount();await act(async()=>{await flushOpenPages();});
 expect(ipc.saveNoteBody).toHaveBeenCalledTimes(2);const second=vi.mocked(ipc.saveNoteBody).mock.calls[1][0];expect(second.body).toBe(first.body);expect(second.editorRequest).toMatchObject({phase:'resolve',requestKey:first.editorRequest?.requestKey,expectedVersion:first.editorRequest?.expectedVersion});
 expect(original.snapshot().selectedSave).toBeUndefined();
});
it('Use new after an unknown title outcome cannot replay an old field title on a later barrier',async()=>{
 vi.mocked(ipc.saveNoteBody).mockImplementationOnce(async()=>{visible='# Other title\n\nNew paired body.\n';canonical=version(visible,'9007199254740994');return{kind:'selected_outcome_unknown',error:{code:'capability_unavailable',kind:'source_changed',message:'Original title outcome unknown.',retryable:false}};});
 const{view}=mount();await submit(await edit());const original=owner();await waitFor(()=>expect(original.snapshot().selectedSave?.status).toBe('reconcile'));
 view.unmount();render(<SelectedTitleRecoveryHost/>);const group=await screen.findByRole('group',{name:'Choose a version'});fireEvent.click(within(group).getByRole('button',{name:'Use new'}));
 await waitFor(()=>expect(original.snapshot().selectedSave).toBeUndefined());await act(async()=>{await flushOpenPages();});
 expect(ipc.saveNoteBody).toHaveBeenCalledOnce();expect(ipc.setNoteTitle).not.toHaveBeenCalled();expect(unresolvedDocumentOwners()).toEqual([]);expect(visible).toContain('# Other title');
});
it('governed canonical selected page remains readonly and never falls back to the legacy title writer',async()=>{
 editable=false;mount();fireEvent.click(screen.getByRole('button',{name:'Old title'}));
 await act(async()=>{await Promise.resolve();});
 expect(ipc.readEditorBody).toHaveBeenCalledWith(vault,path,target);expect(screen.getByText('This canonical page belongs to its governed writer.')).toBeTruthy();
 expect(ipc.saveNoteBody).not.toHaveBeenCalled();expect(ipc.setNoteTitle).not.toHaveBeenCalled();expect(ipc.readNoteSource).not.toHaveBeenCalled();
});

it('incomplete selected title stays visible and reattaches its exact child after cell unmount',async()=>{
 const{view}=mount();await edit('');const original=owner();
 expect(original.snapshot().childDrafts?.['selected-title']).toBe('');
 view.unmount();const host=render(<SelectedTitleRecoveryHost/>);
 expect(await screen.findByText(/incomplete title draft/i)).toBeTruthy();
 await act(async()=>{await flushOpenPages();});
 expect(ipc.saveNoteBody).not.toHaveBeenCalled();expect(ipc.setNoteTitle).not.toHaveBeenCalled();
 host.unmount();mount();fireEvent.click(screen.getByRole('button',{name:'Old title'}));
 const input=await screen.findByRole('textbox',{name:'Title'});expect((input as HTMLInputElement).value).toBe('');
 expect(owner()).toBe(original);expect(original.snapshot().childDrafts?.['selected-title']).toBe('');
});

it('selected title input owns its click and keyboard completion inside the existing grid',async()=>{
 const click=vi.fn();const key=vi.fn();const current=useVaultStore.getState().entries[0];
 render(<div role="grid" tabIndex={0} aria-label="Records" onClick={click} onKeyDown={key}><TitleCell entry={current} onCommit={title=>useVaultStore.getState().setTitle(path,title)}/></div>);
 const input=await edit();click.mockClear();key.mockClear();fireEvent.click(input);
 expect(click).not.toHaveBeenCalled();fireEvent.keyDown(input,{key:'Enter'});
 await waitFor(()=>expect(ipc.saveNoteBody).toHaveBeenCalledOnce());expect(key).not.toHaveBeenCalled();
 await waitFor(()=>expect(document.activeElement).toBe(screen.getByRole('grid',{name:'Records'})));
});
it('selected title does not dispatch while the native input is composing Enter',async()=>{
 mount();const input=await edit();fireEvent.keyDown(input,{key:'Enter',isComposing:true});
 await act(async()=>{await Promise.resolve();});expect(ipc.saveNoteBody).not.toHaveBeenCalled();
 expect((input as HTMLInputElement).value).toBe('New title');
 await submit(input);
});
