import type { ArchiveContext,Block,ImportBatch,LegacyAttempt } from '@/lib/generated/conversations';
import type { ChatMessage,Conversation } from './types';
import type { ArchiveService } from './conversationArchive';
import { sameArchiveContext } from './conversationArchive';
import { clearImportedCacheBodies,readCacheForImport } from './conversations';

interface FrozenPair {attempt:LegacyAttempt;fingerprint:string;rawFingerprint:string}
interface FrozenThread {id:string;pairs:FrozenPair[]}
export interface CacheImportSnapshot {threads:FrozenThread[];unknown:number;unreadable:number;pending:number;turns:number}
function pair(thread:Conversation,user:ChatMessage,assistant:ChatMessage):LegacyAttempt|null {
 if(user.role!=='user'||assistant.role!=='assistant'||user.text.trim()===''||assistant.streaming===true||thread.live!=null)return null;
 if([user,assistant].some((message)=>message.archiveRecord?.persistence==='retained'||message.archiveRecord?.persistence==='expired'))return null;
 if(assistant.tools.some((tool)=>tool.deferred===true&&tool.done!==true&&tool.cancelled!==true))return null;
 const blocks:Block[]=[];const emitted=new Set<string>();const tools=new Map(assistant.tools.filter((tool)=>tool.parent===undefined).map((tool)=>[tool.id,tool]));
 const addTool=(id:string)=>{const tool=tools.get(id);if(tool===undefined||emitted.has(id))return;emitted.add(id);blocks.push({kind:'tool',toolId:tool.id,name:tool.name,state:typeof tool.denied==='string'?'denied':tool.deferred===true||tool.cancelled===true?'deferred':tool.done?tool.failed?'failed':'completed':'running'});if(typeof tool.subagent?.summary==='string')blocks.push({kind:'child',toolId:tool.id,summary:tool.subagent.summary});};
 if(assistant.parts!==undefined){for(const part of assistant.parts){if(part.kind==='text'&&part.text!=='')blocks.push({kind:'text',messageId:part.id,text:part.text});else if(part.kind==='tool')addTool(part.toolId);}}
 for(const tool of tools.values())addTool(tool.id);
 const last=blocks.filter((block)=>block.kind==='text').at(-1);if(assistant.text!==''&&(last===undefined||last.text!==assistant.text))blocks.push({kind:'text',messageId:assistant.id,text:assistant.text});
 if(blocks.length===0)return null;
 return {userMessageId:user.id,assistantMessageId:assistant.id,displayMessage:{text:user.text,addressedLabel:user.addressed?.title??null,attachmentRefs:[...(user.archiveAttachmentRefs??[])]},answer:{version:1,availability:'partial',blocks,references:[],...(assistant.anchor===undefined?{}:{lastUuid:assistant.anchor.uuid})},completedAt:null,sessionId:assistant.anchor?.sessionId??null};
}
export function snapshotLegacyCache(vault:string):CacheImportSnapshot {
 const read=readCacheForImport();let unknown=0;let pending=0;let unreadable=read.unreadable;const threads:FrozenThread[]=[];
 for(const thread of read.records){if(thread.vault===undefined){unknown+=1;continue;}if(thread.vault!==vault)continue;if(thread.live!=null){pending+=1;continue;}const pairs:FrozenPair[]=[];const counts=new Map<string,number>();for(const message of thread.messages)counts.set(message.id,(counts.get(message.id)??0)+1);
  for(let index=0;index<thread.messages.length-1;index+=1){const user=thread.messages[index],assistant=thread.messages[index+1];if(user.role!=='user'||assistant.role!=='assistant')continue;if(counts.get(user.id)!==1||counts.get(assistant.id)!==1){unreadable+=1;continue;}const attempt=pair(thread,user,assistant);if(attempt!==null){const rawFingerprint=read.fingerprint(vault,thread.id,user.id,assistant.id);if(rawFingerprint===null){unreadable+=1;continue;}pairs.push({attempt,fingerprint:JSON.stringify(attempt),rawFingerprint});}}
  if(pairs.length>0)threads.push({id:thread.id,pairs});
 }
 return {threads,unknown,unreadable,pending,turns:threads.reduce((sum,thread)=>sum+thread.pairs.length,0)};
}
function matches(thread:Conversation,frozen:FrozenPair):boolean {
 const at=thread.messages.findIndex((message)=>message.id===frozen.attempt.userMessageId);if(at===-1||thread.messages[at+1]?.id!==frozen.attempt.assistantMessageId)return false;
 const current=pair(thread,thread.messages[at],thread.messages[at+1]);return current!==null&&JSON.stringify(current)===frozen.fingerprint;
}
export interface CacheImportOutcome {saved:number;cleared:number;kept:number;unknown:number;unknownCompletion:number;blocked:number;interrupted:boolean}
export async function importLegacyCache(service:Pick<ArchiveService,'import'>,context:ArchiveContext,vault:string,snapshot:CacheImportSnapshot,current:()=>boolean,progress:(saved:number,kept:number)=>void=()=>{}):Promise<CacheImportOutcome>{
 const outcome:CacheImportOutcome={saved:0,cleared:0,kept:0,unknown:snapshot.unknown,unknownCompletion:0,blocked:0,interrupted:false};
 const run=async(thread:FrozenThread,pairs:FrozenPair[]):Promise<void>=>{
  if(!current()){outcome.interrupted=true;return;}const batch:ImportBatch={sourceVaultPath:vault,threadId:thread.id,attempts:pairs.map((pair)=>pair.attempt)};
  try {
   const result=await service.import(context,batch);if(!current()){outcome.interrupted=true;return;}if(!sameArchiveContext(context,result.context))throw new Error('Archive opening changed.');if(result.items.length!==pairs.length||new Set(result.items.map((item)=>JSON.stringify([item.userMessageId,item.assistantMessageId]))).size!==pairs.length||!result.items.every((item)=>pairs.some((pair)=>pair.attempt.userMessageId===item.userMessageId&&pair.attempt.assistantMessageId===item.assistantMessageId)))throw new Error('Archive import result was incomplete.');
   const retained=result.items.filter((item)=>item.state==='retained');
   const verified=result.confirmed.filter((item)=>item.threadId===thread.id&&pairs.some((pair)=>pair.attempt.userMessageId===item.userMessageId&&pair.attempt.assistantMessageId===item.assistantMessageId)&&retained.some((record)=>record.attemptId===item.attemptId&&record.userMessageId===item.userMessageId&&record.assistantMessageId===item.assistantMessageId));
   if(verified.length!==retained.length||verified.length!==result.confirmed.length||new Set(verified.map((item)=>JSON.stringify([item.attemptId,item.userMessageId,item.assistantMessageId]))).size!==verified.length)throw new Error('Archive readback was not confirmed.');
   outcome.saved+=verified.length;outcome.kept+=result.items.filter((item)=>item.state==='skipped').length;
   outcome.unknownCompletion+=result.items.filter((item)=>item.state==='skipped'&&item.reason==='unknown_completion').length;outcome.blocked+=result.items.filter((item)=>item.state==='skipped'&&item.reason==='blocked_active').length;
   const cleared=clearImportedCacheBodies(vault,verified,(cached,user,assistant,rawFingerprint)=>{const frozen=pairs.find((pair)=>pair.attempt.userMessageId===user&&pair.attempt.assistantMessageId===assistant);return frozen!==undefined&&rawFingerprint===frozen.rawFingerprint&&matches(cached,frozen);});outcome.cleared+=cleared;outcome.kept+=verified.length-cleared;
   progress(outcome.saved,outcome.kept);
  }catch(error){
   if(!current()){outcome.interrupted=true;return;}
   if(typeof error==='object'&&error!==null&&'code' in error&&error.code==='invalid'&&pairs.length>1){const at=Math.ceil(pairs.length/2);await run(thread,pairs.slice(0,at));await run(thread,pairs.slice(at));return;}
   outcome.kept+=pairs.length;progress(outcome.saved,outcome.kept);
  }
 };
 for(const thread of snapshot.threads){for(let at=0;at<thread.pairs.length;at+=20){await run(thread,thread.pairs.slice(at,at+20));if(outcome.interrupted)return outcome;}}
 return outcome;
}
