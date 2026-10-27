//! Explicit human-selected browser-cache import; never an execution lifecycle.
use super::*;
#[derive(Debug,Clone,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct LegacyAttempt {
    pub user_message_id:String,pub assistant_message_id:String,pub display_message:DisplayMessage,pub answer:ArchiveTurnV1,
    #[serde(deserialize_with="crate::actions::read_types::required_nullable")]
    #[cfg_attr(test,schemars(with="crate::actions::read_types::RequiredNullable<crate::actions::SafeCounter>"))]
    pub completed_at:Option<crate::actions::SafeCounter>,
    #[serde(deserialize_with="crate::actions::read_types::required_nullable")]
    #[cfg_attr(test,schemars(with="crate::actions::read_types::RequiredNullable<String>"))]
    pub session_id:Option<String>,
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct ImportBatch {pub source_vault_path:String,pub thread_id:String,pub attempts:Vec<LegacyAttempt>}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="snake_case")]
pub(crate) enum ImportSkip {Off,UnknownCompletion,Expired,Unavailable,AlreadyRecorded,Conflict,BlockedActive}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(tag="state",rename_all="snake_case",rename_all_fields="camelCase",deny_unknown_fields)]
pub(crate) enum ImportItem {Retained {#[serde(rename="attemptId")]attempt_id:String,#[serde(rename="userMessageId")]user_message_id:String,#[serde(rename="assistantMessageId")]assistant_message_id:String},Skipped {#[serde(rename="userMessageId")]user_message_id:String,#[serde(rename="assistantMessageId")]assistant_message_id:String,reason:ImportSkip}}
#[cfg(test)]#[path="legacy_tests.rs"]mod tests;

struct Limit(usize);
impl std::io::Write for Limit {
 fn write(&mut self,bytes:&[u8])->std::io::Result<usize>{self.0=self.0.checked_add(bytes.len()).filter(|value|*value<=crate::agent::journal::TOTAL_BYTES).ok_or_else(||std::io::Error::other("import carrier cap"))?;Ok(bytes.len())}
 fn flush(&mut self)->std::io::Result<()>{Ok(())}
}
fn skipped(attempt:&LegacyAttempt,reason:ImportSkip)->ImportItem{ImportItem::Skipped {user_message_id:attempt.user_message_id.clone(),assistant_message_id:attempt.assistant_message_id.clone(),reason}}
fn display_checked(thread:&str,attempt:&LegacyAttempt)->Result<(),Error>{
 AttemptBinding {thread_id:thread.into(),user_message_id:attempt.user_message_id.clone(),assistant_message_id:attempt.assistant_message_id.clone(),parent_thread_id:None,branch_message_id:None,display_message:attempt.display_message.clone()}.checked()?;
 if !attempt.answer.checked()||attempt.session_id.as_ref().is_some_and(|value|crate::agent::transcript::parse_session_id(value).is_none()){return Err(Error::Invalid);}Ok(())
}
fn normalized(attempt:&LegacyAttempt)->LegacyAttempt{let mut value=attempt.clone();value.answer.availability=Availability::Partial;value}
fn digest(attempt:&LegacyAttempt)->Result<String,Error>{serde_json::to_vec(attempt).map(|bytes|crate::ledger::sha256_hex(&bytes)).map_err(unavailable)}
fn selected_active(conn:&Connection,scope:Scope<'_>,thread:&str,session:Option<&str>)->Result<Vec<String>,Error>{
 let owner:Option<String>=conn.query_row("SELECT g.current_run_id FROM conversation_bindings b JOIN chat_generations g USING(generation_id) WHERE b.owner_person=?1 AND b.vault_id=?2 AND b.store_uuid=?3 AND b.thread_id=?4 AND g.state IN ('admitted','running','deferred') LIMIT 1",params![scope.owner,scope.vault,scope.store,thread],|row|row.get(0)).optional().map_err(unavailable)?;
 if let Some(owner)=owner{return Ok(vec![owner]);}
 // The selected original generation members are authoritative even if their
 // CLI session was not captured. A native owner's closure does not settle its
 // retained Prepared/AwaitingApproval/Ready/Dispatched effects.
 let mut linked_after=String::new();
 loop {
  let mut statement=conn.prepare("SELECT m.run_id,g.actor_id,(n.run_id IS NOT NULL AND n.closed_at IS NULL) FROM chat_generation_runs m JOIN chat_generations g USING(generation_id) JOIN conversation_bindings b USING(generation_id) LEFT JOIN action_native_runs n ON n.run_id=m.run_id WHERE b.owner_person=?1 AND b.vault_id=?2 AND b.store_uuid=?3 AND b.thread_id=?4 AND m.run_id>?5 ORDER BY m.run_id LIMIT 128").map_err(unavailable)?;
  let page=statement.query_map(params![scope.owner,scope.vault,scope.store,thread,linked_after],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,bool>(2)?))).map_err(unavailable)?.collect::<rusqlite::Result<Vec<_>>>().map_err(unavailable)?;
  if page.is_empty(){break;}
  for (run,actor,open) in &page {
   if !opaque(run)||!opaque(actor){return Err(Error::Unavailable);}
   let owners=crate::actions::chat_retention::active_owners(conn,scope.vault,scope.store,run,actor).map_err(unavailable)?;
   if !owners.is_empty(){return Ok(owners);}if *open{return Ok(vec![run.clone()]);}
  }
  linked_after=page.last().ok_or(Error::Unavailable)?.0.clone();if page.len()<128{break;}
 }
 let Some(session)=session else{return Ok(Vec::new())};
 let running:Option<String>=conn.query_row("SELECT run_id FROM runs WHERE vault_id=?1 AND store_uuid=?2 AND cli_session_id=?3 AND (ended_at IS NULL OR outcome='running') LIMIT 1",params![scope.vault,scope.store,session],|row|row.get(0)).optional().map_err(unavailable)?;
 if let Some(owner)=running{return Ok(vec![owner]);}
 let pending:Option<String>=conn.query_row("SELECT p.pending_id FROM pending_writes p JOIN runs r USING(run_id) WHERE r.vault_id=?1 AND r.store_uuid=?2 AND r.cli_session_id=?3 AND p.vault_id=?1 AND p.state IN ('pending','applying') LIMIT 1",params![scope.vault,scope.store,session],|row|row.get(0)).optional().map_err(unavailable)?;
 if let Some(owner)=pending{return Ok(vec![owner]);}
 let child:Option<String>=conn.query_row("SELECT r.job_id FROM child_job_reservations r JOIN chat_delegation_intents i USING(slot_id) WHERE i.owner_person=?1 AND i.vault_id=?2 AND i.store_uuid=?3 AND i.parent_cli_session_id=?4 AND r.occupies_slot=1 LIMIT 1",params![scope.owner,scope.vault,scope.store,session],|row|row.get(0)).optional().map_err(unavailable)?;
 if let Some(owner)=child{return Ok(vec![owner]);}
 let open_owner:Option<String>=conn.query_row("SELECT run_id FROM action_native_runs WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND cli_session_id=?4 AND source_kind='run' AND parent_run_id IS NULL AND closed_at IS NULL LIMIT 1",params![scope.owner,scope.vault,scope.store,session],|row|row.get(0)).optional().map_err(unavailable)?;
 if let Some(owner)=open_owner{return Ok(vec![owner]);}
 let mut after=String::new();
 loop {
  let mut statement=conn.prepare("SELECT run_id,actor_id FROM action_native_runs WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND cli_session_id=?4 AND source_kind='run' AND parent_run_id IS NULL AND run_id>?5 ORDER BY run_id LIMIT 128").map_err(unavailable)?;
  let page=statement.query_map(params![scope.owner,scope.vault,scope.store,session,after],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).map_err(unavailable)?.collect::<rusqlite::Result<Vec<_>>>().map_err(unavailable)?;
  if page.is_empty(){break;}for (run,actor) in &page {let owners=crate::actions::chat_retention::active_owners(conn,scope.vault,scope.store,run,actor).map_err(unavailable)?;if !owners.is_empty(){return Ok(owners);}}
  after=page.last().ok_or(Error::Unavailable)?.0.clone();if page.len()<128{break;}
 }Ok(Vec::new())
}
pub(crate) fn active_owners(conn:&Connection,scope:Scope<'_>,thread:&str)->Result<Vec<String>,Error>{
 let mut statement=conn.prepare("SELECT DISTINCT cli_session_id FROM conversation_legacy_attempts WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND thread_id=?4 AND cli_session_id IS NOT NULL LIMIT 129").map_err(unavailable)?;
 let sessions=statement.query_map(params![scope.owner,scope.vault,scope.store,thread],|row|row.get::<_,String>(0)).map_err(unavailable)?.collect::<rusqlite::Result<Vec<_>>>().map_err(unavailable)?;
 if sessions.len()>128{return Err(Error::Unavailable);}for session in sessions {if crate::agent::transcript::parse_session_id(&session).is_none(){return Err(Error::Unavailable);}let owners=selected_active(conn,scope,thread,Some(&session))?;if !owners.is_empty(){return Ok(owners);}}Ok(Vec::new())
}
pub(crate) fn import_rows(conn:&Connection,scope:Scope<'_>,batch:&ImportBatch,now:i64)->Result<Vec<ImportItem>,Error>{
 checked(conn,scope)?;
 if now<0||now>9_007_199_254_740_991||!opaque(&batch.thread_id)||batch.attempts.is_empty()||batch.attempts.len()>128||batch.source_vault_path.len()>4096{return Err(Error::Invalid);}
 let registered:Option<String>=conn.query_row("SELECT vault_path FROM vault_registry WHERE vault_id=?1",[scope.vault],|row|row.get(0)).optional().map_err(unavailable)?;
 if registered.as_deref()!=Some(batch.source_vault_path.as_str()){return Err(Error::Denied);}
 serde_json::to_writer(&mut Limit(0),batch).map_err(|_|Error::Invalid)?;
 for attempt in &batch.attempts {display_checked(&batch.thread_id,attempt)?;if attempt.completed_at.is_some_and(|at|at.get()>now as u64){return Err(Error::Invalid);}}
 let selected=choice(conn,scope)?;
 if selected==RetentionChoice::Off{return Ok(batch.attempts.iter().map(|attempt|skipped(attempt,ImportSkip::Off)).collect());}
 super::retention::prune_rows(conn,scope,now)?;
 let mut result=Vec::new();
 for (position,source) in batch.attempts.iter().enumerate(){
  let mut attempt=normalized(source);
  // A cache copy may attach to a known terminal metadata-only attempt. Its
  // operational writer remains unchanged; recorded timing is authoritative.
  let native:Option<(String,String,String,String,String,Option<i64>,Option<String>,String)>=conn.query_row("SELECT b.generation_id,b.thread_id,b.user_message_id,b.assistant_message_id,b.archive_state,b.completed_at,m.cli_session_id,g.state FROM conversation_bindings b JOIN chat_generations g USING(generation_id) JOIN chat_generation_runs m ON m.run_id=g.current_run_id WHERE b.owner_person=?1 AND b.vault_id=?2 AND b.store_uuid=?3 AND (b.user_message_id IN (?4,?5) OR b.assistant_message_id IN (?4,?5)) LIMIT 1",params![scope.owner,scope.vault,scope.store,attempt.user_message_id,attempt.assistant_message_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?))).optional().map_err(unavailable)?;
  let linked=if let Some((generation,thread,user,assistant,state,completed,session,lifecycle))=native {
   if thread!=batch.thread_id||user!=attempt.user_message_id||assistant!=attempt.assistant_message_id {result.push(skipped(&attempt,ImportSkip::Conflict));continue;}
   if matches!(lifecycle.as_str(),"admitted"|"running"|"deferred")||state=="pending" {result.push(skipped(&attempt,ImportSkip::BlockedActive));continue;}
   if !matches!(lifecycle.as_str(),"completed"|"failed"|"cancelled"|"interrupted"){return Err(Error::Unavailable);}
   match state.as_str(){"retained"=>{result.push(skipped(&attempt,ImportSkip::AlreadyRecorded));continue;},"expired"=>{result.push(skipped(&attempt,ImportSkip::Expired));continue;},"deleted"=>{result.push(skipped(&attempt,ImportSkip::Conflict));continue;},"off"|"unavailable"=>{},_=>return Err(Error::Unavailable)}
   let body:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM conversation_content WHERE generation_id=?1)",[&generation],|row|row.get(0)).map_err(unavailable)?;if body{return Err(Error::Unavailable);}
   let actual=completed.ok_or(Error::Unavailable)?;let actual=crate::actions::SafeCounter::new(u64::try_from(actual).map_err(unavailable)?).map_err(unavailable)?;
   if attempt.completed_at.is_some_and(|provided|provided!=actual)||attempt.session_id.as_ref().is_some_and(|provided|session.as_ref().is_some_and(|actual|actual!=provided)){result.push(skipped(&attempt,ImportSkip::Conflict));continue;}
   attempt.completed_at=Some(actual);if session.is_some(){attempt.session_id=session;}Some(generation)
  }else{None};
  let completed=attempt.completed_at.map(|at|i64::try_from(at.get()).map_err(unavailable)).transpose()?;
  if selected!=RetentionChoice::Forever && completed.is_none(){result.push(skipped(&attempt,ImportSkip::UnknownCompletion));continue;}
  let mut expiry=completed.and_then(|at|selected.expiry(at));if (selected!=RetentionChoice::Forever&&expiry.is_none())||expiry.is_some_and(|at|at>9_007_199_254_740_991){return Err(Error::Invalid);}
  if expiry.is_some_and(|expiry|expiry<=now){result.push(skipped(&attempt,ImportSkip::Expired));continue;}
  let tombstone:Option<Option<i64>>=conn.query_row("SELECT tombstone_at FROM conversation_threads WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND thread_id=?4",params![scope.owner,scope.vault,scope.store,batch.thread_id],|row|row.get(0)).optional().map_err(unavailable)?;
  if matches!(tombstone,Some(Some(_))){result.push(skipped(&attempt,ImportSkip::Conflict));continue;}
  if !selected_active(conn,scope,&batch.thread_id,attempt.session_id.as_deref())?.is_empty(){result.push(skipped(&attempt,ImportSkip::BlockedActive));continue;}
  let source_digest=digest(&attempt)?;
  let existing:Option<(String,String,String,String,String,String,Option<i64>)>=conn.query_row("SELECT attempt_id,thread_id,user_message_id,assistant_message_id,source_digest,archive_state,expires_at FROM conversation_legacy_attempts WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND (user_message_id IN (?4,?5) OR assistant_message_id IN (?4,?5)) LIMIT 1",params![scope.owner,scope.vault,scope.store,attempt.user_message_id,attempt.assistant_message_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?))).optional().map_err(unavailable)?;
  let attempt_id=if let Some((id,thread,user,assistant,digest,state,original_expiry))=existing {
   if thread!=batch.thread_id||user!=attempt.user_message_id||assistant!=attempt.assistant_message_id||digest!=source_digest||state=="deleted"||state=="expired"{result.push(skipped(&attempt,ImportSkip::Conflict));continue;}
   expiry=original_expiry;if expiry.is_some_and(|at|at<=now){result.push(skipped(&attempt,ImportSkip::Expired));continue;}
   if state=="retained"{result.push(ImportItem::Retained {attempt_id:id,user_message_id:user,assistant_message_id:assistant});continue;}id
  }else{
   conn.execute("INSERT INTO conversation_threads(owner_person,vault_id,store_uuid,thread_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5) ON CONFLICT(owner_person,vault_id,store_uuid,thread_id) DO NOTHING",params![scope.owner,scope.vault,scope.store,batch.thread_id,now]).map_err(unavailable)?;
   let id=match linked {Some(id)=>id,None=>format!("legacy:{position:05}:{}",crate::ledger::sha256_hex(serde_json::to_string(&(scope.owner,scope.vault,scope.store,&batch.thread_id,&attempt.user_message_id,&attempt.assistant_message_id)).map_err(unavailable)?.as_bytes()))};
   conn.execute("INSERT INTO conversation_legacy_attempts(attempt_id,owner_person,vault_id,store_uuid,thread_id,user_message_id,assistant_message_id,source_digest,original_completed_at,imported_at,cli_session_id,choice,archive_state,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'unavailable',?13)",params![id,scope.owner,scope.vault,scope.store,batch.thread_id,attempt.user_message_id,attempt.assistant_message_id,source_digest,completed,now,attempt.session_id,selected.word(),expiry]).map_err(unavailable)?;id
  };
  let content=crate::conversations::transport::CompletedContent {version:1,display_message:attempt.display_message.clone(),answer:attempt.answer.clone(),completion_status:"not_recorded".into()};let body=serde_json::to_string(&content).map_err(unavailable)?;
  let bytes=i64::try_from(body.len()).map_err(unavailable)?;let used=used_bytes(conn,scope,now)?;
  if body.len()>crate::agent::journal::RUN_BYTES||used.checked_add(bytes).is_none_or(|total|total>CONTENT_BUDGET){result.push(skipped(&attempt,ImportSkip::Unavailable));continue;}
  conn.execute("INSERT INTO conversation_legacy_content(attempt_id,content_json,logical_bytes,expires_at) VALUES(?1,?2,?3,?4)",params![attempt_id,body,bytes,expiry]).map_err(unavailable)?;
  conn.execute("INSERT INTO conversation_legacy_search(attempt_id,search_text) VALUES(?1,?2)",params![attempt_id,format!("{}\n{}",attempt.display_message.text,attempt.answer.search_text())]).map_err(unavailable)?;
  conn.execute("UPDATE conversation_legacy_attempts SET archive_state='retained' WHERE attempt_id=?1",[&attempt_id]).map_err(unavailable)?;
  let title:String=attempt.display_message.text.chars().take(80).collect();conn.execute("UPDATE conversation_threads SET title=coalesce(title,?5),title_generation_id=coalesce(title_generation_id,?6),updated_at=max(updated_at,?7) WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND thread_id=?4",params![scope.owner,scope.vault,scope.store,batch.thread_id,title,attempt_id,now]).map_err(unavailable)?;
  result.push(ImportItem::Retained {attempt_id,user_message_id:attempt.user_message_id,assistant_message_id:attempt.assistant_message_id});
 }Ok(result)
}
/// Called only after commit through the original owned query-only snapshot.
/// Missing/corrupt/expired bytes refuse confirmation; browser bodies stay intact.
pub(crate) fn verify_rows(conn:&Connection,scope:Scope<'_>,items:&[ImportItem],now:i64)->Result<(),Error>{
 for item in items {let ImportItem::Retained {attempt_id,user_message_id,assistant_message_id}=item else{continue};
  let (source_digest,raw,completed,session):(String,String,Option<i64>,Option<String>)=conn.query_row("SELECT a.source_digest,c.content_json,a.original_completed_at,a.cli_session_id FROM conversation_legacy_attempts a JOIN conversation_legacy_content c USING(attempt_id) JOIN conversation_threads t USING(owner_person,vault_id,store_uuid,thread_id) WHERE a.attempt_id=?1 AND a.owner_person=?2 AND a.vault_id=?3 AND a.store_uuid=?4 AND a.user_message_id=?5 AND a.assistant_message_id=?6 AND a.archive_state='retained' AND t.tombstone_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>?7) AND length(CAST(c.content_json AS BLOB))<=4194304",params![attempt_id,scope.owner,scope.vault,scope.store,user_message_id,assistant_message_id,now],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).map_err(unavailable)?;
  let content:crate::conversations::transport::CompletedContent=serde_json::from_str(&raw).map_err(unavailable)?;
  if content.version!=1||!content.answer.checked()||content.completion_status!="not_recorded"{return Err(Error::Unavailable);}
  let actual=LegacyAttempt {user_message_id:user_message_id.clone(),assistant_message_id:assistant_message_id.clone(),display_message:content.display_message,answer:content.answer,completed_at:completed.map(|value|u64::try_from(value).map_err(unavailable).and_then(|value|crate::actions::SafeCounter::new(value).map_err(unavailable))).transpose()?,session_id:session};
  if digest(&actual)?!=source_digest{return Err(Error::Unavailable);}
 }Ok(())
}
pub(crate) fn prune_rows(conn:&Connection,scope:Scope<'_>,now:i64)->Result<super::retention::PruneReport,Error>{
 let (messages,bytes):(i64,i64)=conn.query_row("SELECT count(*),coalesce(sum(c.logical_bytes),0) FROM conversation_legacy_content c JOIN conversation_legacy_attempts a USING(attempt_id) WHERE a.owner_person=?1 AND a.vault_id=?2 AND a.store_uuid=?3 AND c.expires_at IS NOT NULL AND c.expires_at<=?4",params![scope.owner,scope.vault,scope.store,now],|row|Ok((row.get(0)?,row.get(1)?))).map_err(unavailable)?;
 let search:i64=conn.query_row("SELECT count(*) FROM conversation_legacy_search s JOIN conversation_legacy_content c USING(attempt_id) JOIN conversation_legacy_attempts a USING(attempt_id) WHERE a.owner_person=?1 AND a.vault_id=?2 AND a.store_uuid=?3 AND c.expires_at IS NOT NULL AND c.expires_at<=?4",params![scope.owner,scope.vault,scope.store,now],|row|row.get(0)).map_err(unavailable)?;
 conn.execute("UPDATE conversation_threads SET title=NULL,title_generation_id=NULL WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND title_generation_id IN (SELECT attempt_id FROM conversation_legacy_content WHERE expires_at IS NOT NULL AND expires_at<=?4)",params![scope.owner,scope.vault,scope.store,now]).map_err(unavailable)?;
 conn.execute("UPDATE conversation_legacy_attempts SET archive_state='expired' WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND attempt_id IN (SELECT attempt_id FROM conversation_legacy_content WHERE expires_at IS NOT NULL AND expires_at<=?4)",params![scope.owner,scope.vault,scope.store,now]).map_err(unavailable)?;
 conn.execute("DELETE FROM conversation_legacy_content WHERE attempt_id IN (SELECT c.attempt_id FROM conversation_legacy_content c JOIN conversation_legacy_attempts a USING(attempt_id) WHERE a.owner_person=?1 AND a.vault_id=?2 AND a.store_uuid=?3 AND c.expires_at IS NOT NULL AND c.expires_at<=?4)",params![scope.owner,scope.vault,scope.store,now]).map_err(unavailable)?;
 Ok(super::retention::PruneReport {removed_messages:u64::try_from(messages).map_err(unavailable)?,removed_search_rows:u64::try_from(search).map_err(unavailable)?,logical_bytes_released:u64::try_from(bytes).map_err(unavailable)?})
}
pub(crate) fn delete_rows(conn:&Connection,scope:Scope<'_>,thread:&str)->Result<(),Error>{
 conn.execute("UPDATE conversation_legacy_attempts SET archive_state=CASE WHEN archive_state='expired' THEN 'expired' ELSE 'deleted' END WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND thread_id=?4 AND archive_state<>'deleted'",params![scope.owner,scope.vault,scope.store,thread]).map_err(unavailable)?;
 conn.execute("DELETE FROM conversation_legacy_content WHERE attempt_id IN (SELECT attempt_id FROM conversation_legacy_attempts WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND thread_id=?4)",params![scope.owner,scope.vault,scope.store,thread]).map_err(unavailable)?;Ok(())
}

/// Read only size metadata; never materialize a union containing message bodies.
pub(crate) fn used_bytes(conn:&Connection,scope:Scope<'_>,now:i64)->Result<i64,Error>{
 if now<0{return Err(Error::Invalid);}
 let used:i64=conn.query_row("SELECT (SELECT coalesce(sum(c.logical_bytes),0) FROM conversation_content c JOIN conversation_bindings b USING(generation_id) WHERE b.owner_person=?1 AND b.vault_id=?2 AND (c.expires_at IS NULL OR c.expires_at>?3))+(SELECT coalesce(sum(c.logical_bytes),0) FROM conversation_legacy_content c JOIN conversation_legacy_attempts b USING(attempt_id) WHERE b.owner_person=?1 AND b.vault_id=?2 AND (c.expires_at IS NULL OR c.expires_at>?3))",params![scope.owner,scope.vault,now],|row|row.get(0)).map_err(unavailable)?;
 if used<0{return Err(Error::Unavailable);}Ok(used)
}
