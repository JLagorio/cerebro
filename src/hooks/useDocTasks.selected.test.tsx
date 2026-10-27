// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import type { AuthorityError, EditorOperation, EditorSaveRequest, EditorSaveResult, SelectedEditorSnapshot, SelectedRecordVersion } from '@/lib/generated/workspace';
import { makeEntry } from '@/test/factories';
import { sha256Hex } from '@/lib/sha256';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { __resetOpenPages, unresolvedDocumentOwners, registerSaveParticipant, flushOpenPages } from '@/editor/openPages';
import { DocumentOwner } from '@/editor/documentOwner';
import { useDocTasks } from './useDocTasks';

const path='notes/plan.md';
const initial='# Plan\n\n- [ ] Call vendor\n';
const target={workspaceId:'915781f1-6812-478c-8063-3f41322547f5',recordId:'76b64da5-34b6-45f2-8ab2-e2779227ace3'};
let serial=0;
let vault='';
let currentVersion: SelectedRecordVersion;
const version=(body=initial,revision='1',metadataHash='a'.repeat(64)): SelectedRecordVersion=>({kind:'sqlite_metadata',...target,metadataRevision:revision,metadataHash,bodyHash:sha256Hex(body)});
const snapshot=(body=initial,current=currentVersion): SelectedEditorSnapshot=>({path,target:{...target},body,observedBodyHash:sha256Hex(body),version:current,coherence:'paired',editable:true});
const error: AuthorityError={code:'capability_unavailable',kind:'recovery_required',message:'The original selected tick needs recovery.',retryable:true};
/** Descriptive native replies only. Actual paired-service tests establish
 * filesystem/SQLite CAS, receipts and displaced-body retention. */
function operation(request: EditorSaveRequest,body: string): EditorOperation {
  const after={...currentVersion,metadataRevision:(BigInt(currentVersion.metadataRevision)+1n).toString(),bodyHash:sha256Hex(body)};
  return {path,target:{...request.target},requestKey:request.requestKey,operationId:'351a1b0f-7b33-48c4-b96c-8dc6a702897e',version:after,receipt:{workspaceId:request.target.workspaceId,recordId:request.target.recordId,epoch:'2',previousRevision:currentVersion.metadataRevision,revision:after.metadataRevision,metadataBeforeHash:currentVersion.metadataHash,metadataAfterHash:currentVersion.metadataHash,bodyBeforeHash:currentVersion.bodyHash,bodyAfterHash:after.bodyHash,actor:'human:me',operation:'page.body',at:'2026-10-26T00:00:00Z'}};
}
function applied(request: EditorSaveRequest,body: string): EditorSaveResult {
  const original=request.original??operation(request,body);
  return {kind:'selected_applied',operation:original,currentVersion:original.version,reconcileRequired:false,recovery:null};
}
function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>((done)=>{resolve=done;}); return {promise,resolve}; }
const entry=(authority=currentVersion)=>makeEntry({path,hash:authority.bodyHash,authority,bodyObservation:{coherence:'paired',observedBodyHash:authority.bodyHash}});
beforeEach(()=>{
  cleanup(); __resetOpenPages(); vi.restoreAllMocks(); vault='/selected-task-'+(++serial); currentVersion=version(initial,String(serial));
  useVaultStore.setState({vaultPath:vault,entriesVault:vault,status:'ready',error:null,entries:[entry()],views:[],folders:[],rescan:vi.fn(async()=>{})});
  useUiStore.setState({toast:vi.fn()});
  vi.spyOn(ipc,'supportsSelectedEditor').mockReturnValue(true);
  vi.spyOn(ipc,'readEditorBody').mockImplementation(async()=>snapshot());
  // Legacy replies let the existing unadopted hook reach its actual wrong
  // writer. Tests assert that selected dispatch never uses either fallback.
  vi.spyOn(ipc,'readNoteSource').mockResolvedValue({content:initial,hash:sha256Hex(initial)});
  vi.spyOn(ipc,'saveNote').mockImplementation(async(_vault,_path,body)=>sha256Hex(body));
  vi.spyOn(ipc,'saveNoteBody').mockImplementation(async({body,editorRequest})=>{
    if(!editorRequest)throw new Error('selected request missing at actual checklist consumer');
    const reply=applied(editorRequest,body);
    if(reply.kind==='selected_applied')
      vi.mocked(ipc.readEditorBody).mockResolvedValue(snapshot(body,reply.currentVersion));
    return reply;
  });
});
afterEach(()=>{cleanup();__resetOpenPages();vi.restoreAllMocks();});
async function mountTasks(){
  const view=renderHook(useDocTasks);
  await waitFor(()=>expect(view.result.current.loading).toBe(false));
  expect(view.result.current.tasks).toHaveLength(1);
  return view;
}
function selectedOwner(){
  const owner=unresolvedDocumentOwners().find(owner=>owner.key.vaultId===vault && owner.key.path===path && owner.selectedTarget?.recordId===target.recordId);
  expect(owner).toBeInstanceOf(DocumentOwner);
  if(!owner)throw new Error('actual selected task operation was not retained');
  return owner;
}
async function startTick(view: Awaited<ReturnType<typeof mountTasks>>){
  let finished!: Promise<void>;
  act(()=>{finished=view.result.current.toggle(view.result.current.tasks[0],true);});
  // Both branches are real production calls. Wrong legacy dispatch fails the
  // following assertion promptly instead of making a timeout the RED signal.
  await waitFor(()=>expect(vi.mocked(ipc.saveNoteBody).mock.calls.length+vi.mocked(ipc.saveNote).mock.calls.length).toBeGreaterThan(0));
  expect(ipc.saveNoteBody).toHaveBeenCalledOnce();
  return {finished};
}

it('selected checklist reads the complete visible body without splitting YAML-looking bytes',async()=>{
  const raw='\ufeff---\r\n- [ ] YAML-looking task\r\n---\r\n# Plan\r\n- [ ] Call vendor\r\n';
  currentVersion=version(raw,String(serial));useVaultStore.setState({entries:[entry()]});
  vi.mocked(ipc.readEditorBody).mockResolvedValue(snapshot(raw));vi.mocked(ipc.readNoteSource).mockResolvedValue({content:raw,hash:sha256Hex(raw)});
  const {result}=renderHook(useDocTasks);await waitFor(()=>expect(result.current.loading).toBe(false));
  expect(result.current.tasks.map(task=>task.text)).toEqual(['YAML-looking task','Call vendor']);
  expect(ipc.readEditorBody).toHaveBeenCalledWith(vault,path,target);expect(ipc.readNoteSource).not.toHaveBeenCalled();
});
it('selected tick sends exact edited bytes through existing selected save request with full CAS expectation',async()=>{
  const view=await mountTasks();await act(async()=>view.result.current.toggle(view.result.current.tasks[0],true));
  expect(ipc.saveNoteBody).toHaveBeenCalledOnce();expect(ipc.saveNote).not.toHaveBeenCalled();
  expect(ipc.saveNoteBody).toHaveBeenCalledWith(expect.objectContaining({vault,path,body:initial.replace('[ ]','[x]'),bodyFormat:'source',editorRequest:expect.objectContaining({target,phase:'start',expectedVersion:currentVersion})}));
  expect(view.result.current.tasks[0].done).toBe(true);
});
it('metadata-only selected change after display refuses the stale tick despite unchanged body hash',async()=>{
  const view=await mountTasks();const displayed=view.result.current.tasks[0];
  const changed={...currentVersion,metadataRevision:(BigInt(currentVersion.metadataRevision)+1n).toString(),metadataHash:'b'.repeat(64)};
  vi.mocked(ipc.readEditorBody).mockResolvedValue(snapshot(initial,changed));
  await act(async()=>view.result.current.toggle(displayed,true));
  expect(ipc.saveNoteBody).not.toHaveBeenCalled();expect(ipc.saveNote).not.toHaveBeenCalled();
  expect(useVaultStore.getState().rescan).toHaveBeenCalledOnce();expect(view.result.current.tasks[0].done).toBe(false);
});
it('metadata-only selected scan revision invalidates task snapshot reuse when body hash stays equal',async()=>{
  const view=await mountTasks();const firstCalls=vi.mocked(ipc.readEditorBody).mock.calls.length;
  expect(firstCalls).toBe(1);
  const changed={...currentVersion,metadataRevision:(BigInt(currentVersion.metadataRevision)+1n).toString(),metadataHash:'b'.repeat(64)};
  vi.mocked(ipc.readEditorBody).mockResolvedValue(snapshot(initial,changed));act(()=>useVaultStore.setState({entries:[entry(changed)]}));
  await waitFor(()=>expect(view.result.current.loading).toBe(false));
  expect(ipc.readEditorBody).toHaveBeenCalledTimes(2);expect(ipc.readNoteSource).not.toHaveBeenCalled();
});
it('same-path selected replacement cannot borrow the original task target',async()=>{
  const view=await mountTasks();const displayed=view.result.current.tasks[0];
  const replacement={...currentVersion,recordId:'72a79040-9bb3-4b2e-a0e6-bc2d4b536352'};
  vi.mocked(ipc.readEditorBody).mockResolvedValue({...snapshot(),target:{workspaceId:replacement.workspaceId,recordId:replacement.recordId},version:replacement});
  act(()=>useVaultStore.setState({entries:[entry(replacement)]}));await waitFor(()=>expect(view.result.current.loading).toBe(false));
  await act(async()=>view.result.current.toggle(displayed,true));
  expect(ipc.saveNoteBody).not.toHaveBeenCalled();expect(ipc.saveNote).not.toHaveBeenCalled();
});
it('lost selected tick acknowledgement retains original owner and resolves the same request without a fresh tick',async()=>{
  const view=await mountTasks();vi.mocked(ipc.saveNoteBody).mockRejectedValueOnce(new Error('transport closed after dispatch'));
  await act(async()=>view.result.current.toggle(view.result.current.tasks[0],true));
  expect(ipc.saveNoteBody).toHaveBeenCalledOnce();const first=vi.mocked(ipc.saveNoteBody).mock.calls[0][0];
  const owner=selectedOwner();expect(owner.snapshot().selectedSave?.status).toBe('unknown');
  expect(owner.snapshot().acknowledgedGeneration).toBe(0);view.unmount();
  await act(async()=>{await owner.retry();});
  expect(ipc.saveNoteBody).toHaveBeenCalledTimes(2);
  const second=vi.mocked(ipc.saveNoteBody).mock.calls[1][0];
  expect(second.body).toBe(first.body);expect(second.vault).toBe(vault);expect(second.editorRequest).toMatchObject({requestKey:first.editorRequest?.requestKey,phase:'resolve',expectedVersion:currentVersion});
  expect(owner.snapshot().selectedSave).toBeUndefined();expect(owner.snapshot().acknowledgedGeneration).toBe(1);
});
it('pending selected operation remains in the original owner after unmount and resolves once',async()=>{
  const view=await mountTasks();vi.mocked(ipc.saveNoteBody).mockImplementationOnce(async({body,editorRequest})=>{
    if(!editorRequest)throw new Error('missing selected request');return {kind:'selected_pending',operation:operation(editorRequest,body),error};
  });
  await act(async()=>view.result.current.toggle(view.result.current.tasks[0],true));
  expect(ipc.saveNoteBody).toHaveBeenCalledOnce();const first=vi.mocked(ipc.saveNoteBody).mock.calls[0][0];
  const owner=selectedOwner();expect(owner.snapshot().selectedSave?.status).toBe('pending');view.unmount();
  await act(async()=>{await owner.retry();});
  const second=vi.mocked(ipc.saveNoteBody).mock.calls[1][0];
  expect(second.editorRequest).toMatchObject({requestKey:first.editorRequest?.requestKey,phase:'resolve',original:expect.objectContaining({requestKey:first.editorRequest?.requestKey})});
  expect(second.body).toBe(first.body);expect(owner.snapshot().acknowledgedGeneration).toBe(1);
});
it('late selected tick completion after a vault switch settles only the original operation',async()=>{
  const view=await mountTasks();const ack=deferred<EditorSaveResult>();
  vi.mocked(ipc.saveNoteBody).mockImplementationOnce(()=>ack.promise);
  const {finished}=await startTick(view);const first=vi.mocked(ipc.saveNoteBody).mock.calls[0][0];
  const owner=selectedOwner();const originalVault=vault;
  act(()=>useVaultStore.setState({vaultPath:'/other',entriesVault:'/other',entries:[],rescan:vi.fn(async()=>{})}));
  await act(async()=>{if(!first.editorRequest)throw new Error('missing selected request');ack.resolve(applied(first.editorRequest,first.body));await finished;});
  expect(owner.key.vaultId).toBe(originalVault);expect(owner.snapshot().acknowledgedGeneration).toBe(1);
  expect(view.result.current.tasks).toEqual([]);expect(useVaultStore.getState().rescan).not.toHaveBeenCalled();expect(ipc.saveNoteBody).toHaveBeenCalledOnce();
});
it('selected applied tick remains acknowledged when the following refresh fails',async()=>{
  useVaultStore.setState({rescan:vi.fn(async()=>{throw new Error('scan refused');})});
  const view=await mountTasks();await act(async()=>view.result.current.toggle(view.result.current.tasks[0],true));
  expect(ipc.saveNoteBody).toHaveBeenCalledOnce();expect(view.result.current.tasks[0].done).toBe(true);
  expect(useUiStore.getState().toast).toHaveBeenCalledWith("Task saved, but the list couldn't refresh.");
  expect(unresolvedDocumentOwners()).toEqual([]);
});
it('an already held page blocks the selected dependent tick',async()=>{
  const owner=new DocumentOwner({vaultId:vault,path,ownerId:'actual-open-page'},initial,async()=>{throw new Error('unresolved open draft');},target);
  owner.edit(initial+'Exact unsaved paragraph.','source');
  registerSaveParticipant({key:owner.key,prepare:()=>{},snapshot:()=>owner.snapshot(),flush:()=>owner.flush()});
  const view=await mountTasks();await act(async()=>view.result.current.toggle(view.result.current.tasks[0],true));
  expect(ipc.saveNoteBody).not.toHaveBeenCalled();expect(ipc.saveNote).not.toHaveBeenCalled();expect(owner.snapshot().latestDraft).toContain('Exact unsaved paragraph.');
});
it('browser selected journal support stays visibly unavailable instead of borrowing the legacy writer',async()=>{
  vi.mocked(ipc.supportsSelectedEditor).mockReturnValue(false);vi.mocked(ipc.readEditorBody).mockRejectedValue({code:'capability_unavailable',kind:'unsupported_operation',message:'Selected browser editor unavailable.',retryable:false});
  const {result}=renderHook(useDocTasks);await waitFor(()=>expect(result.current.loading).toBe(false));
  expect(result.current.tasks).toEqual([]);expect(result.current.unreadable).toEqual([path]);expect(ipc.saveNote).not.toHaveBeenCalled();expect(ipc.saveNoteBody).not.toHaveBeenCalled();
});


it.each(['stale_metadata','source_changed'] as const)(
  'definite native %s after fresh read refreshes the tick and cannot be silently replayed by a later barrier',
  async(kind)=>{
    const view=await mountTasks();
    vi.mocked(ipc.saveNoteBody).mockRejectedValueOnce({kind:'selected_refused',error:{code:'capability_unavailable',kind,message:'The original task snapshot changed before locked admission.',retryable:true}});
    await act(async()=>view.result.current.toggle(view.result.current.tasks[0],true));
    expect(ipc.saveNoteBody).toHaveBeenCalledOnce();expect(ipc.saveNote).not.toHaveBeenCalled();
    expect(view.result.current.tasks[0].done).toBe(false);
    expect(useVaultStore.getState().rescan).toHaveBeenCalledOnce();
    await act(async()=>{await flushOpenPages();});
    expect(ipc.saveNoteBody).toHaveBeenCalledOnce();
    expect(unresolvedDocumentOwners()).toEqual([]);
  },
);


it.each([
  {label:'governed writer refusal',failure:{kind:'selected_refused',error:{code:'capability_unavailable',kind:'unsupported_operation',message:'This page belongs to its governed writer.',retryable:false}},words:'This page belongs to its governed writer.'},
  {label:'recovery-copy refusal',failure:new Error('recovery_required:fixture_private_nonce'),words:'The task was not saved because its recovery copy could not be stored. Open the page to review recovery options.'},
])('reports finite $label before retiring the definitely refused generated tick',async({failure,words})=>{
  const view=await mountTasks();vi.mocked(ipc.saveNoteBody).mockRejectedValueOnce(failure);
  await act(async()=>view.result.current.toggle(view.result.current.tasks[0],true));
  expect(ipc.saveNoteBody).toHaveBeenCalledOnce();expect(ipc.saveNote).not.toHaveBeenCalled();
  expect(useUiStore.getState().toast).toHaveBeenCalledWith(expect.stringContaining(words));
  expect(useUiStore.getState().toast).not.toHaveBeenCalledWith(expect.stringContaining('fixture_private_nonce'));
  expect(view.result.current.tasks[0].done).toBe(false);expect(useVaultStore.getState().rescan).toHaveBeenCalledOnce();
  await act(async()=>{await flushOpenPages();});expect(ipc.saveNoteBody).toHaveBeenCalledOnce();expect(unresolvedDocumentOwners()).toEqual([]);
});
