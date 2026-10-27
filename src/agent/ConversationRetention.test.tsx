import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConversationRetention } from './ConversationRetention';
import type { ArchiveService } from './conversationArchive';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { saveConversations, loadConversations } from './conversations';
import { archiveConversation } from './conversationArchive';
import type { ArchiveMessage, ArchiveThread } from '@/lib/generated/conversations';
vi.mock('@/app/useOpenPath',()=>({useOpenPath:()=>vi.fn()}));
const context={vaultId:'selected-vault',storeUuid:'original-store'};
const thread:ArchiveThread={id:'history',title:'Retained discussion',createdAt:'2026-10-26T12:00:00Z',updatedAt:'2026-10-26T12:00:00Z',titleExpiresAt:null,parentThreadId:null,branchMessageId:null,sessionId:null,contentState:'retained'};
const message:ArchiveMessage={attemptId:'original',userMessageId:'question',assistantMessageId:'answer',origin:'native_run',importedAt:null,runId:'run',sessionId:null,completedAt:'2026-10-26T12:00:00Z',expiresAt:null,contentState:'retained',persistence:'retained',content:{version:1,displayMessage:{text:'Visible question',addressedLabel:null,attachmentRefs:[]},completionStatus:'completed',answer:{version:1,availability:'complete',references:[],blocks:[{kind:'text',messageId:'text',text:'Visible answer'}]}}};
function service(){return {
  context:vi.fn<ArchiveService['context']>().mockResolvedValue(context),
  import:vi.fn<ArchiveService['import']>().mockResolvedValue({context,items:[],confirmed:[]}),
  setting:vi.fn<ArchiveService['setting']>().mockResolvedValue({context,choice:'off',revision:0,logicalBytes:0,budgetBytes:268435456}),
  choose:vi.fn<ArchiveService['choose']>().mockImplementation(async(_,choice,revision)=>({context,choice,revision:revision+1,logicalBytes:0,budgetBytes:268435456})),
  threads:vi.fn<ArchiveService['threads']>().mockResolvedValue({context,items:[thread],nextCursor:null}),
  messages:vi.fn<ArchiveService['messages']>().mockResolvedValue({context,threadId:thread.id,items:[message],nextCursor:null}),
  remove:vi.fn<ArchiveService['remove']>().mockResolvedValue({state:'blocked_active',owners:['original-run']}),
  prune:vi.fn<ArchiveService['prune']>().mockResolvedValue({context,removedMessages:1,removedSearchRows:1,logicalBytesReleased:4,cleanup:'deferred',safeReason:'Logical deletion finished; SQLite cleanup is waiting for readers.'}),
  export:vi.fn<ArchiveService['export']>().mockResolvedValue({state:'cancelled'}),
};}
beforeEach(()=>{window.localStorage.clear();useVaultStore.setState({vaultPath:'/archive-ui-vault',entries:[]});useUiStore.setState({panelConversation:null});});
afterEach(()=>{cleanup();vi.clearAllMocks();vi.useRealTimers();});
it('opens Off without enabling retention and saves only an explicit duration choice',async()=>{
  const api=service();render(<ConversationRetention active service={api}/>);await screen.findByText('Retained discussion');expect(api.choose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Conversation retention'}));fireEvent.click(await screen.findByRole('option',{name:'90 days (recommended)'}));
  await waitFor(()=>expect(api.choose).toHaveBeenCalledExactlyOnceWith(context,'days90',0));expect(await screen.findByText(/Retention choice saved/)).toBeTruthy();
});
it('uses the existing transcript view and keeps blocked deletion and cancelled export separate from work',async()=>{
  const api=service();render(<ConversationRetention active service={api}/>);fireEvent.click(await screen.findByRole('button',{name:/Retained discussion/}));
  expect(await screen.findByText('Visible question')).toBeTruthy();expect(await screen.findByText('Visible answer')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Delete archived conversation'}));expect(await screen.findByText(/still has work or an approval/)).toBeTruthy();expect(screen.getByText('Visible answer')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Export JSON'}));expect(await screen.findByText('Export cancelled.')).toBeTruthy();expect(api.export).toHaveBeenCalledExactlyOnceWith(context,'history','json');
  fireEvent.click(screen.getByRole('button',{name:'Open in assistant'}));expect(useUiStore.getState().panelConversation).toBe('history');
});
it('removes the matching browser copy only after committed native deletion',async()=>{
  const api=service();api.remove.mockResolvedValue({state:'deleted',cleanup:'deferred'});saveConversations([archiveConversation(thread,'/archive-ui-vault')]);
  render(<ConversationRetention active service={api}/>);fireEvent.click(await screen.findByRole('button',{name:/Retained discussion/}));await screen.findByText('Visible answer');fireEvent.click(screen.getByRole('button',{name:'Delete archived conversation'}));
  expect(await screen.findByText('Archived content deleted. Storage cleanup is deferred.')).toBeTruthy();expect(loadConversations()).toEqual([]);
});
it('distinguishes failed reads from empty and rejects a late response after another vault opens',async()=>{
  const api=service();api.threads.mockRejectedValueOnce({code:'unavailable',message:'Archive read failed.'});const view=render(<ConversationRetention active service={api}/>);
  expect((await screen.findByTestId('section-unavailable')).textContent).toContain('Archive read failed.');expect(screen.queryByText('No conversations are recorded in this archive.')).toBeNull();view.unmount();
  let finish!:(value:Awaited<ReturnType<ArchiveService['threads']>>)=>void;api.threads.mockImplementationOnce(()=>new Promise((resolve)=>{finish=resolve;}));render(<ConversationRetention active service={api}/>);await waitFor(()=>expect(finish).toBeTypeOf('function'));
  act(()=>useVaultStore.setState({vaultPath:'/another-vault'}));await screen.findByText('Retained discussion');
  await act(async()=>finish({context,items:[{...thread,title:'Stale first vault'}],nextCursor:null}));expect(screen.queryByText('Stale first vault')).toBeNull();
});
it('shows missing metadata and partial content as distinct from an empty archive',async()=>{
  const api=service();api.threads.mockResolvedValue({context,items:[{...thread,title:null,contentState:'metadata_only'}],nextCursor:null});api.messages.mockResolvedValue({context,threadId:'history',items:[{...message,content:null,persistence:'unavailable',contentState:'metadata_only'}],nextCursor:null});
  render(<ConversationRetention active service={api}/>);fireEvent.click(await screen.findByRole('button',{name:/Conversation Metadata only/}));
  expect(await screen.findByText('Archived content is unavailable.')).toBeTruthy();expect(screen.getByText(/Some archived content is expired/)).toBeTruthy();
});

it.each(['deferred','failed'] as const)('hides body, source, artifact and effect at expiry while an older-message reread is %s',async(outcome)=>{
 vi.useFakeTimers();const now=Date.parse('2026-10-27T12:00:00Z');vi.setSystemTime(now);
 const api=service();const expiring={...message,expiresAt:new Date(now+60_000).toISOString(),content:{...message.content!,answer:{...message.content!.answer,blocks:[{kind:'tool' as const,toolId:'fetch',name:'WebFetch',state:'completed'},{kind:'text' as const,messageId:'text',text:'Visible answer [source](https://source.example/)'}],references:[{kind:'source' as const,toolId:'fetch',url:'https://source.example/'},{kind:'artifact' as const,path:'notes/result.md'},{kind:'effect' as const,invocationId:'e'.repeat(32)}]}}};
 api.messages.mockResolvedValueOnce({context,threadId:thread.id,items:[expiring],nextCursor:'older'});
 let resolve!:(value:Awaited<ReturnType<ArchiveService['messages']>>)=>void;let reject!:(error:unknown)=>void;api.messages.mockImplementationOnce(()=>new Promise((yes,no)=>{resolve=yes;reject=no;}));
 render(<ConversationRetention active service={api}/>);await act(async()=>{await Promise.resolve();});
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:/Retained discussion/}));});
 expect(screen.getByText(/Visible answer/)).toBeTruthy();expect(screen.getByRole('button',{name:'Artifact: notes/result.md'})).toBeTruthy();expect(document.querySelector('a[href="https://source.example/"]')).not.toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Older messages'}));expect(resolve).toBeTypeOf('function');
 await act(async()=>{vi.advanceTimersByTime(60_000);});
 expect(screen.queryByText(/Visible answer/)).toBeNull();expect(screen.queryByRole('button',{name:'Artifact: notes/result.md'})).toBeNull();expect(document.querySelector('a[href="https://source.example/"]')).toBeNull();expect(screen.queryByText('Effect reference: '+ 'e'.repeat(32))).toBeNull();
 await act(async()=>{if(outcome==='failed')reject({message:'Older read unavailable.'});else resolve({context,threadId:thread.id,items:[{...expiring,attemptId:'older-copy',userMessageId:'older-question',assistantMessageId:'older-answer'}],nextCursor:null});});
 expect(screen.queryByText(/Visible answer/)).toBeNull();expect(screen.queryByRole('button',{name:'Artifact: notes/result.md'})).toBeNull();expect(document.querySelector('a[href="https://source.example/"]')).toBeNull();
});

it('requires an explicit import click and keeps unknown-vault cache while clearing only checked selected turns',async()=>{
 const cached=(id:string,where:string|undefined)=>({id,title:'Cached title',usesDefaultTitle:true,sessionId:null,createdAt:'2026-01-01T00:00:00Z',archived:false,...(where===undefined?{}:{vault:where}),messages:[{id:id+'-u',role:'user',text:'Cached question',tools:[]},{id:id+'-a',role:'assistant',text:'Cached answer',tools:[]}]});
 const unknown=cached('unknown',undefined);window.localStorage.setItem('cerebro.conversations',JSON.stringify([cached('selected','/archive-ui-vault'),unknown]));
 const api=service();api.setting.mockResolvedValue({context,choice:'forever',revision:1,logicalBytes:0,budgetBytes:268435456});api.import.mockImplementation(async(_,batch)=>({context,items:batch.attempts.map((item)=>({state:'retained' as const,attemptId:'imported',userMessageId:item.userMessageId,assistantMessageId:item.assistantMessageId})),confirmed:batch.attempts.map((item)=>({threadId:batch.threadId,attemptId:'imported',userMessageId:item.userMessageId,assistantMessageId:item.assistantMessageId,expiresAt:null,importedAt:'2026-10-27T12:00:00Z'}))}));
 render(<ConversationRetention active service={api}/>);await screen.findByText('Retained discussion');expect(api.import).not.toHaveBeenCalled();expect(screen.getByText(/Conversations without a recorded vault/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Import this vault’s recent conversations'}));expect(await screen.findByText(/Imported 1 cached turn; cleared 1 checked copy/)).toBeTruthy();const records=JSON.parse(window.localStorage.getItem('cerebro.conversations')!);expect(records[0].messages.every((item:{text:string})=>item.text==='')).toBe(true);expect(records[1]).toEqual(unknown);
});

it('labels imported completion as not recorded rather than a successful run',async()=>{
 const api=service();api.messages.mockResolvedValue({context,threadId:thread.id,items:[{...message,origin:'browser_cache',runId:null,completedAt:null,importedAt:'2026-10-27T12:00:00Z',content:{...message.content!,completionStatus:'not_recorded',answer:{...message.content!.answer,availability:'partial'}}}],nextCursor:null});
 render(<ConversationRetention active service={api}/>);fireEvent.click(await screen.findByRole('button',{name:/Retained discussion/}));expect(await screen.findByText('Visible answer')).toBeTruthy();expect(screen.getAllByText(/Completion time not recorded/).length).toBeGreaterThan(0);expect(screen.queryByText(/Succeeded|Completed successfully/)).toBeNull();
});

it('shows an unreadable recent-history source without presenting it as measured empty cache',async()=>{
 const get=window.localStorage.getItem;const spy=vi.spyOn(window.localStorage,'getItem').mockImplementation(function(this:Storage,name:string){if(name==='cerebro.conversations')throw new Error('cache unreadable');return get.call(this,name);});
 try {const api=service();render(<ConversationRetention active service={api}/>);await screen.findByText('Retained discussion');expect(spy).toHaveBeenCalledWith('cerebro.conversations');expect(screen.getByText('Some recent history could not be read.')).toBeTruthy();expect(screen.queryByText('0 cached turns available')).toBeNull();expect(api.import).not.toHaveBeenCalled();}finally{spy.mockRestore();}
});
