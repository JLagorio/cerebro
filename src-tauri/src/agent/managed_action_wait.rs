//! Original-call wait controls and safe views only. No native/ACT authority.
use super::*;
use std::{collections::{BTreeMap,BTreeSet},sync::{Weak,mpsc,atomic::{AtomicBool,Ordering}},time::{Duration,Instant}};
#[derive(Debug,Clone,PartialEq,Eq)]
pub(crate) enum ManagedClose{Cancelled,Expired,OwnerGone}
pub(crate) enum ManagedReceive{Proposal(ManagedProposal),AccessCompleted,Closed(ManagedClose),Timeout}
enum Message{Proposal(ManagedProposal),AccessCompleted,Closed(ManagedClose)}
#[derive(Clone,Copy,PartialEq,Eq)]
enum Phase{Waiting,Answering,Answered,Closed}
enum Purpose{Effect(String),Access}
struct Held {
 run:String,purpose:Purpose,vault:PathBuf,card:InteractionCard,deadline:Instant,
 phase:Phase,token:Option<String>,wake:mpsc::Sender<Message>,
 reply:Option<mpsc::Sender<Result<(),Refusal>>>,cancelled:Arc<AtomicBool>,
 // Actual request correlation is set by the admitted native RPC owner. It is
 // control metadata only, never a source of native or effect authority.
 rpc:Option<String>,
}
#[derive(Default)]
pub(super) struct ManagedBook{held:BTreeMap<String,Held>,retired:bool,closed_runs:BTreeSet<String>}
fn close(entry:&mut Held,reason:ManagedClose){
 if entry.phase==Phase::Closed{return;}entry.phase=Phase::Closed;entry.token=None;
 entry.cancelled.store(true,Ordering::SeqCst);
 if let Some(reply)=entry.reply.take(){let _=reply.send(Err(Refusal::no_longer_waiting()));}
 let _=entry.wake.send(Message::Closed(reason));
}
fn managed_lock(book:&Mutex<ManagedBook>)->MutexGuard<'_,ManagedBook>{
 match book.lock(){Ok(guard)=>guard,Err(poison)=>{let mut guard=poison.into_inner();guard.retired=true;for entry in guard.held.values_mut(){close(entry,ManagedClose::OwnerGone);}guard}}
}
pub(crate) struct ManagedCall{id:String,book:Weak<Mutex<ManagedBook>>,receive:mpsc::Receiver<Message>,cancelled:Arc<AtomicBool>}
impl ManagedCall{
 pub(crate) fn id(&self)->&str{&self.id}
 pub(crate) fn cancelled(&self)->Arc<AtomicBool>{self.cancelled.clone()}
 pub(crate) fn bind_rpc(&self,key:String)->bool{
  let Some(book)=self.book.upgrade()else{return false;};let mut book=managed_lock(&book);if book.retired{return false;}
  let Some(entry)=book.held.get_mut(&self.id)else{return false;};if entry.rpc.is_some()||entry.phase==Phase::Closed{return false;}entry.rpc=Some(key);true
 }
 pub(crate) fn receive(&self,timeout:Duration)->ManagedReceive{
  match self.receive.recv_timeout(timeout){Ok(Message::Proposal(proposal))=>ManagedReceive::Proposal(proposal),Ok(Message::AccessCompleted)=>ManagedReceive::AccessCompleted,Ok(Message::Closed(reason))=>ManagedReceive::Closed(reason),Err(mpsc::RecvTimeoutError::Timeout)=>ManagedReceive::Timeout,Err(mpsc::RecvTimeoutError::Disconnected)=>ManagedReceive::Closed(ManagedClose::OwnerGone)}
 }
}
impl Drop for ManagedCall{
 fn drop(&mut self){if let Some(book)=self.book.upgrade(){if let Some(mut entry)=managed_lock(&book).held.remove(&self.id){close(&mut entry,ManagedClose::OwnerGone);}}}
}
pub(crate) struct ManagedProposal{pub(crate) answer:PersonAnswer,pub(crate) edited_input:Option<Value>,id:String,token:String,book:Weak<Mutex<ManagedBook>>}
impl ManagedProposal{
 pub(crate) fn finish(self,result:Result<(),Refusal>)->bool{
  let Some(book)=self.book.upgrade()else{return false;};let mut book=managed_lock(&book);if book.retired{return false;}
  let Some(entry)=book.held.get_mut(&self.id)else{return false;};
  if entry.phase!=Phase::Answering||entry.token.as_deref()!=Some(&self.token){return false;}
  if Instant::now()>=entry.deadline{close(entry,ManagedClose::Expired);return false;}
  let reply=entry.reply.take();entry.token=None;
  // The original worker alone calls this after its ACT transaction outcome.
  // A refusal leaves the same safe card waiting; success hides only the card.
  // The call-control entry/flag stays retained until HTTP cleanup+RPC disposal.
  entry.phase=if result.is_ok(){Phase::Answered}else{Phase::Waiting};drop(book);
  if let Some(reply)=reply{let _=reply.send(result);}true
 }
}
pub(crate) struct ManagedAnswerPending{receive:mpsc::Receiver<Result<(),Refusal>>}
impl ManagedAnswerPending{pub(crate) fn receive(self,timeout:Duration)->Option<Result<(),Refusal>>{self.receive.recv_timeout(timeout).ok()}}
impl Interactions{
 /// The same original call survives an edited approval. Seats and managed
 /// controls share one book->managed linearization; no cancellation gap exists.
 pub(crate) fn replace_managed_card(&self,call:&mut ManagedCall,mut card:InteractionCard,deadline:Instant)->bool{
  let Some(owned)=call.book.upgrade()else{return false;};if !Arc::ptr_eq(&owned,&self.managed){return false;}
  let seats=lock(&self.book);let mut book=managed_lock(&self.managed);if book.retired||call.cancelled.load(Ordering::SeqCst){return false;}
  let Some(entry)=book.held.get(&call.id)else{return false;};
  if entry.phase!=Phase::Answered||!matches!(entry.purpose,Purpose::Effect(_))||!Arc::ptr_eq(&entry.cancelled,&call.cancelled)||book.closed_runs.contains(&entry.run)||card.kind!=Kind::ManagedAction||!card.tool_id.is_empty()||card.id.len()!=32||card.id==call.id||card.input.len()>CARD_INPUT_BYTES||card.session_id!=entry.card.session_id||card.run!=entry.card.run||book.held.contains_key(&card.id)||deadline<=Instant::now(){return false;}
  if !seats.seats.get(&entry.run).is_some_and(|seat|seat.vault==entry.vault&&seat.session_id==card.session_id){return false;}
  let Some(mut entry)=book.held.remove(&call.id)else{return false;};
  if Instant::now()>=entry.deadline{close(&mut entry,ManagedClose::Expired);book.held.insert(call.id.clone(),entry);return false;}
  // Keep the actual RPC key, channel, flag, original purpose/invocation and
  // finite original deadline. Only the visible approval card identity changes.
  entry.deadline=entry.deadline.min(deadline);card.answering=Some(false);entry.card=card;entry.phase=Phase::Waiting;entry.token=None;entry.reply=None;
  call.id=entry.card.id.clone();book.held.insert(call.id.clone(),entry);drop(book);drop(seats);true
 }

 pub(crate) fn hold_managed_access(&self,run:&str,vault:&Path,card:InteractionCard,deadline:Instant)->Result<ManagedCall,Refusal>{self.hold_managed_purpose(run,Purpose::Access,vault,card,deadline)}
 pub(crate) fn managed_access_request(&self,run:&str)->Option<String>{let book=managed_lock(&self.managed);book.held.iter().find(|(_,entry)|entry.run==run&&matches!(entry.purpose,Purpose::Access)&&entry.phase==Phase::Waiting&&Instant::now()<entry.deadline).map(|(id,_)|id.clone())}
 /// Called by the actual original-run grant writer only after known commit.
 /// This acknowledges access selection, including empty selection, never an effect.
 pub(crate) fn complete_managed_access(&self,run:&str,id:&str)->bool{
  let mut book=managed_lock(&self.managed);if book.retired{return false;}let Some(entry)=book.held.get_mut(id)else{return false;};
  if entry.run!=run||!matches!(entry.purpose,Purpose::Access)||entry.phase!=Phase::Waiting{return false;}
  if Instant::now()>=entry.deadline{close(entry,ManagedClose::Expired);return false;}
  entry.phase=Phase::Answered;
  if entry.wake.send(Message::AccessCompleted).is_err(){close(entry,ManagedClose::OwnerGone);return false;}true
 }

 pub(crate) fn hold_managed(&self,run:&str,invocation:&str,vault:&Path,card:InteractionCard,deadline:Instant)->Result<ManagedCall,Refusal>{
  if invocation.len()!=32{return Err(Refusal::no_longer_waiting());}
  self.hold_managed_purpose(run,Purpose::Effect(invocation.into()),vault,card,deadline)
 }
 fn hold_managed_purpose(&self,run:&str,purpose:Purpose,vault:&Path,card:InteractionCard,deadline:Instant)->Result<ManagedCall,Refusal>{
  // Hold the actual source-seat guard through registration. Every retirement
  // path takes book then managed; no current-source/authority call occurs here.
  let seats=lock(&self.book);
  let seated=seats.seats.get(run).is_some_and(|seat|seat.vault==vault&&seat.session_id==card.session_id)&&!seats.entries.iter().any(|entry|entry.id==card.id);
  let correct_kind=matches!((&purpose,card.kind),(Purpose::Effect(_),Kind::ManagedAction)|(Purpose::Access,Kind::ManagedAccess));
  if !seated||!correct_kind||!card.tool_id.is_empty()||card.id.len()!=32||card.input.len()>CARD_INPUT_BYTES||deadline<=Instant::now(){return Err(Refusal::no_longer_waiting());}
  #[cfg(test)] probes::after_hold_check();
  let mut book=managed_lock(&self.managed);if book.retired||book.closed_runs.contains(run)||book.held.contains_key(&card.id)||book.held.values().any(|entry|entry.run==run&&entry.phase!=Phase::Closed)||book.held.len()>=super::super::MAX_CONCURRENT_RUNS{return Err(Refusal::no_longer_waiting());}
  let(wake,receive)=mpsc::channel();let cancelled=Arc::new(AtomicBool::new(false));let id=card.id.clone();
  book.held.insert(id.clone(),Held{run:run.into(),purpose,vault:vault.into(),card,deadline,phase:Phase::Waiting,token:None,wake,reply:None,cancelled:cancelled.clone(),rpc:None});
  let call=ManagedCall{id,book:Arc::downgrade(&self.managed),receive,cancelled};
  drop(book);drop(seats);Ok(call)
 }
 pub(crate) fn propose_managed(&self,vault:&Path,id:&str,answer:PersonAnswer,edited_input:Option<Value>)->Result<ManagedAnswerPending,Refusal>{
  let mut book=managed_lock(&self.managed);if book.retired{return Err(Refusal::no_longer_waiting());}
  let Some(entry)=book.held.get_mut(id)else{return Err(Refusal::no_longer_waiting());};
  if entry.vault!=vault||!matches!(entry.purpose,Purpose::Effect(_))||entry.phase!=Phase::Waiting{return Err(Refusal::no_longer_waiting());}
  if Instant::now()>=entry.deadline{close(entry,ManagedClose::Expired);return Err(Refusal::no_longer_waiting());}
  if answer.managed_choice().is_none()||edited_input.is_some()&&answer.managed_choice()!=Some(true){return Err(Refusal::malformed("This action takes Allow once or Deny; only Allow may carry an edited input."));}
  let(reply,receive)=mpsc::channel();let token=crate::ledger::new_id128();entry.phase=Phase::Answering;entry.token=Some(token.clone());entry.reply=Some(reply);
  let proposal=ManagedProposal{answer,edited_input,id:id.into(),token,book:Arc::downgrade(&self.managed)};
  if entry.wake.send(Message::Proposal(proposal)).is_err(){close(entry,ManagedClose::OwnerGone);return Err(Refusal::no_longer_waiting());}
  Ok(ManagedAnswerPending{receive})
 }
 pub(crate) fn expire_managed(&self,now:Instant){let mut book=managed_lock(&self.managed);for entry in book.held.values_mut(){if now>=entry.deadline{close(entry,ManagedClose::Expired);}}}
 pub(crate) fn managed_pending(&self,vault:&Path)->Vec<InteractionCard>{let book=managed_lock(&self.managed);book.held.values().filter(|entry|entry.vault==vault&&matches!(entry.phase,Phase::Waiting|Phase::Answering)).map(|entry|{let mut card=entry.card.clone();card.answering=Some(entry.phase==Phase::Answering);card}).collect()}
 pub(crate) fn has_managed(&self,vault:&Path,id:&str)->bool{let book=managed_lock(&self.managed);book.held.get(id).is_some_and(|entry|entry.vault==vault&&matches!(entry.phase,Phase::Waiting|Phase::Answering))}
 pub(crate) fn managed_invocation(&self,vault:&Path,id:&str)->Option<(String,String)>{let book=managed_lock(&self.managed);let entry=book.held.get(id)?;if entry.vault!=vault||!matches!(entry.phase,Phase::Waiting|Phase::Answering){return None;}match &entry.purpose{Purpose::Effect(invocation)=>Some((entry.run.clone(),invocation.clone())),Purpose::Access=>None}}
 pub(crate) fn cancel_managed(&self,id:&str)->bool{let mut book=managed_lock(&self.managed);let Some(entry)=book.held.get_mut(id)else{return false;};if !matches!(entry.phase,Phase::Waiting|Phase::Answering){return false;}close(entry,ManagedClose::Cancelled);true}
 pub(crate) fn close_managed_run(&self,run:&str){let mut book=managed_lock(&self.managed);book.closed_runs.remove(run);for entry in book.held.values_mut().filter(|entry|entry.run==run){close(entry,ManagedClose::OwnerGone);}}
 pub(crate) fn cancel_managed_other_vaults(&self,vault:&Path,retired_runs:&[String])->Vec<String>{let mut book=managed_lock(&self.managed);book.closed_runs.extend(retired_runs.iter().cloned());let mut ids=Vec::new();for(id,entry)in book.held.iter_mut().filter(|(_,entry)|entry.vault!=vault){if entry.phase!=Phase::Closed{ids.push(id.clone());close(entry,ManagedClose::Cancelled);}}ids}
 pub(crate) fn cancel_managed_all(&self){let mut book=managed_lock(&self.managed);book.closed_runs.clear();for entry in book.held.values_mut(){close(entry,ManagedClose::Cancelled);}}
 /// Called only after the native RPC router rechecks the actual matched
 /// publication for this run. Scope/body selectors cannot acquire this owner.
 pub(crate) fn cancel_managed_rpc(&self,run:&str,rpc_key:&str)->bool{let mut book=managed_lock(&self.managed);let Some(entry)=book.held.values_mut().find(|entry|entry.run==run&&entry.rpc.as_deref()==Some(rpc_key))else{return false;};if entry.phase==Phase::Closed{return false;}close(entry,ManagedClose::Cancelled);true}
}
#[cfg(test)]
#[path="managed_action_wait_tests.rs"]
mod tests;

#[cfg(test)]
pub(super) mod probes {
 use std::cell::RefCell;
 thread_local!{static HOLD:RefCell<Option<Box<dyn FnOnce()>>>=RefCell::new(None);static ALL:RefCell<Option<Box<dyn FnOnce()>>>=RefCell::new(None);static OTHER:RefCell<Option<Box<dyn FnOnce()>>>=RefCell::new(None);}
 pub(super) fn on_hold(probe:Box<dyn FnOnce()>){HOLD.with(|slot|*slot.borrow_mut()=Some(probe));}
 pub(super) fn on_all(probe:Box<dyn FnOnce()>){ALL.with(|slot|*slot.borrow_mut()=Some(probe));}
 pub(super) fn on_other(probe:Box<dyn FnOnce()>){OTHER.with(|slot|*slot.borrow_mut()=Some(probe));}
 pub(super) fn after_hold_check(){HOLD.with(|slot|{let probe=slot.borrow_mut().take();if let Some(probe)=probe{probe();}});}
 pub(in crate::agent::interaction) fn after_all_scan(){ALL.with(|slot|{let probe=slot.borrow_mut().take();if let Some(probe)=probe{probe();}});}
 pub(in crate::agent::interaction) fn after_other_scan(){OTHER.with(|slot|{let probe=slot.borrow_mut().take();if let Some(probe)=probe{probe();}});}
}
