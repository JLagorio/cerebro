//! Original workflow presentation rows only. Native opening authentication is external.
use super::workflow_rows;
use crate::{actions::SafeCounter,runtime::workflows as flow,workflows::{document_service,transport::*}};
use rusqlite::{Connection,OptionalExtension,params};
use std::path::Path;
fn db(_:rusqlite::Error)->flow::Error{flow::Error::Unavailable}
fn context(facts:workflow_rows::OpeningFacts<'_>)->WorkflowContext{WorkflowContext{vault_id:facts.vault.into(),store_uuid:facts.store.into()}}
fn scope<'a>(facts:workflow_rows::OpeningFacts<'a>,origin:&'a workflow_rows::Origin)->flow::Scope<'a>{flow::Scope{owner:facts.owner,vault:facts.vault,store:facts.store,actor:&origin.actor}}
fn counter(value:u64)->Result<SafeCounter,flow::Error>{SafeCounter::new(value).map_err(|_|flow::Error::Unavailable)}
fn sql_count(row:&rusqlite::Row<'_>,index:usize)->rusqlite::Result<SafeCounter>{let value:i64=row.get(index)?;let value=u64::try_from(value).map_err(|_|rusqlite::Error::InvalidQuery)?;SafeCounter::new(value).map_err(|_|rusqlite::Error::InvalidQuery)}
fn integer(value:usize)->Result<i64,flow::Error>{i64::try_from(value).map_err(|_|flow::Error::Unavailable)}
fn word<T:serde::de::DeserializeOwned>(value:String)->Result<T,flow::Error>{serde_json::from_value(serde_json::Value::String(value)).map_err(|_|flow::Error::Unavailable)}
fn stamp(value:i64)->Result<String,flow::Error>{chrono::DateTime::from_timestamp_millis(value).map(|v|v.to_rfc3339_opts(chrono::SecondsFormat::Millis,true)).ok_or(flow::Error::Unavailable)}
fn terminal(run:&flow::Run)->bool{matches!(run.state.as_str(),"succeeded"|"failed"|"cancelled")}
fn guarded(conn:&Connection,facts:workflow_rows::OpeningFacts<'_>)->Result<(),flow::Error>{if conn.is_autocommit(){return Err(flow::Error::Unavailable);}if facts.owner!=crate::actions::native_rules::admission_rules().owner_storage_key{return Err(flow::Error::Denied);}Ok(())}
fn workflow(conn:&Connection,run:&str)->Result<String,flow::Error>{conn.query_row("SELECT workflow_id FROM workflow_runs WHERE run_id=?1",[run],|r|r.get(0)).map_err(db)}
struct ValueRef<'a>{run:&'a str,step:&'a str,role:&'a str,ordinal:u64,reference:&'a str,digest:&'a str}
fn value_meta(conn:&Connection,value:&ValueRef<'_>)->Result<Option<SafeCounter>,flow::Error>{
 let ordinal=i64::try_from(value.ordinal).map_err(|_|flow::Error::Unavailable)?;
 let row:Option<(String,i64,i64)>=conn.query_row("SELECT digest,byte_count,length(CAST(canonical_json AS BLOB)) FROM workflow_values WHERE run_id=?1 AND value_ref=?2 AND role=?3 AND step_id=?4 AND ordinal=?5",params![value.run,value.reference,value.role,value.step,ordinal],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(db)?;
 row.map(|(digest,bytes,actual)|{if digest!=value.digest||bytes!=actual||bytes<0||bytes>integer(flow::action_output_allocation())?{return Err(flow::Error::Unavailable);}counter(u64::try_from(bytes).map_err(|_|flow::Error::Unavailable)?)}).transpose()
}
fn read_value(conn:&Connection,value:&ValueRef<'_>)->Result<WorkflowValueDetail,flow::Error>{
 let bytes=value_meta(conn,value)?.ok_or(flow::Error::Unavailable)?;
 let body:String=conn.query_row("SELECT canonical_json FROM workflow_values WHERE run_id=?1 AND value_ref=?2 AND length(CAST(canonical_json AS BLOB))<=?3",params![value.run,value.reference,integer(flow::action_output_allocation())?],|r|r.get(0)).map_err(db)?;
 if u64::try_from(body.len()).map_err(|_|flow::Error::Unavailable)?!=bytes.get()||crate::ledger::sha256_hex(body.as_bytes())!=value.digest{return Err(flow::Error::Unavailable);}
 let canonical=crate::actions::schema::workflow_canonical_json(&body,flow::action_output_allocation(),flow::action_output_json_depth()).map_err(|_|flow::Error::Unavailable)?;
 if canonical!=body{return Err(flow::Error::Unavailable);}Ok(WorkflowValueDetail{digest:value.digest.into(),json:body})
}
fn value_view(conn:&Connection,run:&flow::Run,step:&str,ordinal:u64,role:&str,reference:Option<&str>,digest:Option<&str>)->WorkflowValueView{
 match(reference,digest){
  (None,None)=>WorkflowValueView::NotRecorded{},
  (Some(reference),Some(digest))=>match value_meta(conn,&ValueRef{run:&run.id,step,ordinal,role,reference,digest}){
   Ok(Some(bytes))=>WorkflowValueView::Available{digest:digest.into(),bytes},
   Ok(None) if terminal(run)=>WorkflowValueView::NotRetained{digest:digest.into()},
   _=>WorkflowValueView::Unavailable{},
  },_=>WorkflowValueView::Unavailable{}
 }
}
struct StepRow{id:String,kind:String,state:String,ordinal:SafeCounter,input_ref:Option<String>,input_digest:Option<String>,output_ref:Option<String>,output_digest:Option<String>,reason:Option<String>,invocation:Option<String>}
fn step_row(r:&rusqlite::Row<'_>)->rusqlite::Result<StepRow>{Ok(StepRow{id:r.get(0)?,kind:r.get(1)?,state:r.get(2)?,ordinal:sql_count(r,3)?,input_ref:r.get(4)?,input_digest:r.get(5)?,output_ref:r.get(6)?,output_digest:r.get(7)?,reason:r.get(8)?,invocation:r.get(9)?})}
fn operation_kind(operation:&WorkflowOperationDraft)->&'static str{match operation{WorkflowOperationDraft::Read{..}=>"read",WorkflowOperationDraft::Transform{..}=>"transform",WorkflowOperationDraft::Condition{..}=>"condition",WorkflowOperationDraft::Action{..}=>"action",WorkflowOperationDraft::Timer{..}=>"timer",WorkflowOperationDraft::ExternalInput{..}=>"external_input",WorkflowOperationDraft::Result{..}=>"result"}}
struct WaitRow{id:String,kind:String,state:String,revision:SafeCounter,due:Option<i64>,expires:Option<i64>,schema_ref:Option<String>,schema_digest:Option<String>}
fn wait_view(conn:&Connection,run:&flow::Run,step:&StepRow)->Result<Option<WorkflowWaitView>,flow::Error>{
 let ordinal=i64::try_from(step.ordinal.get()).map_err(|_|flow::Error::Unavailable)?;
 let wait=conn.query_row("SELECT continuation_id,kind,state,revision,due_at,expires_at,schema_ref,schema_digest FROM workflow_waits WHERE run_id=?1 AND step_id=?2 AND attempt_ordinal=?3 AND definition_hash=?4",params![run.id,step.id,ordinal,run.version],|r|Ok(WaitRow{id:r.get(0)?,kind:r.get(1)?,state:r.get(2)?,revision:sql_count(r,3)?,due:r.get(4)?,expires:r.get(5)?,schema_ref:r.get(6)?,schema_digest:r.get(7)?})).optional().map_err(db)?;
 let Some(wait)=wait else{return Ok(None);};
 let schema_json=if wait.kind=="external_input"&&wait.state=="pending"&&!terminal(run){
  let reference=wait.schema_ref.as_deref().ok_or(flow::Error::Unavailable)?;let digest=wait.schema_digest.as_deref().ok_or(flow::Error::Unavailable)?;
  Some(read_value(conn,&ValueRef{run:&run.id,step:&step.id,ordinal:step.ordinal.get(),role:"wait_schema",reference,digest})?.json)
 }else{None};
 Ok(Some(WorkflowWaitView{continuation_id:wait.id,kind:word(wait.kind)?,state:word(wait.state)?,revision:wait.revision,due_at:wait.due.map(stamp).transpose()?,expires_at:wait.expires.map(stamp).transpose()?,schema_json}))
}
pub(in crate::actions::native_owner) fn run_rows(conn:&Connection,facts:workflow_rows::OpeningFacts<'_>,id:&str,root:&Path)->Result<WorkflowRunView,flow::Error>{
 guarded(conn,facts)?;let origin=workflow_rows::inspect_rows(conn,facts,id)?;let run=flow::inspect_rows(conn,scope(facts,&origin),id)?;
 let version=WorkflowVersionRef{workflow_id:workflow(conn,id)?,definition_hash:origin.version.clone()};
 // Pinned labels need no retained operational input and never follow publication.
 let definition=document_service::version(root,&version).map_err(|_|flow::Error::Unavailable)?;
 let mut query=conn.prepare("SELECT s.step_id,s.kind,s.state,s.attempt_ordinal,s.input_ref,s.input_digest,s.output_ref,s.output_digest,s.reason,a.invocation_id FROM workflow_steps s LEFT JOIN workflow_attempts a ON a.run_id=s.run_id AND a.step_id=s.step_id AND a.ordinal=s.attempt_ordinal WHERE s.run_id=?1 ORDER BY s.definition_ordinal LIMIT ?2").map_err(db)?;
 let rows=query.query_map(params![id,integer(flow::definition_step_limit().checked_add(1).ok_or(flow::Error::Unavailable)?)?],step_row).map_err(db)?.collect::<Result<Vec<_>,_>>().map_err(db)?;
 if rows.len()!=definition.steps.len()||rows.len()>flow::definition_step_limit(){return Err(flow::Error::Unavailable);}
 let mut steps=Vec::with_capacity(rows.len());
 for(row,declared)in rows.iter().zip(&definition.steps){
  if row.id!=declared.step_id||row.kind!=operation_kind(&declared.operation){return Err(flow::Error::Unavailable);}
  steps.push(WorkflowStepView{step_id:row.id.clone(),label:declared.label.clone(),kind:word(row.kind.clone())?,state:word(row.state.clone())?,ordinal:row.ordinal,reason:row.reason.clone(),input:value_view(conn,&run,&row.id,row.ordinal.get(),"step_input",row.input_ref.as_deref(),row.input_digest.as_deref()),output:value_view(conn,&run,&row.id,row.ordinal.get(),"step_output",row.output_ref.as_deref(),row.output_digest.as_deref()),invocation_id:row.invocation.clone(),wait:wait_view(conn,&run,row)?});
 }
 Ok(WorkflowRunView{context:context(facts),version,run_id:run.id,native_run_id:origin.native_run,state:word(run.state)?,reason:run.reason,revision:counter(run.revision)?,admission_epoch:counter(origin.epoch)?,configuration_digest:origin.configuration,input_digest:run.input_digest,cancel_requested:run.cancel_requested,steps})
}
pub(in crate::actions::native_owner) fn catalog_rows(conn:&Connection,facts:workflow_rows::OpeningFacts<'_>,after:Option<&str>)->Result<WorkflowRunCatalog,flow::Error>{
 guarded(conn,facts)?;
 let cursor=after.map(|id|{workflow_rows::inspect_rows(conn,facts,id)?;conn.query_row("SELECT created_at FROM workflow_runs WHERE run_id=?1",[id],|r|r.get::<_,i64>(0)).map_err(db)}).transpose()?;
 let page=flow::catalog_policy().page_size;
 let mut query=conn.prepare("SELECT r.run_id,r.created_at,r.updated_at FROM workflow_runs r JOIN workflow_run_origins o ON o.workflow_run_id=r.run_id WHERE r.owner_person=?1 AND r.vault_id=?2 AND r.store_uuid=?3 AND o.owner_person=?1 AND o.vault_id=?2 AND o.store_uuid=?3 AND o.canonical_vault_path=?4 AND (?5 IS NULL OR r.created_at<?5 OR (r.created_at=?5 AND r.run_id<?6)) ORDER BY r.created_at DESC,r.run_id DESC LIMIT ?7").map_err(db)?;
 let mut rows=query.query_map(params![facts.owner,facts.vault,facts.store,facts.canonical_vault,cursor,after,integer(page.checked_add(1).ok_or(flow::Error::Unavailable)?)?],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?))).map_err(db)?.collect::<Result<Vec<_>,_>>().map_err(db)?;
 let truncated=rows.len()>page;rows.truncate(page);let next_cursor=if truncated{rows.last().map(|row|row.0.clone())}else{None};
 let mut items=Vec::with_capacity(rows.len());for(id,created,updated)in rows{let origin=workflow_rows::inspect_rows(conn,facts,&id)?;let run=flow::inspect_rows(conn,scope(facts,&origin),&id)?;items.push(WorkflowRunListItem{version:WorkflowVersionRef{workflow_id:workflow(conn,&id)?,definition_hash:run.version},run_id:id,state:word(run.state)?,reason:run.reason,revision:counter(run.revision)?,admission_epoch:counter(origin.epoch)?,started_at:stamp(created)?,updated_at:stamp(updated)?});}
 Ok(WorkflowRunCatalog{context:context(facts),items,next_cursor,truncated})
}
pub(in crate::actions::native_owner) fn value_rows(conn:&Connection,facts:workflow_rows::OpeningFacts<'_>,request:&WorkflowValueRequest)->Result<WorkflowValueDetail,flow::Error>{
 guarded(conn,facts)?;if request.context!=context(facts){return Err(flow::Error::Denied);}
 let origin=workflow_rows::inspect_rows(conn,facts,&request.run_id)?;let run=flow::inspect_rows(conn,scope(facts,&origin),&request.run_id)?;
 let(reference,digest,ordinal,role)=match request.role{
  WorkflowValueRole::RunInput=>{if !request.step_id.is_empty(){return Err(flow::Error::Denied);}let reference:String=conn.query_row("SELECT input_ref FROM workflow_runs WHERE run_id=?1",[&run.id],|r|r.get(0)).map_err(db)?;(Some(reference),Some(run.input_digest),0,"run_input")},
  WorkflowValueRole::StepInput|WorkflowValueRole::StepOutput=>{
   let row:Option<(Option<String>,Option<String>,Option<String>,Option<String>,i64)>=conn.query_row("SELECT input_ref,input_digest,output_ref,output_digest,attempt_ordinal FROM workflow_steps WHERE run_id=?1 AND step_id=?2",params![run.id,request.step_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(db)?;
   let(input,input_digest,output,output_digest,ordinal)=row.ok_or(flow::Error::Denied)?;let ordinal=u64::try_from(ordinal).map_err(|_|flow::Error::Unavailable)?;counter(ordinal)?;
   if matches!(request.role,WorkflowValueRole::StepInput){(input,input_digest,ordinal,"step_input")}else{(output,output_digest,ordinal,"step_output")}
  }
 };
 let reference=reference.ok_or(flow::Error::Denied)?;let digest=digest.ok_or(flow::Error::Denied)?;if digest!=request.digest{return Err(flow::Error::Denied);}
 read_value(conn,&ValueRef{run:&request.run_id,step:&request.step_id,role,ordinal,reference:&reference,digest:&digest})
}

/// Existing original scoped rows only; this reader cannot admit a run or grant.
pub(super) fn permission_view(value:workflow_rows::Permissions)->Result<WorkflowPermissions,flow::Error>{
 let accounts=value.accounts.into_iter().map(|item|{
  let input_scope=match item.input_scope.as_str(){"all_valid_inputs"=>WorkflowInputScope::AllValidInputs,"exact_canonical_input"=>WorkflowInputScope::ExactCanonicalInput,_=>return Err(flow::Error::Unavailable)};
  Ok(WorkflowAccountPermission{connection:item.connection,account:item.account,action:item.action,definition:item.definition,capabilities:item.capabilities,input_scope,input_digest:item.input_digest})
 }).collect::<Result<Vec<_>,flow::Error>>()?;
 Ok(WorkflowPermissions{read_prefixes:value.read_prefixes,query_records:value.query_records,accounts})
}
pub(in crate::actions::native_owner) fn access_rows(conn:&Connection,facts:workflow_rows::OpeningFacts<'_>,run:&str)->Result<WorkflowAccessView,flow::Error>{
 guarded(conn,facts)?;
 // The existing loader verifies original native/FLOW scope, canonical permission
 // bytes/digests, shared bounds and current-within-original integrity. No grant
 // is inferred from a definition, fresh catalog or this presentation DTO.
 let origin=workflow_rows::inspect_rows(conn,facts,run)?;
 Ok(WorkflowAccessView{context:context(facts),run_id:origin.flow_run,admission_epoch:counter(origin.epoch)?,original:permission_view(origin.original)?,current:permission_view(origin.current)?})
}
