//! Private bounded worker ownership. Production jobs close over native wake tickets.
use std::{collections::VecDeque,sync::{Arc,Mutex,Condvar,atomic::{AtomicBool,Ordering}},thread::JoinHandle,time::{Duration,Instant}};
#[derive(Clone)]
enum Key {Run{owner:Arc<()>,run:String,epoch:u64},Sweep{opening:Arc<WorkflowOpening>}}
impl Key{fn owner(&self)->&Arc<()>{match self{Self::Run{owner,..}=>owner,Self::Sweep{opening}=>&opening.runtime_seal}}}
impl PartialEq for Key{fn eq(&self,other:&Self)->bool{match(self,other){
 (Self::Run{owner:a,run:ar,epoch:ae},Self::Run{owner:b,run:br,epoch:be})=>Arc::ptr_eq(a,b)&&ar==br&&ae==be,
 (Self::Sweep{opening:a},Self::Sweep{opening:b})=>Arc::ptr_eq(&a.runtime_seal,&b.runtime_seal)&&a.opening.same_as(&b.opening),
 _=>false,
}}}
impl Eq for Key{}
struct Job {key:Key,ready:Instant,cancel:Arc<dyn Fn()+Send+Sync>,work:Box<dyn FnOnce(&AtomicBool)->Option<Job>+Send>}
struct Running {key:Key,stop:Arc<AtomicBool>,cancel:Arc<dyn Fn()+Send+Sync>}
struct State {queue:VecDeque<Job>,running:Option<Running>,reservations:Vec<ReservationRecord>,retired:bool,not_before:Instant}
struct Shared {state:Mutex<State>,changed:Condvar,capacity:usize,minimum_interval:Duration}
struct OwnedBook {shared:Arc<Shared>,thread:Mutex<Option<JoinHandle<()>>>}
#[derive(Debug,PartialEq,Eq)]
enum Admission {Queued,Observed,Busy,Retired}
impl OwnedBook {
 #[cfg(test)]
 fn new(capacity:usize)->Self{Self::with_interval(capacity,Duration::ZERO)}
 fn with_interval(capacity:usize,minimum_interval:Duration)->Self{Self{shared:Arc::new(Shared{state:Mutex::new(State{queue:VecDeque::new(),running:None,reservations:Vec::new(),retired:false,not_before:Instant::now()}),changed:Condvar::new(),capacity,minimum_interval}),thread:Mutex::new(None)}}
 fn submit(&self,job:Job)->Admission{
  // Lock order is handle then queue; the dispatcher only takes the queue lock.
  let mut thread=self.thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
  if !self.reap_finished(&mut thread){return Admission::Retired;}
  let mut state=self.shared.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
  if state.retired{return Admission::Retired;}
  if state.running.as_ref().is_some_and(|running|running.key==job.key)||state.queue.iter().any(|queued|queued.key==job.key){return Admission::Observed;}
  if state.queue.len()+usize::from(state.running.is_some())+state.reservations.len()>=self.shared.capacity{return Admission::Busy;}
  self.queue_locked(&mut thread,&mut state,job)
 }
 fn reap_finished(&self,thread:&mut Option<JoinHandle<()>>)->bool{
  if thread.as_ref().is_some_and(JoinHandle::is_finished){if let Some(previous)=thread.take(){if previous.join().is_err(){self.stop_inner(true);return false;}}}true
 }
 fn queue_locked(&self,thread:&mut Option<JoinHandle<()>>,state:&mut State,job:Job)->Admission{
  state.queue.push_back(job);
  if thread.is_none(){let shared=self.shared.clone();match std::thread::Builder::new().name("cerebro-workflows".into()).spawn(move||run(shared)){
   Ok(started)=>*thread=Some(started),Err(_)=>{state.queue.pop_back();return Admission::Busy;}
  }}
  self.shared.changed.notify_all();Admission::Queued
 }
 fn stop_inner(&self,retire:bool){
  let cancellation={let mut state=self.shared.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);state.retired|=retire;state.queue.clear();for slot in &state.reservations{slot.token.live.store(false,Ordering::SeqCst);}state.reservations.clear();let cancellation=state.running.as_ref().map(|running|{running.stop.store(true,Ordering::SeqCst);running.cancel.clone()});self.shared.changed.notify_all();cancellation};
  // Only the original atomic cancellation book is notified, with no storage or
  // authority lock taken while the workflow queue mutex is held.
  if let Some(cancel)=cancellation{cancel();}
 }
 fn stop(&self){self.stop_inner(false);}
 fn shutdown(&self){
  let mut thread=self.thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner);self.stop_inner(true);
  if let Some(thread)=thread.take(){let _=thread.join();}
 }
}
impl Drop for OwnedBook {fn drop(&mut self){self.shutdown();}}
fn run(shared:Arc<Shared>){
 loop{
  let(job,stop)={
   let mut state=shared.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
   loop{
    if state.retired{return;}
    let now=Instant::now();
    if now>=state.not_before{if let Some(index)=state.queue.iter().position(|job|job.ready<=now){
     let job=state.queue.remove(index).expect("selected queued job");let stop=Arc::new(AtomicBool::new(false));state.running=Some(Running{key:job.key.clone(),stop:stop.clone(),cancel:job.cancel.clone()});break(job,stop);
    }}
    if let Some(next)=state.queue.iter().map(|job|job.ready.max(state.not_before)).min(){let duration=next.saturating_duration_since(now);state=shared.changed.wait_timeout(state,duration).unwrap_or_else(std::sync::PoisonError::into_inner).0;}else{state=shared.changed.wait(state).unwrap_or_else(std::sync::PoisonError::into_inner);}
   }
  };
  let key=job.key;
  // A failed job unwinds and drops its genuine origin/leases before any next
  // job starts. The dispatcher itself remains retained until shutdown joins.
  let next=if stop.load(Ordering::SeqCst){None}else{std::panic::catch_unwind(std::panic::AssertUnwindSafe(||(job.work)(&stop))).ok().flatten()};
  let mut state=shared.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
  state.running=None;state.not_before=Instant::now()+shared.minimum_interval;
  if !state.retired&&!stop.load(Ordering::SeqCst){if let Some(next)=next{if next.key==key{state.queue.push_back(next);}}}
  shared.changed.notify_all();
 }
}

// The only production job producer takes a genuine origin. Idle tickets retain
// opening/immutable admission metadata, never an execution lease or scope factory.
use super::{CurrentWorkflowOrigin,WorkflowOpening,workflow_rows,kernel,action_error};
use super::super::native_actions::operations;
use crate::{actions::effect_types::{ActionError,ActionErrorCode},runtime::workflows as flow};
use rusqlite::{OptionalExtension,params};
use tauri::AppHandle;
#[derive(Clone)]
struct WakeTicket {opening:Arc<WorkflowOpening>,origin:workflow_rows::Origin}
impl WakeTicket {
 fn from_origin(origin:CurrentWorkflowOrigin)->Self{Self{opening:origin.opening.clone(),origin:origin.origin.clone()}}
 fn key(&self)->Key{Key::Run{owner:self.opening.runtime_seal.clone(),run:self.origin.flow_run.clone(),epoch:self.origin.epoch}}
}
fn delay()->Duration{Duration::from_millis(flow::execution_policy().minimum_wake_interval_ms)}
fn native_job(app:AppHandle,ticket:WakeTicket,ready:Instant)->Job{
 let key=ticket.key();let cancellation=ticket.opening.owner.action_cancellations.clone();let native=ticket.origin.native_run.clone();
 Job{key,ready,cancel:Arc::new(move||cancellation.cancel_run(&native)),work:Box::new(move|stop|{
  let origin=match ticket.opening.retain(&app,ticket.origin.clone()){Ok(Some(origin))=>origin,Ok(None)=>return Some(native_job(app,ticket,Instant::now()+delay())),Err(_)=>return None};
  let pass=match super::pass::drive(&app,&origin,stop){Ok(pass)=>pass,Err(_)=>return None};
  if stop.load(Ordering::SeqCst)||pass.run.cancel_requested{return None;}
  let ready=if pass.yielded&&pass.run.state=="queued"{Some(Instant::now()+delay())}else if pass.run.state=="waiting"{
   // Only an actual durable timer produces an automatic wake. Human approvals,
   // external input and unresolved effects wait for their own native controls.
   let due=operations::with_workflow_inspection(&app,&origin,|read,_,_|{
    let current=flow::inspect_rows(read.conn,origin.scope(),&pass.run.id).map_err(action_error)?;if current!=pass.run{return Err(kernel::stale());}
    timer_due_rows(read.conn,&current)
   }).ok().flatten();
   due.map(|due|{let milliseconds=u64::try_from(due.saturating_sub(chrono::Utc::now().timestamp_millis())).unwrap_or(0);{let now=Instant::now();now.checked_add(Duration::from_millis(milliseconds).max(delay())).unwrap_or(now+delay())}})
  }else{None};
  // Dropping origin releases WorkflowExecution before the idle ticket queues.
  drop(origin);ready.map(|ready|native_job(app,ticket,ready))
 })}
}
// Process ownership is independent of job-held AppHandles. Exit explicitly
// retires and joins this dispatcher before closing the original app session.
static BOOK:std::sync::OnceLock<OwnedBook>=std::sync::OnceLock::new();
fn book()->&'static OwnedBook{BOOK.get_or_init(||{let policy=flow::execution_policy();OwnedBook::with_interval(policy.max_queued_runs,delay())})}
pub(in crate::actions::native_owner) fn enqueue(app:&AppHandle,origin:CurrentWorkflowOrigin)->Result<bool,ActionError>{
 if flow::execution_policy().max_workers!=1{return Err(kernel::unavailable());}
 let ticket=WakeTicket::from_origin(origin);
 match book().submit(native_job(app.clone(),ticket,Instant::now())){Admission::Queued|Admission::Observed=>Ok(true),Admission::Busy=>Ok(false),Admission::Retired=>Err(crate::actions::read_types::error(ActionErrorCode::Unavailable,"Workflow worker is unavailable."))}
}
pub(in crate::actions::native_owner) fn stop(_app:&AppHandle){if let Some(book)=BOOK.get(){book.stop();}}
pub(in crate::actions::native_owner) fn shutdown(_app:&AppHandle){if let Some(book)=BOOK.get(){book.shutdown();}}
#[cfg(test)]
#[path="native_workflow_worker_tests.rs"]
mod tests;

/// Plain observed timer metadata; the native caller owns admission around this read.
pub(in crate::actions::native_owner) fn timer_due_rows(conn:&rusqlite::Connection,run:&flow::Run)->Result<Option<i64>,ActionError>{
 conn.query_row("SELECT w.due_at FROM workflow_waits w JOIN workflow_steps s ON s.run_id=w.run_id AND s.step_id=w.step_id AND s.attempt_ordinal=w.attempt_ordinal WHERE w.run_id=?1 AND w.step_id=?2 AND w.kind='timer' AND w.state='pending'",params![run.id,run.cursor],|row|row.get(0)).optional().map_err(|_|kernel::unavailable())
}

// Automatic occurrence admission reserves process capacity before durable run
// creation. This is never a native origin, grant, run ID or execution lease.
#[derive(Clone)]
struct ReservationKey{owner:Arc<()>,occurrence:String}
impl PartialEq for ReservationKey{fn eq(&self,other:&Self)->bool{Arc::ptr_eq(&self.owner,&other.owner)&&self.occurrence==other.occurrence}}
impl Eq for ReservationKey{}
struct ReservationToken{live:AtomicBool}
struct Reservation{shared:Arc<Shared>,key:ReservationKey,token:Arc<ReservationToken>}
enum Reserved{Held(Reservation),Observed,Busy,Retired}
#[derive(Debug,PartialEq,Eq)]
enum Transfer{Queued,Observed,Busy,Retired,Rejected}
struct ReservationRecord{key:ReservationKey,token:Arc<ReservationToken>}
fn reserve_locked(shared:&Arc<Shared>,state:&mut State,key:ReservationKey)->Reserved{
 if state.retired{return Reserved::Retired;}
 if state.reservations.iter().any(|slot|slot.key==key){return Reserved::Observed;}
 if state.queue.len()+usize::from(state.running.is_some())+state.reservations.len()>=shared.capacity{return Reserved::Busy;}
 let token=Arc::new(ReservationToken{live:AtomicBool::new(true)});state.reservations.push(ReservationRecord{key:key.clone(),token:token.clone()});
 Reserved::Held(Reservation{shared:shared.clone(),key,token})
}
/// One state-locked transfer checker shared by external submission and the
/// already-owned dispatcher. Consume only this exact still-live token.
fn take_reserved(shared:&Arc<Shared>,state:&mut State,reservation:&Reservation,job:&Job)->Result<(),Transfer>{
 if !Arc::ptr_eq(shared,&reservation.shared)||!Arc::ptr_eq(&reservation.key.owner,job.key.owner()){return Err(Transfer::Rejected);}
 if state.retired{return Err(Transfer::Retired);}
 if !reservation.token.live.load(Ordering::SeqCst){return Err(Transfer::Rejected);}
 let Some(index)=state.reservations.iter().position(|slot|slot.key==reservation.key&&Arc::ptr_eq(&slot.token,&reservation.token))else{return Err(Transfer::Rejected);};
 state.reservations.remove(index);reservation.token.live.store(false,Ordering::SeqCst);
 if state.running.as_ref().is_some_and(|running|running.key==job.key)||state.queue.iter().any(|queued|queued.key==job.key){return Err(Transfer::Observed);}
 if state.queue.len()+usize::from(state.running.is_some())+state.reservations.len()>=shared.capacity{return Err(Transfer::Busy);}Ok(())
}
impl OwnedBook{
 fn reserve(&self,key:ReservationKey)->Reserved{
  // External admission retains the handle-before-state order and accounts for
  // a previously failed dispatcher before reserving any new process capacity.
  let mut thread=self.thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
  if !self.reap_finished(&mut thread){return Reserved::Retired;}
  let mut state=self.shared.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
  reserve_locked(&self.shared,&mut state,key)
 }
 fn submit_reserved(&self,reservation:Reservation,job:Job)->Transfer{
  let result=self.transfer_reserved(&reservation,job);drop(reservation);result
 }
 fn transfer_reserved(&self,reservation:&Reservation,job:Job)->Transfer{
  if !Arc::ptr_eq(&self.shared,&reservation.shared)||!Arc::ptr_eq(&reservation.key.owner,job.key.owner()){return Transfer::Rejected;}
  let mut thread=self.thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
  if !self.reap_finished(&mut thread){return Transfer::Retired;}
  let mut state=self.shared.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
  if let Err(outcome)=take_reserved(&self.shared,&mut state,reservation,&job){return outcome;}
  match self.queue_locked(&mut thread,&mut state,job){Admission::Queued=>Transfer::Queued,Admission::Observed=>Transfer::Observed,Admission::Busy=>Transfer::Busy,Admission::Retired=>Transfer::Retired}
 }
}
impl Drop for Reservation{
 fn drop(&mut self){
  self.token.live.store(false,Ordering::SeqCst);
  let mut state=self.shared.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
  state.reservations.retain(|slot|slot.key!=self.key||!Arc::ptr_eq(&slot.token,&self.token));
  self.shared.changed.notify_all();
 }
}

/// The genuine automatic producer reserves before taking native storage. Under
/// storage this borrows immutable identity and a live atomic only; no queue or
/// JoinHandle lock can enter the actual original claim transaction.
#[expect(clippy::too_many_arguments,reason="original automatic claim keeps retained ownership and captured facts explicit")]
fn claim_reserved_owned(owner:&mut super::RuntimeOwner,facts:workflow_rows::OpeningFacts<'_>,expected:&super::occurrence::Expected,definition:&crate::workflows::native_definition::NativeDefinition,observation:crate::workflows::schedule::Observation,now:chrono::DateTime<chrono::Utc>,reservation:&Reservation,recheck:impl Fn()->Result<(),flow::Error>)->Result<super::occurrence::Claimed,flow::Error>{
 let(occurrence,_)=super::occurrence::occurrence_key(facts,expected)?;
 if !Arc::ptr_eq(&owner.runtime_seal,&reservation.key.owner)||reservation.key.occurrence!=occurrence{return Err(flow::Error::Denied);}
 super::occurrence::claim_owned_rows(owner,facts,expected,definition,observation,now,||{
  if !reservation.token.live.load(Ordering::SeqCst){return Err(flow::Error::Denied);}
  recheck()?;
  if !reservation.token.live.load(Ordering::SeqCst){return Err(flow::Error::Denied);}Ok(())
 })
}
#[cfg(test)]
#[path="native_workflow_auto_claim_tests.rs"]
mod auto_claim_tests;

/// Exact running token identity, not just a reusable queue key. Called only
/// under the Shared mutex, with no native storage or JoinHandle lock held.
fn running_current(state:&State,running:&Key,stop:&AtomicBool)->bool{
 !state.retired&&!stop.load(Ordering::SeqCst)&&state.running.as_ref().is_some_and(|actual|actual.key==*running&&std::ptr::eq(actual.stop.as_ref(),stop))
}
/// The active dispatcher cannot acquire its own JoinHandle mutex: shutdown may
/// hold that mutex while joining this very work. It already owns the thread.
fn reserve_running(shared:&Arc<Shared>,running:&Key,stop:&AtomicBool,key:ReservationKey)->Reserved{
 let mut state=shared.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
 if !running_current(&state,running,stop)||!Arc::ptr_eq(running.owner(),&key.owner){return Reserved::Retired;}
 reserve_locked(shared,&mut state,key)
}
fn transfer_running(shared:&Arc<Shared>,running:&Key,stop:&AtomicBool,reservation:Reservation,job:Job)->Transfer{
 let result=transfer_running_borrowed(shared,running,stop,&reservation,job);
 // Drop may take Shared, so it must follow the inner state guard's destruction.
 drop(reservation);result
}
fn transfer_running_borrowed(shared:&Arc<Shared>,running:&Key,stop:&AtomicBool,reservation:&Reservation,job:Job)->Transfer{
 let mut state=shared.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
 if !running_current(&state,running,stop){return Transfer::Retired;}
 if !Arc::ptr_eq(running.owner(),&reservation.key.owner){return Transfer::Rejected;}
 if let Err(outcome)=take_reserved(shared,&mut state,reservation,&job){return outcome;}
 state.queue.push_back(job);shared.changed.notify_all();Transfer::Queued
}

#[path="native_workflow_monitor.rs"]
pub(in crate::actions::native_owner) mod monitor;

/// A continuation may wrap to earlier selections; an empty initial scan is idle.
fn sweep_has_work(after:Option<&str>,page_empty:bool)->bool{!page_empty||after.is_some()}
