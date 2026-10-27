//! Shared deterministic schedule decision. Plain facts never grant execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Error { Unavailable, Invalid }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CatchUp { SkipMissed, CoalesceLatest }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Observation {
 Unknown,
 Native { previous_ms:i64, same_opening:bool, resumed:bool },
}
#[derive(Debug, Clone, Copy)]
pub(crate) struct Request {
 pub(crate) anchor_ms:i64, pub(crate) cursor_ms:i64, pub(crate) now_ms:i64,
 pub(crate) interval_seconds:u32, pub(crate) catch_up:CatchUp,
 pub(crate) observation:Observation, pub(crate) enabled:bool,
 pub(crate) ready:bool, pub(crate) recovery_held:bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Disposition { Idle, Due, Paused, NotReady, RecoveryHeld, ClockBackwards }
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Plan {
 pub(crate) disposition:Disposition, pub(crate) due_ms:Option<i64>,
 pub(crate) cursor_ms:i64, pub(crate) skipped:u64, pub(crate) coalesced:u64,
 pub(crate) first_due_ms:Option<i64>, pub(crate) last_due_ms:Option<i64>,
 pub(crate) coverage_known:bool,
}
#[derive(serde::Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Policy{format_version:u32,clock:String,max_observation_gap_ms:i64,coalesce_lookback_ms:i64}
fn policy()->&'static Policy{
 static POLICY:std::sync::OnceLock<Policy>=std::sync::OnceLock::new();
 POLICY.get_or_init(||{
  let value:Policy=serde_json::from_str(include_str!("../../../shared/workflows/schedule.v1.json")).expect("workflow schedule policy");
  assert_eq!(value.format_version,1);assert_eq!(value.clock,"utc_elapsed");
  assert!(value.max_observation_gap_ms>0&&value.coalesce_lookback_ms>0);value
 })
}
fn exact_time(value:i64)->Result<(),Error>{
 let value=u64::try_from(value).map_err(|_|Error::Invalid)?;
 crate::actions::SafeCounter::new(value).map(|_|()).map_err(|_|Error::Invalid)
}
fn count(value:i64)->Result<u64,Error>{
 let value=u64::try_from(value).map_err(|_|Error::Invalid)?;
 crate::actions::SafeCounter::new(value).map(|v|v.get()).map_err(|_|Error::Invalid)
}
/// Pure elapsed-UTC plan. The native caller owns all readiness facts and
/// recomputes this decision inside its actual occurrence claim transaction.
pub(crate) fn evaluate(request:Request)->Result<Plan,Error>{
 for value in [request.anchor_ms,request.cursor_ms,request.now_ms]{exact_time(value)?;}
 if !super::definition::schedule_interval_supported(request.interval_seconds){return Err(Error::Invalid);}
 let period=i64::from(request.interval_seconds).checked_mul(1000).ok_or(Error::Invalid)?;
 let cursor_delta=request.cursor_ms.checked_sub(request.anchor_ms).ok_or(Error::Invalid)?;
 if cursor_delta<0||cursor_delta%period!=0{return Err(Error::Invalid);}
 let policy=policy();
 let previous=match request.observation{
  Observation::Native{previous_ms,same_opening:true,resumed:false}
   if previous_ms>=0&&previous_ms<=request.now_ms&&request.now_ms.checked_sub(previous_ms).is_some_and(|gap|gap<=policy.max_observation_gap_ms)=>Some(previous_ms),
  _=>None,
 };
 let unchanged=|disposition,coverage_known|Plan{disposition,due_ms:None,cursor_ms:request.cursor_ms,skipped:0,coalesced:0,first_due_ms:None,last_due_ms:None,coverage_known};
 if request.recovery_held{return Ok(unchanged(Disposition::RecoveryHeld,previous.is_some()));}
 if !request.enabled{return Ok(unchanged(Disposition::Paused,previous.is_some()));}
 if !request.ready{return Ok(unchanged(Disposition::NotReady,previous.is_some()));}
 if request.now_ms<request.cursor_ms{return Ok(unchanged(Disposition::ClockBackwards,false));}
 let elapsed=request.now_ms.checked_sub(request.anchor_ms).ok_or(Error::Invalid)?;
 let cursor_index=cursor_delta/period;let last_index=elapsed/period;
 let total=last_index.checked_sub(cursor_index).ok_or(Error::Invalid)?;
 if total==0{return Ok(unchanged(Disposition::Idle,previous.is_some()));}
 let first=request.cursor_ms.checked_add(period).ok_or(Error::Invalid)?;
 let last=request.anchor_ms.checked_add(last_index.checked_mul(period).ok_or(Error::Invalid)?).ok_or(Error::Invalid)?;
 let (due,skipped,coalesced)=match request.catch_up{
  CatchUp::SkipMissed=>{
   let due=previous.filter(|previous|last>*previous).map(|_|last);
   (due,total-if due.is_some(){1}else{0},0)
  }
  CatchUp::CoalesceLatest=>{
   // The lookback is (now-lookback,now]. Slots at its lower bound are old.
   let cutoff=request.now_ms.checked_sub(policy.coalesce_lookback_ms).ok_or(Error::Invalid)?;
   let skipped=if cutoff<=request.cursor_ms{0}else{((cutoff-request.anchor_ms)/period-cursor_index).min(total)};
   let eligible=total.checked_sub(skipped).ok_or(Error::Invalid)?;
   if eligible==0{(None,total,0)}else{(Some(last),skipped,eligible-1)}
  }
 };
 Ok(Plan{disposition:if due.is_some(){Disposition::Due}else{Disposition::Idle},due_ms:due,cursor_ms:last,skipped:count(skipped)?,coalesced:count(coalesced)?,first_due_ms:Some(first),last_due_ms:Some(last),coverage_known:previous.is_some()})
}
#[cfg(test)]
#[path="schedule_tests.rs"]
mod tests;
