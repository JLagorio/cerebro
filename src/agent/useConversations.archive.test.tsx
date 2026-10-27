import { act,cleanup,renderHook,waitFor } from '@testing-library/react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
vi.mock('./agentIpc',async(original)=>({...(await original<typeof import('./agentIpc')>()),archiveContext:vi.fn(),archiveThreads:vi.fn(),archiveMessages:vi.fn(),deleteArchivedThread:vi.fn(),readCliTranscript:vi.fn(),stopAgent:vi.fn(),cancelInteraction:vi.fn()}));
import * as ipc from './agentIpc';
import { useConversations } from './useConversations';
import { archiveConversation } from './conversationArchive';
import { loadConversations,saveConversations } from './conversations';
import type { AgentChat } from './useAgentChat';
import type { ChatMessage } from './types';
import type { ArchiveMessage,ArchiveThread } from '@/lib/generated/conversations';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
const vault='/archive-hook-vault';const context={vaultId:'selected-vault',storeUuid:'original-store'};
const thread:ArchiveThread={id:'history',title:'Stored discussion',createdAt:'2026-10-26T12:00:00Z',updatedAt:'2026-10-26T12:00:00Z',titleExpiresAt:null,parentThreadId:null,branchMessageId:null,sessionId:'11111111-1111-4111-8111-111111111111',contentState:'retained'};
const record:ArchiveMessage={attemptId:'original',userMessageId:'question',assistantMessageId:'answer',origin:'native_run',importedAt:null,runId:'run',sessionId:null,completedAt:'2026-10-26T12:00:00Z',expiresAt:null,contentState:'retained',persistence:'retained',content:{version:1,displayMessage:{text:'Question from native',addressedLabel:null,attachmentRefs:[]},completionStatus:'completed',answer:{version:1,availability:'complete',references:[],blocks:[{kind:'text',messageId:'text',text:'Retained native answer'}]}}};
const none:ChatMessage[]=[];
function chat(over:Partial<AgentChat>={}):AgentChat{return {messages:none,streaming:false,interaction:null,waiting:false,answer:vi.fn(),send:vi.fn(),stop:vi.fn(),stopping:false,busy:()=>false,reset:vi.fn(),sessionId:null,model:null,prLinks:[],turnEndedAt:null,live:null,restore:vi.fn(),...over};}
beforeEach(()=>{
  window.localStorage.clear();vi.clearAllMocks();useVaultStore.setState({vaultPath:vault});useUiStore.setState({panelConversation:null});
  vi.mocked(ipc.archiveContext).mockResolvedValue(context);vi.mocked(ipc.archiveThreads).mockResolvedValue({context,items:[thread],nextCursor:null});vi.mocked(ipc.archiveMessages).mockResolvedValue({context,threadId:thread.id,items:[record],nextCursor:null});vi.mocked(ipc.deleteArchivedThread).mockResolvedValue({state:'blocked_active',owners:['original-run']});vi.mocked(ipc.readCliTranscript).mockResolvedValue({state:'unavailable',reason:'cleared',retention_days:30});
});
afterEach(()=>{cleanup();vi.useRealTimers();});
it('reopens native retained content after CLI clearing and blocks resume without resending',async()=>{
  saveConversations([archiveConversation(thread,vault)]);const held=chat();const {result}=renderHook(()=>useConversations(held,undefined,undefined,vault));
  await waitFor(()=>expect(held.restore).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({id:'answer',text:'Retained native answer'})]),thread.sessionId));
  await waitFor(()=>expect(result.current.blocked).toBe('cleared'));expect(held.send).not.toHaveBeenCalled();expect(loadConversations()[0].messages.every((message)=>message.text==='')).toBe(true);
});
it('loads a requested archive ID that was never present in browser storage',async()=>{
  useUiStore.getState().showConversation(thread.id);const held=chat();const {result}=renderHook(()=>useConversations(held,undefined,undefined,vault));
  await waitFor(()=>expect(result.current.activeId).toBe(thread.id));expect(held.send).not.toHaveBeenCalled();expect(held.reset).not.toHaveBeenCalled();
});
it('refuses native-bound deletion with active work without Stop or approval cancellation',async()=>{
  const source={...archiveConversation(thread,vault),messages:[{id:'answer',role:'assistant' as const,text:'Visible',tools:[],generationRequestKey:'a'.repeat(32)}]};saveConversations([source]);
  const held=chat();const {result}=renderHook(()=>useConversations(held,undefined,undefined,vault));
  act(()=>result.current.remove(thread.id));await waitFor(()=>expect(ipc.deleteArchivedThread).toHaveBeenCalledWith(context,thread.id));expect(ipc.stopAgent).not.toHaveBeenCalled();expect(ipc.cancelInteraction).not.toHaveBeenCalled();expect(result.current.conversations.some((item)=>item.id===thread.id)).toBe(true);
});
it('committed native deletion removes the known local copy and no work-control call',async()=>{
  vi.mocked(ipc.deleteArchivedThread).mockImplementation(async()=>{vi.mocked(ipc.archiveThreads).mockResolvedValue({context,items:[],nextCursor:null});return {state:'deleted',cleanup:'deferred'};});saveConversations([archiveConversation(thread,vault)]);const held=chat();const {result}=renderHook(()=>useConversations(held,undefined,undefined,vault));
  act(()=>result.current.remove(thread.id));await waitFor(()=>expect(result.current.conversations.some((item)=>item.id===thread.id)).toBe(false));expect(loadConversations().some((item)=>item.id===thread.id)).toBe(false);expect(ipc.stopAgent).not.toHaveBeenCalled();expect(ipc.cancelInteraction).not.toHaveBeenCalled();
});
it('ignores an archive body arriving after the user starts a different conversation',async()=>{
  let finish!:(value:Awaited<ReturnType<typeof ipc.archiveMessages>>)=>void;
  vi.mocked(ipc.archiveMessages).mockImplementation(()=>new Promise((resolve)=>{finish=resolve;}));saveConversations([archiveConversation(thread,vault)]);const held=chat();const {result}=renderHook(()=>useConversations(held,undefined,undefined,vault));
  await waitFor(()=>expect(finish).toBeTypeOf('function'));act(()=>result.current.start());const next=result.current.activeId;held.restore=vi.fn();
  await act(async()=>finish({context,threadId:thread.id,items:[record],nextCursor:null}));expect(result.current.activeId).toBe(next);expect(held.restore).not.toHaveBeenCalled();
});
it('retains verified branch ancestry separately from the CLI fork capability',()=>{
  const anchor={sessionId:thread.sessionId!,uuid:'22222222-2222-4222-8222-222222222222'};
  const messages:ChatMessage[]=[{id:'answer',role:'assistant',text:'Answer',tools:[],anchor}];saveConversations([{...archiveConversation(thread,vault),messages}]);const held=chat({messages});const {result}=renderHook(()=>useConversations(held,undefined,undefined,vault));
  let branch:string|null=null;act(()=>{branch=result.current.branchFrom(thread.id,'answer');});const created=result.current.conversations.find((item)=>item.id===branch);
  expect(created?.archiveAncestry).toEqual({parentThreadId:thread.id,branchMessageId:'answer'});expect(created?.fork).toEqual({from:anchor.sessionId,at:anchor.uuid});
});

it('checks the current native-keyed reply before the cached mirror when Delete races a send',async()=>{
  const stale={...archiveConversation(thread,vault),archiveBacked:undefined,messages:[]};saveConversations([stale]);
  vi.mocked(ipc.archiveThreads).mockResolvedValue({context,items:[],nextCursor:null});
  const liveMessage={id:'new-native-answer',role:'assistant' as const,text:'',tools:[],generationRequestKey:'b'.repeat(32),streaming:true};
  const held=chat({messages:[liveMessage],streaming:true,live:null});const {result}=renderHook(()=>useConversations(held,undefined,undefined,vault));
  act(()=>result.current.remove(thread.id));expect(ipc.deleteArchivedThread).not.toHaveBeenCalled();expect(result.current.conversations.some((item)=>item.id===thread.id)).toBe(true);expect(ipc.stopAgent).not.toHaveBeenCalled();expect(ipc.cancelInteraction).not.toHaveBeenCalled();
});
it('metadata discovery preserves a preexisting explicit custom title and browser rename survives save',async()=>{
  const named={...archiveConversation(thread,vault),archiveTitle:undefined,title:'My custom name',usesDefaultTitle:false};saveConversations([named]);const held=chat();const {result}=renderHook(()=>useConversations(held,undefined,undefined,vault));
  await waitFor(()=>expect(ipc.archiveThreads).toHaveBeenCalled());expect(result.current.conversations.find((item)=>item.id===thread.id)?.title).toBe('My custom name');
  act(()=>result.current.rename(thread.id,'Renamed again'));expect(loadConversations().find((item)=>item.id===thread.id)?.title).toBe('Renamed again');
});

it('does not restore captured retained content after expiry while a CLI heal is deferred',async()=>{
 const expires=Date.now()+60_000;const timed={...record,expiresAt:new Date(expires).toISOString()};
 vi.mocked(ipc.archiveMessages).mockResolvedValue({context,threadId:thread.id,items:[timed],nextCursor:null});
 let finish!:(value:Awaited<ReturnType<typeof ipc.readCliTranscript>>)=>void;vi.mocked(ipc.readCliTranscript).mockImplementation(()=>new Promise((resolve)=>{finish=resolve;}));
 saveConversations([archiveConversation(thread,vault)]);const held=chat();const {result}=renderHook(()=>useConversations(held,undefined,undefined,vault));
 await waitFor(()=>expect(finish).toBeTypeOf('function'));expect(held.restore).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({text:'Retained native answer'})]),thread.sessionId);
 vi.useFakeTimers();vi.setSystemTime(expires+1);
 await act(async()=>finish({state:'read',events:[{kind:'UserPrompt',text:'Question from native'},{kind:'Text',message_id:'cli',text:'PRIVATE CLI ANSWER'},{kind:'TurnEnded'}],lines:3,unclassified:[]}));
 const restored=vi.mocked(held.restore).mock.calls.at(-1)![0];expect(JSON.stringify(restored)).not.toContain('Retained native answer');expect(JSON.stringify(restored)).not.toContain('PRIVATE CLI ANSWER');expect(restored.every((message)=>message.archiveRecord?.persistence==='expired')).toBe(true);expect(result.current.transcript).toMatchObject({state:'unavailable',reason:'archive_partial'});
});

it('does not resurrect a deleted background conversation from a pre-delete metadata snapshot',async()=>{
 let finish!:(value:Awaited<ReturnType<typeof ipc.archiveThreads>>)=>void;
 vi.mocked(ipc.archiveThreads).mockResolvedValue({context,items:[],nextCursor:null}).mockImplementationOnce(()=>new Promise((resolve)=>{finish=resolve;}));
 vi.mocked(ipc.deleteArchivedThread).mockResolvedValue({state:'deleted',cleanup:'completed'});
 const current={id:'current',title:'Current',usesDefaultTitle:true,sessionId:null,messages:[],createdAt:thread.createdAt,archived:false,vault};saveConversations([current,archiveConversation(thread,vault)]);
 const held=chat();const {result}=renderHook(()=>useConversations(held,undefined,undefined,vault));await waitFor(()=>expect(finish).toBeTypeOf('function'));expect(result.current.activeId).toBe('current');
 act(()=>result.current.remove(thread.id));await waitFor(()=>expect(result.current.conversations.some((item)=>item.id===thread.id)).toBe(false));
 await act(async()=>finish({context,items:[thread],nextCursor:null}));expect(result.current.conversations.some((item)=>item.id===thread.id)).toBe(false);expect(result.current.activeId).toBe('current');expect(ipc.stopAgent).not.toHaveBeenCalled();
});
