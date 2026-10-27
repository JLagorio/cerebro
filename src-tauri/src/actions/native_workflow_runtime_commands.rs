//! Actual native command composition. Wire selectors never supply authority.
use super::{commands,control,history,views,worker,workflow_rows,WorkflowOpening,CurrentWorkflowOrigin,kernel,action_error,row_transaction,original_definition,start_captured};
use super::super::native_actions::operations;
use crate::{actions::{effect_types::*,SafeCounter,workflow_linkage},runtime::workflows as flow,workflows::transport::*};
use rusqlite::{Connection,OptionalExtension,params};
use std::sync::Arc;
use tauri::{AppHandle,WebviewWindow};
fn error(code:WorkflowErrorCode)->WorkflowError{WorkflowError{code,diagnostics:Vec::new()}}
fn action(value:ActionError)->WorkflowError{commands::action(value)}
pub(super) fn permissions(value:&WorkflowPermissions)->workflow_rows::Permissions{workflow_rows::Permissions{read_prefixes:value.read_prefixes.clone(),query_records:value.query_records,accounts:value.accounts.iter().map(|a|workflow_rows::AccountSelection{connection:a.connection.clone(),account:a.account.clone(),action:a.action.clone(),definition:a.definition.clone(),capabilities:a.capabilities.clone(),input_scope:match a.input_scope{WorkflowInputScope::AllValidInputs=>"all_valid_inputs",WorkflowInputScope::ExactCanonicalInput=>"exact_canonical_input"}.into(),input_digest:a.input_digest.clone()}).collect()}}
fn inspect<T>(app:&AppHandle,opening:&WorkflowOpening,read:impl FnOnce(&Connection)->Result<T,flow::Error>)->Result<T,WorkflowError>{
 opening.guarded(app,|owner,_|owner.read_snapshot(|snapshot|Ok(read(snapshot.conn))).map_err(|_|kernel::unavailable())?.map_err(action_error)).map_err(action)
}
fn scope<'a>(opening:&'a WorkflowOpening,origin:&'a workflow_rows::Origin)->flow::Scope<'a>{let facts=opening.facts();flow::Scope{owner:facts.owner,vault:facts.vault,store:facts.store,actor:&origin.actor}}
fn ack(opening:&WorkflowOpening,version:WorkflowVersionRef,origin:&workflow_rows::Origin,run:&flow::Run,created:bool,admission:WorkflowAdmission)->Result<WorkflowStartAck,WorkflowError>{Ok(WorkflowStartAck{context:commands::observed(opening),version,run_id:origin.flow_run.clone(),revision:SafeCounter::new(run.revision).map_err(action)?,admission_epoch:SafeCounter::new(origin.epoch).map_err(action)?,created,admission})}
fn enqueue(app:&AppHandle,current:Result<Option<CurrentWorkflowOrigin>,ActionError>)->WorkflowAdmission{match current{Ok(Some(origin))=>match worker::enqueue(app,origin){Ok(true)=>WorkflowAdmission::Ready,Ok(false)=>WorkflowAdmission::Busy,Err(_)=>WorkflowAdmission::Unavailable},Ok(None)=>WorkflowAdmission::Busy,Err(_)=>WorkflowAdmission::Unavailable}}
fn actual_version(conn:&Connection,origin:&workflow_rows::Origin)->Result<WorkflowVersionRef,flow::Error>{let workflow_id=conn.query_row("SELECT workflow_id FROM workflow_runs WHERE run_id=?1",[&origin.flow_run],|r|r.get(0)).map_err(|_|flow::Error::Unavailable)?;Ok(WorkflowVersionRef{workflow_id,definition_hash:origin.version.clone()})}
fn admitted(app:&AppHandle,opening:&Arc<WorkflowOpening>,run:&str,epoch:Option<u64>,revision:Option<u64>)->Result<(workflow_rows::Origin,flow::Run,WorkflowVersionRef),WorkflowError>{
 inspect(app,opening,|conn|{
  let original=workflow_rows::inspect_rows(conn,opening.facts(),run)?;
  let origin=workflow_rows::admission_rows(conn,opening.facts(),run,epoch.unwrap_or(original.epoch))?;
  let current=flow::inspect_rows(conn,scope(opening,&origin),run)?;
  if revision.is_some_and(|expected|current.revision!=expected){return Err(flow::Error::Stale);}
  original_definition(conn,opening,&origin)?;let version=actual_version(conn,&origin)?;Ok((origin,current,version))
 })
}
fn retained(app:&AppHandle,opening:&Arc<WorkflowOpening>,run:&str)->Result<CurrentWorkflowOrigin,WorkflowError>{let(origin,_,_)=admitted(app,opening,run,None,None)?;opening.retain(app,origin).map_err(action)?.ok_or_else(||error(WorkflowErrorCode::Unavailable))}
fn run_view(app:&AppHandle,opening:&WorkflowOpening,run:&str)->Result<WorkflowRunView,WorkflowError>{inspect(app,opening,|conn|views::run_rows(conn,opening.facts(),run,&opening.root))}

pub(crate) fn workflow_start(app:&AppHandle,window:&WebviewWindow,request:WorkflowStartRequest)->Result<WorkflowStartAck,WorkflowError>{
 let opening=commands::bound(app,window,&request.context)?;
 let(started,run)=start_captured(app,&opening,&request.start_key,&request.version.workflow_id,&request.version.definition_hash,&request.input_json,&permissions(&request.permissions)).map_err(action)?;
 let(created,origin)=match started.row{workflow_rows::Started::New(origin)=>(true,origin),workflow_rows::Started::Observed(origin)=>(false,origin)};
 // Observed Start has no current origin: no implicit reauthorization or wake.
 let admission=enqueue(app,started.current);ack(&opening,request.version,&origin,&run,created,admission)
}
pub(crate) fn workflow_continue(app:&AppHandle,window:&WebviewWindow,request:WorkflowRunRequest)->Result<WorkflowStartAck,WorkflowError>{
 let opening=commands::bound(app,window,&request.context)?;let(origin,run,version)=admitted(app,&opening,&request.run_id,Some(request.expected_epoch.get()),Some(request.expected_revision.get()))?;
 let current=opening.retain_checked(app,origin.clone(),Some(request.expected_revision.get())).map_err(action)?;
 let admission=enqueue(app,Ok(current));ack(&opening,version,&origin,&run,false,admission)
}
pub(crate) fn workflow_reauthorize(app:&AppHandle,window:&WebviewWindow,request:WorkflowReauthorizeRequest)->Result<WorkflowStartAck,WorkflowError>{
 let opening=commands::bound(app,window,&request.context)?;let requested=permissions(&request.permissions);
 let(result,source_current)=opening.guarded_rows(app,|owner,recheck|{
  let value=row_transaction(owner,||recheck().map_err(|_|flow::Error::Unavailable),|conn|{
   let original=workflow_rows::inspect_rows(conn,opening.facts(),&request.run_id)?;original_definition(conn,&opening,&original)?;
   let origin=workflow_rows::reauthorize_rows(conn,opening.facts(),&request.run_id,request.expected_epoch.get(),&requested,chrono::Utc::now())?;
   let run=flow::inspect_rows(conn,scope(&opening,&origin),&origin.flow_run)?;let version=actual_version(conn,&origin)?;Ok((origin,run,version))
  }).map_err(action_error)?;
  opening.owner.action_cancellations.cancel_run(&value.0.native_run);Ok(value)
 }).map_err(action)?;
 let(origin,run,version)=result.map_err(action)?;let current=if source_current{opening.retain(app,origin.clone())}else{Err(kernel::unavailable())};
 ack(&opening,version,&origin,&run,false,enqueue(app,current))
}
pub(crate) fn workflow_cancel(app:&AppHandle,window:&WebviewWindow,request:WorkflowRunRequest)->Result<WorkflowRunView,WorkflowError>{
 let opening=commands::bound(app,window,&request.context)?;
 control::cancel(app,&opening,&request.run_id,request.expected_epoch.get(),request.expected_revision.get()).map_err(action)?;
 run_view(app,&opening,&request.run_id)
}
pub(crate) fn workflow_runs(app:&AppHandle,window:&WebviewWindow,context:WorkflowContext,after:Option<String>)->Result<WorkflowRunCatalog,WorkflowError>{let opening=commands::bound(app,window,&context)?;inspect(app,&opening,|conn|views::catalog_rows(conn,opening.facts(),after.as_deref()))}
pub(crate) fn workflow_run(app:&AppHandle,window:&WebviewWindow,context:WorkflowContext,run:String)->Result<WorkflowRunView,WorkflowError>{let opening=commands::bound(app,window,&context)?;run_view(app,&opening,&run)}
pub(crate) fn workflow_value(app:&AppHandle,window:&WebviewWindow,request:WorkflowValueRequest)->Result<WorkflowValueDetail,WorkflowError>{let opening=commands::bound(app,window,&request.context)?;inspect(app,&opening,|conn|views::value_rows(conn,opening.facts(),&request))}
pub(crate) fn workflow_action_details(app:&AppHandle,window:&WebviewWindow,context:WorkflowContext,run:String,invocation:String)->Result<ActionEffectDetails,WorkflowError>{
 let opening=commands::bound(app,window,&context)?;inspect(app,&opening,|conn|{let(_,_,record,_)=history::recorded_action_rows(conn,opening.facts(),&run,&InvocationId(invocation))?;Ok(record.details)})
}
pub(crate) fn workflow_answer_action(app:&AppHandle,window:&WebviewWindow,request:WorkflowActionAnswer)->Result<WorkflowRunView,WorkflowError>{
 let opening=commands::bound(app,window,&request.context)?;let origin=retained(app,&opening,&request.run_id)?;let id=InvocationId(request.invocation_id.clone());
 operations::with_workflow_mutation(app,&origin,|conn,context,subject|{
  let(_,current,record,consumer)=history::recorded_action_rows(conn,opening.facts(),&request.run_id,&id).map_err(action_error)?;
  if current.cursor.as_deref()!=Some(consumer.step.as_str())||record.scope!=*subject||record.details.effect.approval_id.as_ref().map(|id|id.0.as_str())!=Some(request.approval_id.as_str()){return Err(kernel::denied());}
  kernel::answer_rows(conn,context,kernel::AnswerInput{person_id:crate::actions::native_rules::admission_rules().owner_storage_key.clone(),scope:subject.clone(),approval_id:ApprovalId(request.approval_id.clone()),allow:request.allow,edited_input:request.edited_input_json.clone(),expected_invocation_revision:request.expected_invocation_revision.get(),expected_approval_revision:request.expected_approval_revision.get()})?;
  workflow_linkage::observe_with_context(conn,origin.scope(),&request.run_id,current.revision,context,subject,&id,chrono::Utc::now().timestamp_millis()).map_err(action_error)
 }).map_err(action)?;
 operations::checkpoint_approved();
 // The retained origin is consumed by the owned queue; no inline provider path.
 let _admission=enqueue(app,Ok(Some(origin)));
 run_view(app,&opening,&request.run_id)
}
/// A consumed signal is a finite original observation, not fresh admission.
/// query_only plus the same snapshot's consumed-state check prevents mutation.
fn replay_wait(app:&AppHandle,opening:&WorkflowOpening,request:&WorkflowWaitAnswer)->Result<Option<WorkflowRunView>,WorkflowError>{
 inspect(app,opening,|conn|{
  let original=workflow_rows::inspect_rows(conn,opening.facts(),&request.run_id)?;
  let state:Option<String>=conn.query_row("SELECT state FROM workflow_waits WHERE continuation_id=?1 AND run_id=?2 AND kind='external_input'",params![request.continuation_id,request.run_id],|r|r.get(0)).optional().map_err(|_|flow::Error::Unavailable)?;
  if state.as_deref()!=Some("consumed"){return Ok(None);}
  let observed=flow::resume_rows(conn,scope(opening,&original),&request.continuation_id,request.expected_revision.get(),&request.signal_key,flow::Signal::ExternalInput{value:&request.input_json},chrono::Utc::now().timestamp_millis())?;
  if !matches!(observed,flow::Resumed::AlreadyConsumed(_)){return Err(flow::Error::Unavailable);}
  views::run_rows(conn,opening.facts(),&request.run_id,&opening.root).map(Some)
 })
}
pub(crate) fn workflow_answer_wait(app:&AppHandle,window:&WebviewWindow,request:WorkflowWaitAnswer)->Result<WorkflowRunView,WorkflowError>{
 let opening=commands::bound(app,window,&request.context)?;if let Some(observed)=replay_wait(app,&opening,&request)?{return Ok(observed);}let origin=retained(app,&opening,&request.run_id)?;
 let accepted=operations::with_workflow_mutation(app,&origin,|conn,_,_|{
  let bound:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM workflow_waits w JOIN workflow_steps s ON s.run_id=w.run_id AND s.step_id=w.step_id AND s.attempt_ordinal=w.attempt_ordinal JOIN workflow_runs r ON r.run_id=w.run_id AND r.cursor=w.step_id WHERE w.continuation_id=?1 AND w.run_id=?2 AND w.kind='external_input')",params![request.continuation_id,request.run_id],|r|r.get(0)).map_err(|_|kernel::unavailable())?;
  if !bound{return Err(kernel::denied());}
  let outcome=flow::resume_rows(conn,origin.scope(),&request.continuation_id,request.expected_revision.get(),&request.signal_key,flow::Signal::ExternalInput{value:&request.input_json},chrono::Utc::now().timestamp_millis()).map_err(action_error)?;
  Ok(!matches!(outcome,flow::Resumed::Rejected(_)|flow::Resumed::NotDue(_)))
 }).map_err(action)?;
 if !accepted{return Err(error(WorkflowErrorCode::InvalidInput));}
 let _admission=enqueue(app,Ok(Some(origin)));run_view(app,&opening,&request.run_id)
}

pub(crate) fn workflow_access(app:&AppHandle,window:&WebviewWindow,context:WorkflowContext,run:String)->Result<WorkflowAccessView,WorkflowError>{let opening=commands::bound(app,window,&context)?;inspect(app,&opening,|conn|views::access_rows(conn,opening.facts(),&run))}
