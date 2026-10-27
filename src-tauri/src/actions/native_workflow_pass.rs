//! One bounded synchronous pass owned by a genuine retained workflow origin.
//! Callers must retain their native worker through return, including HTTP cleanup.
use super::{CurrentWorkflowOrigin,action_error,driver,history,kernel,original_definition,row_transaction,workflow_rows};
use super::super::RuntimeOwner;
use super::super::native_actions::operations;
use crate::actions::{effect_types::*,workflow_linkage};
use crate::{runtime::workflows as flow,workflows::native_definition as definition};
use rusqlite::{Connection,OptionalExtension,params};
use std::sync::{Arc,atomic::{AtomicBool,Ordering}};
use tauri::AppHandle;

pub(in crate::actions::native_owner) struct Pass {pub(in crate::actions::native_owner) run:flow::Run,pub(in crate::actions::native_owner) yielded:bool}
fn runner_error(error:definition::RunnerError)->ActionError{match error{definition::RunnerError::Runtime(error)=>action_error(error),_=>kernel::unavailable()}}
fn terminal(run:&flow::Run)->bool{matches!(run.state.as_str(),"succeeded"|"failed"|"cancelled")}
fn linked_action(conn:&Connection,run:&flow::Run)->Result<Option<InvocationId>,flow::Error>{
 let Some(step)=run.cursor.as_deref()else{return Ok(None);};
 let value:Option<Option<String>>=conn.query_row("SELECT a.invocation_id FROM workflow_steps s JOIN workflow_attempts a ON a.run_id=s.run_id AND a.step_id=s.step_id AND a.ordinal=s.attempt_ordinal WHERE s.run_id=?1 AND s.step_id=?2 AND s.kind='action'",params![run.id,step],|row|row.get(0)).optional().map_err(|_|flow::Error::Unavailable)?;
 Ok(value.flatten().map(InvocationId))
}
impl CurrentWorkflowOrigin {
 fn original_rows(&self,owner:&mut RuntimeOwner,opening:history::OpeningUse,project:bool)->Result<flow::Run,ActionError>{
  if !Arc::ptr_eq(&owner.runtime_seal,&self.opening.runtime_seal)||!self.physical.matches_retained(&self.origin.flow_run,owner.identity){return Err(kernel::unavailable());}
  let result=row_transaction(owner,||self.opening.store.recheck().map_err(|_|flow::Error::Unavailable),|conn|{
   let stored=workflow_rows::inspect_rows(conn,self.opening.facts(),&self.origin.flow_run)?;
   if stored.native_run!=self.origin.native_run||stored.actor!=self.origin.actor||stored.authority!=self.origin.authority||stored.configuration!=self.origin.configuration||stored.version!=self.origin.version{return Err(flow::Error::Denied);}
   let run=flow::inspect_rows(conn,self.scope(),&self.origin.flow_run)?;
   if !project||terminal(&run){return Ok(run);}
   match linked_action(conn,&run)?{Some(id)=>history::reconcile_with_opening(conn,self.opening.facts(),&run.id,self.origin.epoch,&id,chrono::Utc::now().timestamp_millis(),opening),None=>Ok(run)}
  }).map_err(action_error)?;
  if result.cancel_requested{self.opening.owner.action_cancellations.cancel_run(&self.origin.native_run);}
  Ok(result)
 }
 /// Finite original facts can settle after an opening retires. This fallback
 /// never acquires the opening lock while native storage is held.
 fn original(&self,app:&AppHandle,project:bool)->Result<flow::Run,ActionError>{
  match self.guarded_rows(app,|owner,_|self.original_rows(owner,history::OpeningUse::Current,project)){
   Ok((result,_))=>result,
   Err(_)=>{
    let mut storage=self.opening.owner.storage.lock().map_err(|_|kernel::unavailable())?;
    if storage.failed{return Err(kernel::unavailable());}
    let owner=storage.owner.as_mut().ok_or_else(kernel::unavailable)?;
    owner.action_cancellations=Arc::downgrade(&self.opening.owner.action_cancellations);
    owner.credential_cancellations=Arc::downgrade(&self.opening.owner.credential_cancellations);
    let result=self.original_rows(owner,history::OpeningUse::Deferred,project);
    if owner.retired{storage.failed=true;self.opening.owner.action_cancellations.cancel_all();self.opening.owner.credential_cancellations.cancel_all();}
    result
   }
  }
 }
 fn project(&self,app:&AppHandle)->Result<flow::Run,ActionError>{
  let run=match self.original(app,true){
   // The canonical projection refuses a repeated unchanged ACT revision. Its
   // transaction rolled back; return the actual existing finite state.
   Err(error) if error.code==ActionErrorCode::RevisionConflict=>self.original(app,false)?,
   result=>result?,
  };
  Ok(run)
 }
 fn read(&self,app:&AppHandle,work:&definition::ReadWork)->Result<Result<String,definition::ReadError>,ActionError>{
  operations::with_workflow_inspection(app,self,|read,_,_|{
   let admitted=workflow_rows::current_rows(read.conn,self.opening.facts(),&self.origin.flow_run,self.origin.epoch,workflow_rows::CurrentUse::QueryRecords).map_err(action_error)?;
   if work.claim.run!=admitted.flow_run{return Err(kernel::denied());}
   flow::check_claim_rows(read.conn,self.scope(),&work.claim).map_err(action_error)?;
   // Mint only this borrowed read capability from actual current native
   // admission, under the same original opening/storage guard. Mail stays closed.
   let grant=crate::mcp::RunGrant{actor:admitted.actor.clone(),run_id:admitted.native_run,scope:Some(Vec::new()),read_scope:Some(admitted.current.read_prefixes),tools:Some(vec!["query_records".into()]),chain:vec![admitted.actor],vault:Some(self.opening.root.clone()),asks:crate::mcp::WriteAsks::UNASKED};
   let zone=crate::runtime::budget::system_timezone().parse::<chrono_tz::Tz>().unwrap_or(chrono_tz::UTC);
   let today=chrono::Utc::now().with_timezone(&zone).date_naive();
   Ok(definition::execute_read(crate::vault::corpus::shared(),&grant,&work.query,zone,today))
  })
 }
 fn action(&self,app:&AppHandle,run:&flow::Run)->Result<Option<InvocationId>,ActionError>{
  operations::with_workflow_mutation(app,self,|conn,context,subject|{
   let current=flow::inspect_rows(conn,self.scope(),&run.id).map_err(action_error)?;
   if current!=*run{return Err(kernel::stale());}
   let Some(id)=linked_action(conn,&current).map_err(action_error)?else{return Ok(None);};
   let record=kernel::load(conn,&id)?;
   let projection=workflow_linkage::observe_with_context(conn,self.scope(),&run.id,current.revision,context,subject,&id,chrono::Utc::now().timestamp_millis());
   let projected=match projection{Ok(run)=>run,Err(flow::Error::Stale)=>{
    let effect_revision:i64=conn.query_row("SELECT effect_revision FROM workflow_steps WHERE run_id=?1 AND step_id=?2",params![run.id,run.cursor],|row|row.get(0)).map_err(|_|kernel::unavailable())?;
    if u64::try_from(effect_revision).map_err(|_|kernel::unavailable())?!=record.revision(){return Err(kernel::stale());}current
   },Err(error)=>return Err(action_error(error))};
   Ok((record.details.effect.state==InvocationState::Ready&&!projected.cancel_requested&&projected.reason.as_deref()==Some("action_ready")).then_some(id))
  })
 }
 fn due_timer(&self,app:&AppHandle,run:&flow::Run)->Result<bool,ActionError>{
  operations::with_workflow_mutation(app,self,|conn,_,_|{
   let current=flow::inspect_rows(conn,self.scope(),&run.id).map_err(action_error)?;
   if current!=*run{return Err(kernel::stale());}
   let now=chrono::Utc::now().timestamp_millis();
   let due:Option<(String,i64)>=conn.query_row("SELECT w.continuation_id,w.revision FROM workflow_waits w JOIN workflow_steps s ON s.run_id=w.run_id AND s.step_id=w.step_id AND s.attempt_ordinal=w.attempt_ordinal WHERE w.run_id=?1 AND w.step_id=?2 AND w.kind='timer' AND w.state='pending' AND w.due_at<=?3",params![run.id,run.cursor,now],|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(|_|kernel::unavailable())?;
   let Some((id,revision))=due else{return Ok(false);};
   let revision=u64::try_from(revision).map_err(|_|kernel::unavailable())?;
   let outcome=flow::resume_rows(conn,self.scope(),&id,revision,&id,flow::Signal::Timer{ready:true},now).map_err(action_error)?;
   Ok(matches!(outcome,flow::Resumed::Advanced(_)|flow::Resumed::AlreadyConsumed(_)))
  })
 }
}

/// One synchronous native worker pass. Stop is a local refusal to begin more
/// work, never authority and never a fabricated ACT cancellation outcome.
pub(in crate::actions::native_owner) fn drive(app:&AppHandle,origin:&CurrentWorkflowOrigin,stop:&AtomicBool)->Result<Pass,ActionError>{
 for _ in 0..flow::execution_policy().reconciliation_batch{
  let run=origin.project(app)?;
  if terminal(&run)||run.cancel_requested||stop.load(Ordering::SeqCst){return Ok(Pass{run,yielded:false});}
  if run.state!="queued"{
   if let Some(id)=origin.action(app,&run)?{
    if stop.load(Ordering::SeqCst){return Ok(Pass{run,yielded:false});}
    let dispatched=operations::dispatch_workflow(app,origin,id);
    // Original finite observation/receipt projection always follows actual
    // provider cleanup, even when its current opening or account disappeared.
    let observed=origin.project(app)?;
    if let Err(error)=dispatched{if observed==run{return Err(error);}}
    if observed.state=="queued"{continue;}
    return Ok(Pass{run:observed,yielded:false});
   }
   if run.state=="waiting"&&origin.due_timer(app,&run)?{continue;}
   return Ok(Pass{run:origin.project(app)?,yielded:false});
  }
  let(pinned,plan)=operations::with_workflow_inspection(app,origin,|read,_,_|{
   let pinned=original_definition(read.conn,&origin.opening,&origin.origin).map_err(action_error)?;
   let plan=driver::plan_rows(read.conn,origin.opening.facts(),&run.id,origin.origin.epoch,&pinned).map_err(runner_error)?;Ok((pinned,plan))
  })?;
  let definition::Plan::Pending(plan)=plan else{return Ok(Pass{run:origin.original(app,false)?,yielded:false});};
  let prepared=match definition::prepare(&plan){Ok(prepared)=>prepared,Err(error)=>{
   let run=operations::with_workflow_mutation(app,origin,|conn,_,_|driver::reject_rows(conn,origin.opening.facts(),&run.id,origin.origin.epoch,&plan,error,chrono::Utc::now().timestamp_millis()).map_err(runner_error))?;
   return Ok(Pass{run,yielded:false});
  }};
  if stop.load(Ordering::SeqCst){return Ok(Pass{run,yielded:false});}
  let applied=operations::with_workflow_mutation(app,origin,|conn,context,subject|driver::apply_rows(conn,origin.opening.facts(),&run.id,origin.origin.epoch,prepared,context,subject,chrono::Utc::now().timestamp_millis()).map_err(runner_error))?;
  match applied{
   driver::Step::Advanced(run)=>if terminal(&run){return Ok(Pass{run,yielded:false});},
   driver::Step::Waiting(_)=>{},
   driver::Step::Action{inserted,..}=>operations::checkpoint_prepared(inserted),
   driver::Step::Read(work)=>{
    let output=origin.read(app,&work)?;
    let output=output.as_deref().map_err(Clone::clone);
    let run=operations::with_workflow_mutation(app,origin,|conn,_,_|driver::settle_read_rows(conn,origin.opening.facts(),&run.id,origin.origin.epoch,&pinned,&work,output,chrono::Utc::now().timestamp_millis()).map_err(runner_error))?;
    if terminal(&run){return Ok(Pass{run,yielded:false});}
   }
  }
 }
 Ok(Pass{run:origin.project(app)?,yielded:true})
}
