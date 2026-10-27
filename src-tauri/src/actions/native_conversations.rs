//! Native window/original-opening archive composition. No executor or run grants.
use super::*;
use crate::conversations::{rows,transport::*};
use crate::runtime::{chat_generations::Scope,conversations::retention};
use crate::workspace_service::authority::{AuthorityContext,LegacyOpeningTicket};
struct Opening {proof:AttendedWindowProof,context:AuthorityContext,root:PathBuf,ticket:LegacyOpeningTicket,store:NativeStoreObservation,scope:crate::runtime::VaultScope}
#[derive(Clone,Copy)]enum Use {Read,Write,Cleanup}
impl Opening {
    fn capture(app:&AppHandle,window:&WebviewWindow)->Result<Self,ArchiveError>{
        let proof=authenticate(app,window).map_err(|_|ArchiveError::unavailable())?;
        let context=crate::workspace_service::authority::context().map_err(|_|ArchiveError::unavailable())?;
        let (root,ticket)=context.capture_current_legacy_opening().map_err(|_|ArchiveError::unavailable())?;
        let store=read_native_store(&root).map_err(|_|ArchiveError::unavailable())?;
        let scope=crate::runtime::VaultScope {vault_id:crate::runtime::scope::derive_vault_id(&root),store_uuid:Some(store.info.store_id.clone())};
        Ok(Self {proof,context,root,ticket,store,scope})
    }
    fn scope(&self)->Scope<'_>{Scope {owner:&crate::actions::schema::admission_rules().owner_storage_key,vault:&self.scope.vault_id,store:&self.store.info.store_id,actor:"human:me",process:crate::runtime::sessions::session_id()}}
    fn expected(&self,context:&ArchiveContext)->Result<(),ArchiveError>{if *context!=rows::context(self.scope()){Err(ArchiveError::from_rows(crate::runtime::chat_generations::Error::Denied))}else{Ok(())}}
    fn run<T>(&self,use_:Use,work:impl FnOnce(&Connection,Scope<'_>)->Result<T,ArchiveError>)->Result<T,ArchiveError>{
        self.context.with_legacy_opening(&self.ticket,||{
            if !self.proof.owner.registration.live.load(Ordering::SeqCst){return Err(ArchiveError::unavailable());}
            self.store.recheck().map_err(|_|ArchiveError::unavailable())?;
            let mut storage=self.proof.owner.storage.lock().map_err(|_|ArchiveError::unavailable())?;
            if storage.failed{return Err(ArchiveError::unavailable());}let owner=storage.owner.as_mut().ok_or_else(ArchiveError::unavailable)?;
            match use_ {
                Use::Read=>owner.read_snapshot(|read|{
                    RuntimeOwner::verify_open_session(read.conn,&self.root,&self.scope)?;
                    let value=work(read.conn,self.scope());self.store.recheck()?;
                    if !self.proof.owner.registration.live.load(Ordering::SeqCst){return Err(NativeOwnerError::Unavailable);}Ok(value)
                }).map_err(|_|ArchiveError::unavailable())?,
                Use::Write=>{
                    let mut refused=None;
                    match owner.classified_transaction(|tx|{
                        RuntimeOwner::verify_open_session(tx,&self.root,&self.scope)?;
                        let value=work(tx,self.scope()).map_err(|error|{refused=Some(error);NativeOwnerError::Unavailable})?;
                        self.store.recheck()?;if !self.proof.owner.registration.live.load(Ordering::SeqCst){return Err(NativeOwnerError::Unavailable);}Ok(value)
                    }) {RuntimeTransactionOutcome::Committed(value)=>Ok(value),RuntimeTransactionOutcome::NotCommitted(_)=>Err(refused.unwrap_or_else(ArchiveError::unavailable)),RuntimeTransactionOutcome::CommitUncertain=>Err(ArchiveError::unavailable())}
                }
                Use::Cleanup=>{owner.validate().map_err(|_|ArchiveError::unavailable())?;let value=work(&owner.conn,self.scope());self.store.recheck().map_err(|_|ArchiveError::unavailable())?;value}
            }
        }).map_err(|_|ArchiveError::unavailable())?
    }
    fn cleanup(&self)->CleanupState {
        self.run(Use::Cleanup,|conn,_|{
            if !conn.is_autocommit(){return Ok(CleanupState::Deferred);}
            match conn.query_row("PRAGMA wal_checkpoint(PASSIVE)",[],|row|Ok((row.get::<_,i64>(0)?,row.get::<_,i64>(1)?,row.get::<_,i64>(2)?))) {
                Ok((busy,log,done)) if busy!=0||log>done=>Ok(CleanupState::Deferred),
                Ok(_)=>Ok(CleanupState::Completed),Err(_)=>Ok(CleanupState::Failed),
            }
        }).unwrap_or(CleanupState::Deferred)
    }
}
fn bound(app:&AppHandle,window:&WebviewWindow,context:&ArchiveContext)->Result<Opening,ArchiveError>{let opening=Opening::capture(app,window)?;opening.expected(context)?;Ok(opening)}
pub(crate) fn context(app:&AppHandle,window:&WebviewWindow)->Result<ArchiveContext,ArchiveError>{let opening=Opening::capture(app,window)?;opening.run(Use::Read,|_,scope|Ok(rows::context(scope)))}
pub(crate) fn setting(app:&AppHandle,window:&WebviewWindow,context:ArchiveContext)->Result<ArchiveSetting,ArchiveError>{bound(app,window,&context)?.run(Use::Read,rows::setting)}
pub(crate) fn set_retention(app:&AppHandle,window:&WebviewWindow,context:ArchiveContext,choice:RetentionChoice,revision:crate::actions::SafeCounter)->Result<ArchiveSetting,ArchiveError>{
    bound(app,window,&context)?.run(Use::Write,|conn,scope|{retention::set_rows(conn,scope,choice,revision.get()).map_err(ArchiveError::from_rows)?;rows::setting(conn,scope)})
}
pub(crate) fn list(app:&AppHandle,window:&WebviewWindow,context:ArchiveContext,after:Option<String>,query:Option<String>,limit:u32)->Result<ThreadPage,ArchiveError>{bound(app,window,&context)?.run(Use::Read,|conn,scope|rows::threads(conn,scope,after.as_deref(),query.as_deref(),limit,chrono::Utc::now().timestamp_millis()))}
pub(crate) fn messages(app:&AppHandle,window:&WebviewWindow,context:ArchiveContext,thread:String,before:Option<String>,limit:u32)->Result<MessagePage,ArchiveError>{bound(app,window,&context)?.run(Use::Read,|conn,scope|rows::messages(conn,scope,&thread,before.as_deref(),limit,chrono::Utc::now().timestamp_millis()))}
pub(crate) fn delete(app:&AppHandle,window:&WebviewWindow,context:ArchiveContext,thread:String)->Result<DeleteResult,ArchiveError>{
    let opening=bound(app,window,&context)?;
    let result=opening.run(Use::Write,|conn,scope|retention::delete_rows(conn,scope,&thread,chrono::Utc::now().timestamp_millis()).map_err(ArchiveError::from_rows))?;
    Ok(match result {retention::DeleteResult::Deleted=>DeleteResult::Deleted {cleanup:opening.cleanup()},retention::DeleteResult::AlreadyDeleted=>DeleteResult::AlreadyDeleted {},retention::DeleteResult::BlockedActive {owners}=>DeleteResult::BlockedActive {owners}})
}
pub(crate) fn prune(app:&AppHandle,window:&WebviewWindow,context:ArchiveContext)->Result<PruneResult,ArchiveError>{
    let opening=bound(app,window,&context)?;
    let result=opening.run(Use::Write,|conn,scope|retention::prune_rows(conn,scope,chrono::Utc::now().timestamp_millis()).map_err(ArchiveError::from_rows))?;
    let cleanup=opening.cleanup();
    Ok(PruneResult {context,removed_messages:rows::counter(result.removed_messages)?,removed_search_rows:rows::counter(result.removed_search_rows)?,logical_bytes_released:rows::counter(result.logical_bytes_released)?,cleanup,safe_reason:match cleanup {CleanupState::Completed=>None,CleanupState::Deferred=>Some("Logical deletion finished; SQLite cleanup is waiting for readers or the original opening.".into()),CleanupState::Failed=>Some("Logical deletion finished; SQLite cleanup failed and can be retried.".into())}})
}
pub(crate) fn export(app:&AppHandle,window:&WebviewWindow,context:ArchiveContext,thread:String,format:ExportFormat)->Result<ExportResult,ArchiveError>{
    let opening=bound(app,window,&context)?;
    opening.run(Use::Read,|conn,scope|rows::messages(conn,scope,&thread,None,1,chrono::Utc::now().timestamp_millis()).map(|_|()))?;
    let extension=match format {ExportFormat::Json=>"json",ExportFormat::Markdown=>"md"};
    let Some(choice)=crate::shell::file_actions::choose_draft_copy(app,&format!("conversation.{extension}")).map_err(|_|ArchiveError::unavailable())? else{return Ok(ExportResult::Cancelled {});};
    // The same captured ticket and held save choice survive the dialog.
    let (path,partial)=opening.run(Use::Read,|conn,scope|crate::conversations::export::write(conn,scope,&opening.root,&opening.proof.owner.registration.origin,choice,&thread,format))?;
    Ok(ExportResult::Saved {path,partial})
}

/// Human cache import uses the original opening writer, then a distinct durable read.
pub(crate) fn import(app:&AppHandle,window:&WebviewWindow,context:ArchiveContext,mut batch:crate::runtime::conversations::legacy::ImportBatch)->Result<ImportResult,ArchiveError>{
 let opening=bound(app,window,&context)?;
 let source=PathBuf::from(&batch.source_vault_path).canonicalize().map_err(|_|ArchiveError::from_rows(crate::runtime::chat_generations::Error::Denied))?;
 if source!=opening.root.canonicalize().map_err(|_|ArchiveError::unavailable())?{return Err(ArchiveError::from_rows(crate::runtime::chat_generations::Error::Denied));}
 // Path is a provenance selector only. Use the exact registered spelling after
 // proving it resolves to the same original held vault; never adopt another root.
 batch.source_vault_path=opening.run(Use::Read,|conn,scope|{
  let registered:String=conn.query_row("SELECT vault_path FROM vault_registry WHERE vault_id=?1",[scope.vault],|row|row.get(0)).map_err(|_|ArchiveError::unavailable())?;
  if PathBuf::from(&registered).canonicalize().map_err(|_|ArchiveError::unavailable())?!=source{return Err(ArchiveError::from_rows(crate::runtime::chat_generations::Error::Denied));}Ok(registered)
 })?;
 let items=opening.run(Use::Write,|conn,scope|crate::runtime::conversations::legacy::import_rows(conn,scope,&batch,chrono::Utc::now().timestamp_millis()).map_err(ArchiveError::from_rows))?;
 let confirmed=opening.run(Use::Read,|conn,scope|{
  crate::runtime::conversations::legacy::verify_rows(conn,scope,&items,chrono::Utc::now().timestamp_millis()).map_err(ArchiveError::from_rows)?;
  let mut result=Vec::new();
  for item in &items {let crate::runtime::conversations::legacy::ImportItem::Retained {attempt_id,user_message_id,assistant_message_id}=item else{continue};
   let (thread,expiry,imported):(String,Option<i64>,i64)=conn.query_row("SELECT thread_id,expires_at,imported_at FROM conversation_legacy_attempts WHERE attempt_id=?1 AND owner_person=?2 AND vault_id=?3 AND store_uuid=?4",rusqlite::params![attempt_id,scope.owner,scope.vault,scope.store],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).map_err(|_|ArchiveError::unavailable())?;
   let stamp=|at|chrono::DateTime::from_timestamp_millis(at).map(|value|value.to_rfc3339_opts(chrono::SecondsFormat::Millis,true)).ok_or_else(ArchiveError::unavailable);
   result.push(ImportedIdentity {thread_id:thread,attempt_id:attempt_id.clone(),user_message_id:user_message_id.clone(),assistant_message_id:assistant_message_id.clone(),expires_at:expiry.map(stamp).transpose()?,imported_at:stamp(imported)?});
  }Ok(result)
 })?;
 Ok(ImportResult {context,items,confirmed})
}
