//! One original run's sequenced live/journal writer. No native authority maker.
use super::{journal::Journal,tag,AgentEvent,TaggedEvent};
use std::sync::{Arc,Mutex};
pub(super) struct RunEvents{run:u64,journal:Arc<Journal>,journaled:bool,sequence:Mutex<Option<u64>>,deliver:Box<dyn Fn(TaggedEvent)+Send+Sync>}
impl RunEvents{
 pub(super) fn new(run:u64,journal:Arc<Journal>,journaled:bool,deliver:impl Fn(TaggedEvent)+Send+Sync+'static)->Self{Self{run,journal,journaled,sequence:Mutex::new(Some(0)),deliver:Box::new(deliver)}}
 pub(super) fn send(&self,event:AgentEvent)->bool{
  let mut sequence=match self.sequence.lock(){Ok(sequence)=>sequence,Err(poison)=>{*poison.into_inner()=None;return false;}};
  let Some(previous)=*sequence else{return false;};let Some(next)=previous.checked_add(1)else{*sequence=None;return false;};
  let terminal=matches!(event,AgentEvent::Done);let tagged=tag(&self.journal,self.journaled,self.run,next,event);
  *sequence=if terminal{None}else{Some(next)};
  // Ordering and Done closure stay atomic across both the original reader and
  // its original-receipt-bound managed wait publisher. No event follows Done.
  (self.deliver)(tagged);true
 }
}

#[cfg(test)]
mod tests{
 use super::*;
 use std::{collections::HashSet,path::Path,sync::{Arc,Mutex},time::Instant};
 fn writer()->(Arc<RunEvents>,Arc<Mutex<Vec<TaggedEvent>>>,Arc<Journal>){let journal=Arc::new(Journal::default());journal.open(8,"original",Path::new("/original"),"session",Instant::now(),&HashSet::new());let seen=Arc::new(Mutex::new(Vec::new()));let sink=seen.clone();(Arc::new(RunEvents::new(8,journal.clone(),true,move|event|sink.lock().unwrap().push(event))),seen,journal)}
 #[test]
 fn original_reader_and_wait_publisher_share_one_journal_cursor(){let(writer,seen,journal)=writer();assert!(writer.send(AgentEvent::TextDelta{text:"original".into()}));assert!(writer.send(AgentEvent::Cancelled));assert!(writer.send(AgentEvent::Done));let delivered=seen.lock().unwrap().clone();assert_eq!(delivered.iter().map(|event|(event.run,event.seq)).collect::<Vec<_>>(),vec![(8,1),(8,2),(8,3)]);let held=journal.since(8,"original",0,Instant::now(),&HashSet::new());let super::super::journal::EventsSince::Held{events,..}=held else{panic!("original journal")};assert_eq!(events,delivered);}
 #[test]
 fn done_closes_original_event_writer_before_any_late_wait_update(){let(writer,seen,_)=writer();assert!(writer.send(AgentEvent::Done));assert!(!writer.send(AgentEvent::Cancelled));assert!(!writer.send(AgentEvent::Done));assert_eq!(seen.lock().unwrap().len(),1);}
 #[test]
 fn concurrent_original_owners_cannot_duplicate_or_reorder_cursor(){let(writer,seen,_)=writer();let mut owners=Vec::new();for _ in 0..2{let writer=writer.clone();owners.push(std::thread::spawn(move||for _ in 0..32{assert!(writer.send(AgentEvent::Cancelled));}));}for owner in owners{owner.join().unwrap();}assert!(writer.send(AgentEvent::Done));let events=seen.lock().unwrap();assert_eq!(events.len(),65);assert_eq!(events.iter().map(|event|event.seq).collect::<Vec<_>>(),(1..=65).collect::<Vec<_>>());}
}
