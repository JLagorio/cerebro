//! Exact original MCP-call cancellation controls only. No native/person/provider
//! authority constructor; the matched transport owns admission separately.
use super::*;
use std::sync::{Weak,atomic::{AtomicBool,Ordering}};
struct Entry{receipt:Weak<crate::agent::NativePublicationReceipt>,rpc:String,flag:Weak<AtomicBool>}
#[derive(Default)]
pub(super) struct ControlBook{entries:Mutex<Vec<Entry>>,retired:AtomicBool}
pub(super) struct Registration{flag:Arc<AtomicBool>,book:Arc<ControlBook>,receipt:Arc<crate::agent::NativePublicationReceipt>,rpc:String,deadline:Instant}
pub(super) fn request_key(id:&Value)->Option<String>{
 let(max_id,_)=crate::actions::native_owner::managed_call_limits();
 match id{
  Value::String(value) if !value.is_empty()&&value.len()<=max_id=>Some(format!("s:{}",serde_json::to_string(value).ok()?)),
  Value::Number(value)=>{let magnitude=if let Some(value)=value.as_i64(){u64::try_from(value.checked_abs()?).ok()?}else{value.as_u64()?};crate::actions::SafeCounter::new(magnitude).ok()?;Some(format!("n:{value}"))},
  _=>None,
 }
}
fn current_source(grant:&RunGrant,receipt:&crate::agent::NativePublicationReceipt)->bool{receipt.matches_slot(&grant.run_id,&grant.actor,grant.vault.as_deref(),receipt.fingerprint())}
impl ControlBook{
 fn retire_locked(&self,entries:&[Entry]){for entry in entries{if let Some(flag)=entry.flag.upgrade(){flag.store(true,Ordering::SeqCst);}}self.retired.store(true,Ordering::SeqCst);}
 pub(super) fn register(self:&Arc<Self>,grant:&RunGrant,receipt:&Arc<crate::agent::NativePublicationReceipt>,id:&Value,deadline:Instant)->Option<Registration>{
  let rpc=request_key(id)?;let now=Instant::now();let(_,lifetime)=crate::actions::native_owner::managed_call_limits();
  if self.retired.load(Ordering::SeqCst)||deadline<=now||deadline>now.checked_add(lifetime)?||!current_source(grant,receipt){return None;}
  // No source/MCP/storage lookup runs under this control-only mutex.
  let mut entries=match self.entries.lock(){Ok(entries)=>entries,Err(poison)=>{self.retire_locked(&poison.into_inner());return None;}};
  entries.retain(|entry|entry.flag.strong_count()>0&&entry.receipt.strong_count()>0);
  let original=Arc::downgrade(receipt);
  if self.retired.load(Ordering::SeqCst)||entries.len()>=crate::agent::MAX_CONCURRENT_RUNS||entries.iter().any(|entry|entry.rpc==rpc&&entry.receipt.ptr_eq(&original)){return None;}
  let flag=Arc::new(AtomicBool::new(false));entries.push(Entry{receipt:original,rpc:rpc.clone(),flag:Arc::downgrade(&flag)});drop(entries);
  Some(Registration{flag,book:self.clone(),receipt:receipt.clone(),rpc,deadline})
 }
 pub(super) fn cancel(&self,grant:&RunGrant,receipt:&Arc<crate::agent::NativePublicationReceipt>,id:&Value)->bool{
  let Some(rpc)=request_key(id)else{return false;};if !current_source(grant,receipt){return false;}
  let entries=match self.entries.lock(){Ok(entries)=>entries,Err(poison)=>{self.retire_locked(&poison.into_inner());return false;}};
  if self.retired.load(Ordering::SeqCst){return false;}
  let original=Arc::downgrade(receipt);let Some(flag)=entries.iter().find(|entry|entry.rpc==rpc&&entry.receipt.ptr_eq(&original)).and_then(|entry|entry.flag.upgrade())else{return false;};flag.store(true,Ordering::SeqCst);true
 }
 #[cfg(test)]pub(super) fn poison(self:&Arc<Self>){let copy=self.clone();assert!(std::thread::spawn(move||{let _entries=copy.entries.lock().unwrap();panic!("controlled original RPC control poison");}).join().is_err());}
}
impl Registration{
 /// Keep the exact original registration through serialization, synchronous
 /// response write/flush and disposal. Unwind also drops this retained owner.
 pub(super) fn respond_with<T>(self,body:Value,respond:impl FnOnce(&Value)->T)->T{let result=respond(&body);drop(self);result}

 pub(super) fn rpc_key(&self)->&str{&self.rpc}
 #[cfg(test)]
 pub(super) fn flag(&self)->Arc<AtomicBool>{self.flag.clone()}
 pub(super) fn stopped_at(&self,now:Instant)->bool{if now>=self.deadline{self.flag.store(true,Ordering::SeqCst);}self.flag.load(Ordering::SeqCst)||self.book.retired.load(Ordering::SeqCst)}
}
impl Drop for Registration{
 fn drop(&mut self){
  self.flag.store(true,Ordering::SeqCst);let original=Arc::downgrade(&self.receipt);let flag=Arc::downgrade(&self.flag);
  match self.book.entries.lock(){Ok(mut entries)=>entries.retain(|entry|!(entry.rpc==self.rpc&&entry.receipt.ptr_eq(&original)&&entry.flag.ptr_eq(&flag))),Err(poison)=>{let mut entries=poison.into_inner();self.book.retire_locked(&entries);entries.retain(|entry|!(entry.rpc==self.rpc&&entry.receipt.ptr_eq(&original)&&entry.flag.ptr_eq(&flag)));}}
 }
}
