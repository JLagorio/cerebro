import { ConversationRetention } from '@/agent/ConversationRetention';
import type { ArchiveService } from '@/agent/conversationArchive';
import type { ArchiveMessage, ArchiveThread, RetentionChoice } from '@/lib/generated/conversations';
import { faulted } from '@/lib/mockFaults';
import type { LabSection, LabState } from '../presets';
const context={vaultId:'lab-vault',storeUuid:'lab-store'};
let state:LabState='ready';
let choice:RetentionChoice='off';let revision=0;let copied:ArchiveMessage|null=null;
const copiedThread:ArchiveThread={id:'lab-import-thread',title:'Imported fixture discussion',createdAt:'2026-07-20T12:00:00Z',updatedAt:'2026-07-28T12:00:00Z',titleExpiresAt:null,parentThreadId:null,branchMessageId:null,sessionId:null,contentState:'retained'};
const reset=(next:LabState)=>{state=next;choice='off';revision=0;copied=null;};
const thread:ArchiveThread={id:'lab-thread',title:'Retained discussion',createdAt:'2026-10-26T12:00:00Z',updatedAt:'2026-10-26T12:00:00Z',titleExpiresAt:null,parentThreadId:null,branchMessageId:null,sessionId:null,contentState:'retained'};
const service:ArchiveService={
  // The lab never seeds browser history or admits ordinary cache IDs. Only
  // the browser spec's isolated fixture namespace has simulated readback.
  import:async(_,batch)=>{
    if(batch.sourceVaultPath!=='/demo-vault'||batch.threadId!==copiedThread.id||choice!=='forever')return {context,items:batch.attempts.map((attempt)=>({state:'skipped',userMessageId:attempt.userMessageId,assistantMessageId:attempt.assistantMessageId,reason:'unavailable'})),confirmed:[]};
    const accepted=batch.attempts.find((attempt)=>attempt.userMessageId==='lab-import-user'&&attempt.assistantMessageId==='lab-import-answer');
    if(accepted!==undefined)copied={attemptId:'lab-copied-attempt',userMessageId:accepted.userMessageId,assistantMessageId:accepted.assistantMessageId,origin:'browser_cache',runId:null,sessionId:null,completedAt:null,importedAt:'2026-07-28T12:00:00Z',expiresAt:null,contentState:'retained',persistence:'retained',content:{version:1,displayMessage:accepted.displayMessage,answer:accepted.answer,completionStatus:'not_recorded'}};
    return {context,items:batch.attempts.map((attempt)=>attempt===accepted?{state:'retained',attemptId:'lab-copied-attempt',userMessageId:attempt.userMessageId,assistantMessageId:attempt.assistantMessageId}:{state:'skipped',userMessageId:attempt.userMessageId,assistantMessageId:attempt.assistantMessageId,reason:'conflict'}),confirmed:accepted===undefined||copied===null?[]:[{threadId:copiedThread.id,attemptId:copied.attemptId,userMessageId:copied.userMessageId,assistantMessageId:copied.assistantMessageId,expiresAt:copied.expiresAt,importedAt:copied.importedAt!}]};
  },
  context:()=>faulted('conversation_context',async()=>context).catch(()=>Promise.reject({message:'Conversation archive is unavailable.'})),
  setting:async()=>({context,choice,revision,logicalBytes:copied===null?0:1024,budgetBytes:268435456}),
  choose:async(_,selected,expected)=>{choice=selected;revision=expected+1;return {context,choice,revision,logicalBytes:0,budgetBytes:268435456};},
  threads:async()=>({context,items:state==='empty'?[]:[...(copied===null?[]:[copiedThread]),state==='not-recorded'?{...thread,title:null,contentState:'metadata_only'}:state==='partial'?{...thread,title:null,contentState:'expired'}:thread],nextCursor:null}),
  messages:async(_,selected)=>({context,threadId:selected,items:selected===copiedThread.id&&copied!==null?[copied]:[],nextCursor:null}),
  remove:async()=>({state:'blocked_active',owners:['lab-owner']}),prune:async()=>({context,removedMessages:0,removedSearchRows:0,logicalBytesReleased:0,cleanup:'deferred',safeReason:'Fixture cleanup deferred.'}),export:async()=>({state:'cancelled'}),
};
export const section:LabSection={id:'conversation-archive',title:'Conversation archive',surface:'Settings › Assistant › Conversation archive',render:()=> <ConversationRetention active service={service}/>,states:{
  ready:{note:'Native-shaped retained metadata fixture. Off stays Off until explicit choice.',seed:()=>reset('ready'),expect:{present:['[data-testid="conversation-archive"]'],text:'Retained discussion'}},
  empty:{note:'Successful read found no archived conversations.',seed:()=>reset('empty'),expect:{present:[],text:'No conversations are recorded in this archive.'}},
  'not-recorded':{note:'Conversation identity exists but no source title/content was recorded.',seed:()=>reset('not-recorded'),expect:{present:[],text:'Metadata only'}},
  partial:{note:'Metadata survives but the original content expired; no zero/empty replacement.',seed:()=>reset('partial'),expect:{present:[],text:'Content expired'}},
  unavailable:{note:'Actual component receives a failed scoped read rather than an empty archive.',seed:()=>reset('unavailable'),failNext:['conversation_context'],expect:{present:['[data-testid="section-unavailable"]'],text:'Conversation archive is unavailable.'}},
}};
