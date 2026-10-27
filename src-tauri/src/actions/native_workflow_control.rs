//! Original workflow control transaction; never an execution origin constructor.
use super::{history,row_transaction,workflow_rows,RuntimeOwner,WorkflowOpening,action_error};
use super::super::native_actions::operations;
use crate::actions::{effect_kernel as kernel,effect_types::*};
use crate::runtime::workflows as flow;
use rusqlite::{Connection,OptionalExtension,params};
use std::sync::Arc;
use tauri::AppHandle;
fn action(error:ActionError)->flow::Error{match error.code{ActionErrorCode::Denied|ActionErrorCode::NotFound|ActionErrorCode::DefinitionMismatch=>flow::Error::Denied,ActionErrorCode::RevisionConflict=>flow::Error::Stale,_=>flow::Error::Unavailable}}
fn terminal(run:&flow::Run)->bool{matches!(run.state.as_str(),"succeeded"|"failed"|"cancelled")}
fn checked(conn:&Connection,facts:workflow_rows::OpeningFacts<'_>,run:&str,epoch:u64,revision:u64)->Result<(workflow_rows::Origin,flow::Run,Option<InvocationId>),flow::Error>{
 // inspect verifies original owner/store/native/ACT scope and immutable identity,
 // without requiring a current execution grant or an idle execution lease.
 let origin=workflow_rows::inspect_rows(conn,facts,run)?;
 if origin.epoch!=epoch{return Err(flow::Error::Stale);}
 let scope=flow::Scope{owner:facts.owner,vault:facts.vault,store:facts.store,actor:&origin.actor};
 let current=flow::inspect_rows(conn,scope,run)?;
 if current.revision!=revision{return Err(flow::Error::Stale);}
 if terminal(&current){return Ok((origin,current,None));}
 let invocation:Option<Option<String>>=conn.query_row("SELECT a.invocation_id FROM workflow_steps s JOIN workflow_attempts a ON a.run_id=s.run_id AND a.step_id=s.step_id AND a.ordinal=s.attempt_ordinal WHERE s.run_id=?1 AND s.step_id=?2 AND s.kind='action'",params![run,current.cursor],|r|r.get(0)).optional().map_err(|_|flow::Error::Unavailable)?;
 let invocation=invocation.flatten().map(InvocationId);
 if let Some(id)=&invocation{
  let(bound,observed,_,consumer)=history::recorded_action_rows(conn,facts,run,id)?;
  if bound!=origin||observed!=current||current.cursor.as_deref()!=Some(consumer.step.as_str())||consumer.acknowledged{return Err(flow::Error::Denied);}
 }
 Ok((origin,current,invocation))
}
/// The actual native caller retains its authenticated original opening/storage
/// guard. All comparisons and both mutations repeat in one classified transaction.
pub(in crate::actions::native_owner) fn cancel_owned_rows(owner:&mut RuntimeOwner,facts:workflow_rows::OpeningFacts<'_>,run:&str,epoch:u64,revision:u64,now:i64,recheck:impl Fn()->Result<(),flow::Error>)->Result<flow::Run,flow::Error>{
 let(original,before,invocation)=owner.read_snapshot(|read|Ok(checked(read.conn,facts,run,epoch,revision))).map_err(|_|flow::Error::Unavailable)??;
 // The ACT lease is distinct from the active workflow pass lease. Busy remains
 // real ownership: it records intent and never invents provider completion.
 let physical=match &invocation{Some(id)=>operations::retained_cancellation_lease(owner,id).map_err(action)?,None=>None};
 let access=if physical.is_some(){kernel::SubmissionAccess::Held}else{kernel::SubmissionAccess::Busy};
 let cancelled=row_transaction(owner,recheck,|conn|{
  let(origin,current,id)=checked(conn,facts,run,epoch,revision)?;
  if origin!=original||current!=before||id!=invocation{return Err(flow::Error::Stale);}
  if terminal(&current){return Ok(current);}
  if let Some(id)=&id{
   let record=kernel::load(conn,id).map_err(action)?;
   if matches!(record.details.effect.state,InvocationState::Prepared|InvocationState::AwaitingApproval|InvocationState::Ready|InvocationState::Dispatched|InvocationState::OutcomeUnknown){
    kernel::cancel_recorded_rows(conn,&record.scope,id,record.revision(),access).map_err(action)?;
   }
  }
  let scope=flow::Scope{owner:facts.owner,vault:facts.vault,store:facts.store,actor:&origin.actor};
  let cancelled=flow::cancel_rows(conn,scope,run,current.revision,now)?;
  match id{Some(id)=>history::reconcile_with_opening(conn,facts,run,epoch,&id,now,history::OpeningUse::Current),None=>Ok(cancelled)}
 })?;
 // The original storage guard is still held by the native caller. Notify only
 // known-committed intent, retaining the ACT physical lease through notification.
 if cancelled.cancel_requested{if let Some(book)=owner.action_cancellations.upgrade(){book.cancel_run(&original.native_run);}}
 drop(physical);
 Ok(cancelled)
}
/// A genuine captured opening is the control proof. This entry never captures
/// an execution origin, reacquires WorkflowExecution, or changes a grant.
pub(super) fn cancel(app:&AppHandle,opening:&Arc<WorkflowOpening>,run:&str,epoch:u64,revision:u64)->Result<flow::Run,ActionError>{
 opening.guarded(app,|owner,recheck|cancel_owned_rows(owner,opening.facts(),run,epoch,revision,chrono::Utc::now().timestamp_millis(),||recheck().map_err(|_|flow::Error::Unavailable)).map_err(action_error))
}
