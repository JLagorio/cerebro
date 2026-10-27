//! One captured native-opening Sweep on the existing owned workflow dispatcher.
//! There is no renderer clock, scope factory, grant constructor or second timer.
use super::*;
use crate::runtime::workflow_activations as activation;
use crate::workflows::{native_definition::NativeDefinition,schedule::{Observation,Plan},transport::{WorkflowMonitoring,WorkflowMonitorState,WorkflowContext,WorkflowScheduleMonitorAck,WorkflowError}};
use super::super::{commands,occurrence};
use tauri::WebviewWindow;
#[derive(Clone)]
struct SweepTicket{opening:Arc<WorkflowOpening>,previous_ms:Option<i64>,after:Option<String>,recovery_after:Option<String>}
struct Prepared{definition:NativeDefinition,expected:occurrence::Expected,plan:Plan}
fn scope(opening:&WorkflowOpening)->activation::Scope<'_>{let facts=opening.facts();activation::Scope{owner:facts.owner,vault:facts.vault,store:facts.store,canonical_vault:facts.canonical_vault}}
fn read<T>(app:&AppHandle,opening:&WorkflowOpening,operation:impl FnOnce(&rusqlite::Connection)->Result<T,flow::Error>)->Result<T,ActionError>{
 opening.guarded(app,|owner,_|owner.read_snapshot(|read|Ok(operation(read.conn))).map_err(|_|kernel::unavailable())?.map_err(action_error))
}
fn prepare_rows(conn:&rusqlite::Connection,opening:&WorkflowOpening,selected:&activation::Activation,observation:Observation,now:chrono::DateTime<chrono::Utc>)->Result<Prepared,flow::Error>{
  let material=activation::material_rows(conn,scope(opening),&selected.workflow)?.ok_or(flow::Error::Denied)?;
  if material.current!=*selected{return Err(flow::Error::Stale);}
  let input=material.input.as_deref().ok_or(flow::Error::Denied)?;
  let definition=NativeDefinition::load(&opening.root,&selected.workflow,&selected.version,input).map_err(|_|flow::Error::Unavailable)?;
  let mut expected=occurrence::Expected{activation:selected.id.clone(),workflow:selected.workflow.clone(),revision:selected.revision,epoch:selected.epoch.clone(),version:selected.version.clone(),configuration:selected.configuration.clone(),input_digest:selected.input_digest.clone(),permission_digest:selected.permission_digest.clone(),trigger_digest:selected.trigger_digest.clone(),cursor_ms:selected.cursor_ms,intended_ms:selected.cursor_ms};
  let preview=occurrence::preview_rows(conn,opening.facts(),&expected,&definition,observation,now)?;
  expected.intended_ms=preview.plan.due_ms.unwrap_or(selected.cursor_ms);
  Ok(Prepared{definition,expected,plan:preview.plan})
}
fn prepare(app:&AppHandle,opening:&WorkflowOpening,selected:&activation::Activation,observation:Observation,now:chrono::DateTime<chrono::Utc>)->Result<Prepared,ActionError>{read(app,opening,|conn|prepare_rows(conn,opening,selected,observation,now))}
/// Exact shared current-account planning for the human SELECT projection.
/// No IPC observation can supply awake continuity.
pub(in crate::actions::native_owner::native_workflows) fn preview_selected_rows(conn:&rusqlite::Connection,opening:&WorkflowOpening,selected:&activation::Activation,now:chrono::DateTime<chrono::Utc>)->Result<Plan,flow::Error>{prepare_rows(conn,opening,selected,Observation::Unknown,now).map(|prepared|prepared.plan)}
fn observation(previous_ms:Option<i64>)->Observation{match previous_ms{Some(previous_ms)=>Observation::Native{previous_ms,same_opening:true,resumed:false},None=>Observation::Unknown}}
fn sweep_job(app:AppHandle,shared:Arc<Shared>,ticket:SweepTicket,ready:Instant)->Job{
 let key=Key::Sweep{opening:ticket.opening.clone()};let running=key.clone();
 Job{key,ready,cancel:Arc::new(||{}),work:Box::new(move|stop|{
  if stop.load(Ordering::SeqCst){return None;}
  // Durable prepare pauses selections, so recovery must precede even an empty
  // enabled-selection page. It uses this exact ticket's opening/storage guard.
  let recovered=ticket.opening.guarded_rows(&app,|owner,recheck|super::super::publication_service::recover_pending_owned(
   owner,ticket.opening.facts(),&ticket.opening.root,ticket.recovery_after.as_deref(),chrono::Utc::now().timestamp_millis(),||{
    if stop.load(Ordering::SeqCst){return Err(flow::Error::Denied);}recheck().map_err(|_|flow::Error::Unavailable)?;if stop.load(Ordering::SeqCst){return Err(flow::Error::Denied);}Ok(())
   }).map_err(action_error));
  let recovered=match recovered{Ok((Ok(value),true))=>value,_=>return None};
  if recovered.next.is_some(){
   let next=SweepTicket{opening:ticket.opening,previous_ms:None,after:ticket.after,recovery_after:recovered.next};
   return Some(sweep_job(app,shared,next,Instant::now()+delay()));
  }
  let now=chrono::Utc::now();let observed=observation(ticket.previous_ms);
  let page=match read(&app,&ticket.opening,|conn|activation::sweep_page_rows(conn,scope(&ticket.opening),ticket.after.as_deref())){Ok(page)=>page,Err(_)=>return None};
  if !sweep_has_work(ticket.after.as_deref(),page.items.is_empty()){return None;}
  let mut after=ticket.after.clone();let mut exhausted=true;
  for selected in page.items{
   if stop.load(Ordering::SeqCst){return None;}
   let prepared=match prepare(&app,&ticket.opening,&selected,observed,chrono::Utc::now()){Ok(prepared)=>prepared,Err(_)=>{after=Some(selected.id);continue;}};
   if prepared.plan.due_ms.is_none(){
    // Unknown coverage may have finite skipped-only progress. Never turn a
    // read-only preview into a write; recompute under the actual owner instead.
    if prepared.plan.cursor_ms>selected.cursor_ms{
     let result=ticket.opening.guarded_rows(&app,|owner,recheck|occurrence::observe_owned_rows(owner,ticket.opening.facts(),&prepared.expected,&prepared.definition,observed,chrono::Utc::now(),||{
      if stop.load(Ordering::SeqCst){return Err(flow::Error::Denied);}recheck().map_err(|_|flow::Error::Unavailable)?;if stop.load(Ordering::SeqCst){return Err(flow::Error::Denied);}Ok(())
     }).map_err(action_error));
     if matches!(result,Ok((_,false)))||ticket.opening.current(&app).is_err(){return None;}
    }
    after=Some(selected.id);continue;
   }
   let(occurrence,_) = match occurrence::occurrence_key(ticket.opening.facts(),&prepared.expected){Ok(value)=>value,Err(_)=>{after=Some(selected.id);continue;}};
   // This is the already-running dispatcher's path: no handle mutex and no
   // native storage held while the queue slot is reserved.
   let reservation=match reserve_running(&shared,&running,stop,ReservationKey{owner:ticket.opening.runtime_seal.clone(),occurrence}){
    Reserved::Held(slot)=>slot,Reserved::Observed=>{after=Some(selected.id);continue;},Reserved::Busy=>{exhausted=false;break;},Reserved::Retired=>return None,
   };
   let claimed=ticket.opening.guarded_rows(&app,|owner,recheck|claim_reserved_owned(owner,ticket.opening.facts(),&prepared.expected,&prepared.definition,observed,chrono::Utc::now(),&reservation,||{
    if stop.load(Ordering::SeqCst){return Err(flow::Error::Denied);}recheck().map_err(|_|flow::Error::Unavailable)?;if stop.load(Ordering::SeqCst){return Err(flow::Error::Denied);}Ok(())
   }).map_err(action_error));
   let (claimed,current)=match claimed{Ok(value)=>value,Err(_)=>{drop(reservation);if ticket.opening.current(&app).is_err(){return None;}after=Some(selected.id);continue;}};
   let claimed=match claimed{Ok(claimed)=>claimed,Err(_)=>{drop(reservation);if !current{return None;}after=Some(selected.id);continue;}};
   // The committed run remains discoverable if Stop/opening loss/physical busy
   // prevents this postcommit installation. Never create a replacement run.
   if !current||stop.load(Ordering::SeqCst){drop(reservation);return None;}
   match claimed.started{
    workflow_rows::Started::Observed(_)=>{drop(reservation);},
    workflow_rows::Started::New(origin)=>{
     match ticket.opening.retain(&app,origin){
      Ok(Some(origin))=>{let wake=WakeTicket::from_origin(origin);let _=transfer_running(&shared,&running,stop,reservation,native_job(app.clone(),wake,Instant::now()));},
      Ok(None)|Err(_)=>drop(reservation),
     }
    }
   }
   after=Some(selected.id);
  }
  if stop.load(Ordering::SeqCst)||ticket.opening.current(&app).is_err(){return None;}
  if exhausted{after=page.next;}
  // Only this real retained ticket carries awake coverage. Persisted timestamps
  // are diagnostics, never restored into this in-memory observation field.
  let next=SweepTicket{opening:ticket.opening,previous_ms:Some(now.timestamp_millis()),after,recovery_after:None};
  Some(sweep_job(app,shared,next,Instant::now()+delay()))
 })}
}
fn install(app:&AppHandle,opening:Arc<WorkflowOpening>)->WorkflowMonitoring{
 if flow::execution_policy().max_workers!=1||opening.current(app).is_err(){return WorkflowMonitoring::Unavailable;}
 let book=book();let ticket=SweepTicket{opening,previous_ms:None,after:None,recovery_after:None};
 match book.submit(sweep_job(app.clone(),book.shared.clone(),ticket,Instant::now())){Admission::Queued=>WorkflowMonitoring::Queued,Admission::Observed=>WorkflowMonitoring::Observed,Admission::Busy=>WorkflowMonitoring::Busy,Admission::Retired=>WorkflowMonitoring::Unavailable}
}
pub(in crate::actions::native_owner::native_workflows) fn install_captured(app:&AppHandle,opening:Arc<WorkflowOpening>)->WorkflowMonitoring{install(app,opening)}
pub(in crate::actions::native_owner::native_workflows) fn state(opening:&Arc<WorkflowOpening>)->WorkflowMonitorState{
 let Some(book)=BOOK.get()else{return WorkflowMonitorState::Stopped;};let Ok(state)=book.shared.state.lock()else{return WorkflowMonitorState::Unavailable;};if state.retired{return WorkflowMonitorState::Unavailable;}
 let key=Key::Sweep{opening:opening.clone()};
 if state.running.as_ref().is_some_and(|running|running.key==key&&!running.stop.load(Ordering::SeqCst))||state.queue.iter().any(|job|job.key==key){WorkflowMonitorState::Watching}else{WorkflowMonitorState::Stopped}
}
/// Successful original start_watcher publication calls this after native bind.
/// The opaque attempt comparison finishes before entering the worker book.
pub(crate) fn opened(app:&AppHandle,window:&WebviewWindow,attempt:&crate::workspace_service::authority::OpeningAttempt)->Result<WorkflowMonitoring,ActionError>{
 let opening=WorkflowOpening::capture(app,window)?;
 opening.context.with_published_legacy_attempt(attempt,&opening.root,||()).map_err(|_|kernel::unavailable())?;
 Ok(install(app,opening))
}
/// Explicit Resume monitoring. No Enable, epoch, permission pin or row mutation.
pub(crate) fn workflow_schedule_wake(app:&AppHandle,window:&WebviewWindow,requested:WorkflowContext)->Result<WorkflowScheduleMonitorAck,WorkflowError>{
 let opening=commands::bound(app,window,&requested)?;let context=commands::observed(&opening);let monitoring=install(app,opening);Ok(WorkflowScheduleMonitorAck{context,monitoring})
}
