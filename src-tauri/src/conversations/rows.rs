//! SELECT-only archive projection. Expired rows never supply bodies/search/titles.
use rusqlite::{params,Connection,OptionalExtension};
use serde::{Serialize,Deserialize};
use super::transport::*;
use crate::runtime::chat_generations::{Scope,Error};
fn unavailable<T>(_:T)->ArchiveError{ArchiveError::unavailable()}
fn invalid()->ArchiveError{ArchiveError::from_rows(Error::Invalid)}
fn id(value:&str)->bool{!value.is_empty()&&value.len()<=128&&!value.chars().any(char::is_control)}
fn stamp(value:i64)->Result<String,ArchiveError>{chrono::DateTime::from_timestamp_millis(value).map(|value|value.to_rfc3339_opts(chrono::SecondsFormat::Millis,true)).ok_or_else(ArchiveError::unavailable)}
pub(crate) fn counter(value:u64)->Result<crate::actions::SafeCounter,ArchiveError>{crate::actions::SafeCounter::new(value).map_err(unavailable)}
pub(crate) fn context(scope:Scope<'_>)->ArchiveContext{ArchiveContext {vault_id:scope.vault.into(),store_uuid:scope.store.into()}}
pub(crate) fn setting(conn:&Connection,scope:Scope<'_>)->Result<ArchiveSetting,ArchiveError>{
    let found:Option<(String,i64)>=conn.query_row("SELECT choice,revision FROM conversation_retention WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3",params![scope.owner,scope.vault,scope.store],|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(unavailable)?;
    let (choice,revision)=match found {None=>(RetentionChoice::Off,0),Some((choice,revision))=>(serde_json::from_value(serde_json::Value::String(choice)).map_err(unavailable)?,u64::try_from(revision).map_err(unavailable)?)};
    let bytes=crate::runtime::conversations::legacy::used_bytes(conn,scope,chrono::Utc::now().timestamp_millis()).map_err(ArchiveError::from_rows)?;
    Ok(ArchiveSetting {context:context(scope),choice,revision:counter(revision)?,logical_bytes:counter(u64::try_from(bytes).map_err(unavailable)?)?,budget_bytes:counter(u64::try_from(crate::runtime::conversations::CONTENT_BUDGET).map_err(unavailable)?)?})
}
#[derive(Serialize,Deserialize)]#[serde(deny_unknown_fields)]
struct Cursor {vault:String,store:String,thread:Option<String>,at:i64,id:String,query:String}
fn cursor(value:Option<&str>,scope:Scope<'_>,thread:Option<&str>,query:&str)->Result<Option<Cursor>,ArchiveError>{
    value.map(|value|{
        if value.len()>2048{return Err(invalid());}
        let cursor:Cursor=serde_json::from_str(value).map_err(|_|invalid())?;
        if cursor.vault!=scope.vault||cursor.store!=scope.store||cursor.thread.as_deref()!=thread||cursor.query!=query||!id(&cursor.id)||cursor.at<0{return Err(invalid());}Ok(cursor)
    }).transpose()
}
fn next(scope:Scope<'_>,thread:Option<&str>,at:i64,id:&str,query:&str)->Result<String,ArchiveError>{serde_json::to_string(&Cursor {vault:scope.vault.into(),store:scope.store.into(),thread:thread.map(str::to_owned),at,id:id.into(),query:query.into()}).map_err(unavailable)}
fn text(row:&rusqlite::Row<'_>,at:usize,max:usize)->rusqlite::Result<String>{let value=row.get_ref(at)?.as_str()?;if value.len()>max{return Err(rusqlite::Error::InvalidQuery);}Ok(value.to_owned())}
fn optional_text(row:&rusqlite::Row<'_>,at:usize,max:usize)->rusqlite::Result<Option<String>>{if matches!(row.get_ref(at)?,rusqlite::types::ValueRef::Null){return Ok(None);}text(row,at,max).map(Some)}
pub(crate) fn threads(conn:&Connection,scope:Scope<'_>,after:Option<&str>,query:Option<&str>,limit:u32,now:i64)->Result<ThreadPage,ArchiveError>{
 let query=query.map(str::trim).filter(|query|!query.is_empty());if query.is_some_and(|query|query.len()>256){return Err(invalid());}
 let digest=crate::ledger::sha256_hex(query.unwrap_or("").as_bytes());let cursor=cursor(after,scope,None,&digest)?;
 let pattern=query.map(|query|format!("%{}%",query.replace('!',"!!").replace('%',"!%").replace('_',"!_")));let limit=limit.clamp(1,50) as usize;
 let mut statement=conn.prepare("SELECT t.thread_id,CASE WHEN EXISTS(SELECT 1 FROM conversation_archive_content c WHERE c.attempt_id=t.title_generation_id AND (c.expires_at IS NULL OR c.expires_at>?4)) THEN t.title ELSE NULL END,t.created_at,t.updated_at,t.parent_thread_id,t.branch_message_id,(SELECT b.cli_session_id FROM conversation_archive_attempts b WHERE b.owner_person=t.owner_person AND b.vault_id=t.vault_id AND b.store_uuid=t.store_uuid AND b.thread_id=t.thread_id AND b.archive_state<>'pending' ORDER BY b.order_at DESC,b.attempt_id DESC LIMIT 1),CASE WHEN EXISTS(SELECT 1 FROM conversation_archive_attempts b JOIN conversation_archive_content c USING(attempt_id) WHERE b.owner_person=t.owner_person AND b.vault_id=t.vault_id AND b.store_uuid=t.store_uuid AND b.thread_id=t.thread_id AND (c.expires_at IS NULL OR c.expires_at>?4)) THEN 'retained' WHEN EXISTS(SELECT 1 FROM conversation_archive_attempts b WHERE b.owner_person=t.owner_person AND b.vault_id=t.vault_id AND b.store_uuid=t.store_uuid AND b.thread_id=t.thread_id AND (b.archive_state='expired' OR (b.archive_state='retained' AND b.expires_at<=?4))) THEN 'expired' ELSE 'metadata_only' END,(SELECT c.expires_at FROM conversation_archive_content c WHERE c.attempt_id=t.title_generation_id) FROM conversation_threads t WHERE t.owner_person=?1 AND t.vault_id=?2 AND t.store_uuid=?3 AND t.tombstone_at IS NULL AND (?5 IS NULL OR EXISTS(SELECT 1 FROM conversation_archive_search s JOIN conversation_archive_content c USING(attempt_id) JOIN conversation_archive_attempts b USING(attempt_id) WHERE b.owner_person=t.owner_person AND b.vault_id=t.vault_id AND b.store_uuid=t.store_uuid AND b.thread_id=t.thread_id AND (c.expires_at IS NULL OR c.expires_at>?4) AND s.search_text LIKE ?5 ESCAPE '!')) AND (?6 IS NULL OR t.updated_at<?6 OR (t.updated_at=?6 AND t.thread_id<?7)) ORDER BY t.updated_at DESC,t.thread_id DESC LIMIT ?8").map_err(unavailable)?;
 let rows=statement.query_map(params![scope.owner,scope.vault,scope.store,now,pattern,cursor.as_ref().map(|cursor|cursor.at),cursor.as_ref().map(|cursor|cursor.id.as_str()),i64::try_from(limit+1).map_err(unavailable)?],|row|Ok((text(row,0,128)?,optional_text(row,1,320)?,row.get::<_,i64>(2)?,row.get::<_,i64>(3)?,optional_text(row,4,128)?,optional_text(row,5,128)?,optional_text(row,6,64)?,text(row,7,32)?,row.get::<_,Option<i64>>(8)?))).map_err(unavailable)?.collect::<rusqlite::Result<Vec<_>>>().map_err(unavailable)?;
 let more=rows.len()>limit;let mut items=Vec::new();let mut end=None;
 for (id,title,created,updated,parent,branch,session,state,title_expiry) in rows.into_iter().take(limit){end=Some((updated,id.clone()));items.push(ArchiveThread {id,title,title_expires_at:title_expiry.map(stamp).transpose()?,created_at:stamp(created)?,updated_at:stamp(updated)?,parent_thread_id:parent,branch_message_id:branch,session_id:session,content_state:serde_json::from_value(serde_json::Value::String(state)).map_err(unavailable)?});}
 Ok(ThreadPage {context:context(scope),items,next_cursor:if more {let (at,id)=end.ok_or_else(ArchiveError::unavailable)?;Some(next(scope,None,at,&id,&digest)?)}else{None}})
}
pub(crate) fn messages(conn:&Connection,scope:Scope<'_>,thread:&str,before:Option<&str>,limit:u32,now:i64)->Result<MessagePage,ArchiveError>{
 if !id(thread){return Err(invalid());}let cursor=cursor(before,scope,Some(thread),"")?;let limit=limit.clamp(1,50) as usize;
 let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM conversation_threads WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND thread_id=?4 AND tombstone_at IS NULL)",params![scope.owner,scope.vault,scope.store,thread],|row|row.get(0)).map_err(unavailable)?;if !exists{return Err(ArchiveError::from_rows(Error::Denied));}
 let mut statement=conn.prepare("SELECT b.attempt_id,b.user_message_id,b.assistant_message_id,b.run_id,b.completed_at,b.expires_at,b.archive_state,c.attempt_id,c.bytes,b.cli_session_id,b.imported_at,b.origin,b.order_at FROM conversation_archive_attempts b LEFT JOIN (SELECT generation_id AS attempt_id,length(CAST(content_json AS BLOB)) AS bytes FROM conversation_content UNION ALL SELECT attempt_id,length(CAST(content_json AS BLOB)) FROM conversation_legacy_content) c USING(attempt_id) WHERE b.owner_person=?1 AND b.vault_id=?2 AND b.store_uuid=?3 AND b.thread_id=?4 AND b.archive_state<>'pending' AND b.order_at IS NOT NULL AND (b.origin<>'native_run' OR NOT EXISTS(SELECT 1 FROM conversation_legacy_attempts copy WHERE copy.attempt_id=b.attempt_id AND copy.owner_person=b.owner_person AND copy.vault_id=b.vault_id AND copy.store_uuid=b.store_uuid AND copy.thread_id=b.thread_id AND copy.archive_state IN ('retained','expired','deleted'))) AND (b.origin<>'browser_cache' OR b.archive_state<>'unavailable' OR NOT EXISTS(SELECT 1 FROM conversation_bindings original WHERE original.generation_id=b.attempt_id AND original.owner_person=b.owner_person AND original.vault_id=b.vault_id AND original.store_uuid=b.store_uuid AND original.thread_id=b.thread_id)) AND (?5 IS NULL OR b.order_at<?5 OR (b.order_at=?5 AND b.attempt_id<?6)) ORDER BY b.order_at DESC,b.attempt_id DESC LIMIT ?7").map_err(unavailable)?;
 let rows=statement.query_map(params![scope.owner,scope.vault,scope.store,thread,cursor.as_ref().map(|cursor|cursor.at),cursor.as_ref().map(|cursor|cursor.id.as_str()),i64::try_from(limit+1).map_err(unavailable)?],|row|Ok((text(row,0,128)?,text(row,1,128)?,text(row,2,128)?,optional_text(row,3,128)?,row.get::<_,Option<i64>>(4)?,row.get::<_,Option<i64>>(5)?,text(row,6,32)?,optional_text(row,7,128)?,row.get::<_,Option<i64>>(8)?,optional_text(row,9,64)?,row.get::<_,Option<i64>>(10)?,text(row,11,32)?,row.get::<_,i64>(12)?))).map_err(unavailable)?.collect::<rusqlite::Result<Vec<_>>>().map_err(unavailable)?;
 let mut more=rows.len()>limit;let mut items=Vec::new();let mut end=None;let mut seen=std::collections::BTreeSet::new();let mut remaining=crate::agent::journal::TOTAL_BYTES.saturating_sub(crate::runtime::conversations::DISPLAY_BYTES);
 for (attempt,user,assistant,run,completed,expiry,persistence,content_id,bytes,session,imported,origin,order) in rows.into_iter().take(limit){
  if !seen.insert(attempt.clone()){return Err(ArchiveError::unavailable());}
  if session.as_deref().is_some_and(|value|crate::agent::transcript::parse_session_id(value).is_none()){return Err(ArchiveError::unavailable());}
  let origin:ContentOrigin=serde_json::from_value(serde_json::Value::String(origin)).map_err(unavailable)?;
  if (origin==ContentOrigin::NativeRun && (run.is_none()||completed.is_none()||imported.is_some()))||(origin==ContentOrigin::BrowserCache && (run.is_some()||imported.is_none())){return Err(ArchiveError::unavailable());}
  let persistence:PersistenceState=serde_json::from_value(serde_json::Value::String(persistence)).map_err(unavailable)?;
  let expired=persistence==PersistenceState::Expired||(persistence==PersistenceState::Retained&&expiry.is_some_and(|expiry|expiry<=now));
  let content=if persistence==PersistenceState::Retained&&!expired {
   if content_id.is_none()||bytes.is_none_or(|bytes|bytes<0||bytes>crate::agent::journal::RUN_BYTES as i64){return Err(ArchiveError::unavailable());}
   let body_sql=match origin {ContentOrigin::NativeRun=>"SELECT CASE WHEN length(CAST(content_json AS BLOB))<=4194304 THEN content_json ELSE NULL END FROM conversation_content WHERE generation_id=?1",ContentOrigin::BrowserCache=>"SELECT CASE WHEN length(CAST(content_json AS BLOB))<=4194304 THEN content_json ELSE NULL END FROM conversation_legacy_content WHERE attempt_id=?1"};
   let raw:String=conn.query_row(body_sql,[&attempt],|row|row.get(0)).map_err(unavailable)?;
   let content:CompletedContent=serde_json::from_str(&raw).map_err(unavailable)?;
   if content.version!=1||!content.answer.checked()||!(matches!(content.completion_status.as_str(),"completed"|"failed"|"cancelled"|"interrupted")||(origin==ContentOrigin::BrowserCache&&content.completion_status=="not_recorded")){return Err(ArchiveError::unavailable());}Some(content)
  }else{None};
  let message=ArchiveMessage {attempt_id:attempt.clone(),user_message_id:user,assistant_message_id:assistant,run_id:run,session_id:session,origin,imported_at:imported.map(stamp).transpose()?,completed_at:completed.map(stamp).transpose()?,expires_at:expiry.map(stamp).transpose()?,content_state:if expired {ContentState::Expired}else if content.is_some(){ContentState::Retained}else{ContentState::MetadataOnly},persistence,content};
  let bytes=serde_json::to_vec(&message).map_err(unavailable)?.len().saturating_add(1);if bytes>remaining {if items.is_empty(){return Err(ArchiveError::unavailable());}more=true;break;}
  remaining-=bytes;end=Some((order,attempt));items.push(message);
 }
 Ok(MessagePage {context:context(scope),thread_id:thread.into(),items,next_cursor:if more {let (at,id)=end.ok_or_else(ArchiveError::unavailable)?;Some(next(scope,Some(thread),at,&id,"")?)}else{None}})
}
#[cfg(test)]#[path="rows_tests.rs"]mod tests;
