//! Temp SQLite + fake completion clock; no process, credential or provider.
use super::*;
use crate::runtime::chat_generations::{self as generations, Admission,End};
use rusqlite::{params,Transaction,TransactionBehavior};
const VAULT:&str="cccccccccccccccccccccccccccccccc";
fn scope()->Scope<'static>{Scope {owner:"human:me",vault:VAULT,store:"store",actor:"claude-code",process:"archive-retention-process"}}
fn db()->Connection {
    let data=crate::vault::testutil::temp_vault("archive-retention");
    let conn=crate::runtime::open(&data).unwrap();
    conn.execute("INSERT INTO vault_registry(vault_id,vault_path,first_seen_at) VALUES(?1,'/retention-fixture','2026-10-26T00:00:00Z')",[VAULT]).unwrap();conn
}
fn tx<T>(conn:&Connection,work:impl FnOnce(&Connection)->Result<T,Error>)->Result<T,Error>{let tx=Transaction::new_unchecked(conn,TransactionBehavior::Immediate).unwrap();let value=work(&tx)?;tx.commit().unwrap();Ok(value)}
fn begin(conn:&Connection,n:u8)->Receipt{
    tx(conn,|conn|{
        let key=format!("{n:032x}");let Admission::New(receipt)=generations::begin_rows(conn,scope(),&key,&"a".repeat(64))? else{panic!("new generation")};
        begin_rows(conn,scope(),&receipt,&AttemptBinding {thread_id:"thread".into(),user_message_id:format!("user-{n}"),assistant_message_id:format!("answer-{n}"),parent_thread_id:None,branch_message_id:None,display_message:DisplayMessage {text:format!("Question {n}"),addressed_label:None,attachment_refs:Vec::new()}},0)?;Ok(receipt)
    }).unwrap()
}
fn complete_at(conn:&Connection,receipt:&Receipt,now:i64){
    tx(conn,|conn|{
        // Fixtures place the existing generation in a terminal state, then
        // exercise the SAME production archive helper with a finite fake clock.
        conn.execute("UPDATE chat_generation_runs SET state='completed' WHERE run_id=?1",[&receipt.current_run_id]).unwrap();
        conn.execute("UPDATE chat_generations SET state='completed' WHERE generation_id=?1",[&receipt.generation_id]).unwrap();
        settle_rows(conn,scope(),&receipt.generation_id,&receipt.current_run_id,now)
    }).unwrap();
}
#[test]
fn conversations_retention_setting_requires_explicit_revisioned_choice(){
    let conn=db();assert_eq!(choice(&conn,scope()).unwrap(),RetentionChoice::Off);
    let chosen=tx(&conn,|conn|set_rows(conn,scope(),RetentionChoice::Days90,0));
    assert_eq!(chosen,Ok(Setting {choice:RetentionChoice::Days90,revision:1}));
    assert_eq!(tx(&conn,|conn|set_rows(conn,scope(),RetentionChoice::Forever,0)),Err(Error::Conflict));
    assert_eq!(choice(&conn,Scope {store:"other-store",..scope()}).unwrap(),RetentionChoice::Off);
}
#[test]
fn conversations_retention_30day_exact_boundary_expires_old_message_in_active_thread(){
    let conn=db();conn.execute("INSERT INTO conversation_retention(owner_person,vault_id,store_uuid,choice) VALUES('human:me',?1,'store','days30')",[VAULT]).unwrap();
    let old=begin(&conn,1);complete_at(&conn,&old,1000);let live=begin(&conn,2);
    assert_eq!(tx(&conn,|conn|prune_rows(conn,scope(),2_592_000_999)).unwrap().removed_messages,0);
    let report=tx(&conn,|conn|prune_rows(conn,scope(),2_592_001_000)).unwrap();
    assert_eq!(report.removed_messages,1);assert_eq!(report.removed_search_rows,1);assert!(report.logical_bytes_released>0);
    let state:String=conn.query_row("SELECT state FROM chat_generations WHERE generation_id=?1",[live.generation_id],|row|row.get(0)).unwrap();assert_eq!(state,"admitted");
    let title:Option<String>=conn.query_row("SELECT title FROM conversation_threads",[],|row|row.get(0)).unwrap();assert_eq!(title,None);
}
#[test]
fn conversations_retention_90day_boundary_and_off_never_renew_old_completion(){
    let conn=db();conn.execute("INSERT INTO conversation_retention(owner_person,vault_id,store_uuid,choice) VALUES('human:me',?1,'store','days90')",[VAULT]).unwrap();let old=begin(&conn,1);complete_at(&conn,&old,1000);
    tx(&conn,|conn|generations::finish_rows(conn,scope(),&old.current_run_id,End::Completed)).unwrap();
    conn.execute("UPDATE conversation_retention SET choice='off'",[]).unwrap();
    assert_eq!(tx(&conn,|conn|prune_rows(conn,scope(),7_776_000_999)).unwrap().removed_messages,0);
    assert_eq!(tx(&conn,|conn|prune_rows(conn,scope(),7_776_001_000)).unwrap().removed_messages,1);
}
#[test]
fn conversations_delete_blocks_live_owner_without_stopping_then_tombstones_content(){
    let conn=db();conn.execute("INSERT INTO conversation_retention(owner_person,vault_id,store_uuid,choice) VALUES('human:me',?1,'store','forever')",[VAULT]).unwrap();let live=begin(&conn,1);
    let result=tx(&conn,|conn|delete_rows(conn,scope(),"thread",2000)).unwrap();assert!(matches!(result,DeleteResult::BlockedActive {ref owners} if !owners.is_empty()));
    let state:String=conn.query_row("SELECT state FROM chat_generations WHERE generation_id=?1",[&live.generation_id],|row|row.get(0)).unwrap();assert_eq!(state,"admitted");
    complete_at(&conn,&live,3000);
    assert_eq!(tx(&conn,|conn|delete_rows(conn,scope(),"thread",4000)),Ok(DeleteResult::Deleted));
    tx(&conn,|conn|settle_rows(conn,scope(),&live.generation_id,&live.current_run_id,5000)).unwrap();
    let counts:(i64,i64)=conn.query_row("SELECT (SELECT count(*) FROM conversation_content),(SELECT count(*) FROM conversation_search)",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();assert_eq!(counts,(0,0));
    assert_eq!(tx(&conn,|conn|delete_rows(conn,scope(),"thread",6000)),Ok(DeleteResult::AlreadyDeleted));
}

fn parent_native(conn:&Connection,receipt:&Receipt){
    let stamp="2026-10-26T00:00:00Z";
    conn.execute("INSERT INTO app_sessions(session_id,vault_id,store_uuid,opened_at,last_heartbeat_at,close_precision) VALUES(?1,?2,'store',?3,?3,'open')",params![scope().process,VAULT,stamp]).unwrap();
    conn.execute("INSERT INTO runs(run_id,vault_id,store_uuid,mode,lane,started_at,outcome,usage_state,input_tokens,output_tokens,cache_read,cache_write,reserved_total_tokens,reserved_output_tokens,proposals_submitted,applied,rejected,actor,cli_session_id) VALUES(?1,?2,'store','attended',(SELECT lane FROM lane_registry LIMIT 1),?3,'running','pending',0,0,0,0,0,0,0,0,0,'claude-code','12345678-1234-1234-1234-123456789abc')",params![receipt.first_run_id,VAULT,stamp]).unwrap();
    conn.execute("INSERT INTO action_native_runs(run_id,authority_id,revision,vault_id,store_uuid,canonical_vault_path,owner_person,actor_id,source_kind,app_session_id,cli_session_id,admitted_at) VALUES(?1,?2,1,?3,'store','/retention-fixture','human:me','claude-code','run',?4,'12345678-1234-1234-1234-123456789abc',?5)",params![receipt.first_run_id,"1".repeat(32),VAULT,scope().process,stamp]).unwrap();
    conn.execute("INSERT INTO chat_parent_attempts(parent_run_id,attempt_id,authority_id) VALUES(?1,?2,?3)",params![receipt.first_run_id,"2".repeat(32),"1".repeat(32)]).unwrap();
}
#[test]
fn conversations_delete_reserved_child_blocks_without_cancelling_any_owner(){
    let conn=db();let parent=begin(&conn,1);parent_native(&conn,&parent);complete_at(&conn,&parent,1000);
    conn.execute("INSERT INTO chat_delegation_intents(slot_id,request_key,parent_run_id,attempt_id,authority_id,authority_revision,owner_person,vault_id,store_uuid,parent_cli_session_id,app_session_id,actor_id,slot_ordinal) VALUES(?1,?2,?3,?4,?5,1,'human:me',?6,'store','12345678-1234-1234-1234-123456789abc',?7,'claude-code',0)",params!["3".repeat(32),"4".repeat(32),parent.first_run_id,"2".repeat(32),"1".repeat(32),VAULT,scope().process]).unwrap();
    conn.execute("INSERT INTO child_job_reservations(slot_id,job_id,reserved_run_id,reserved_cli_session_id,request_digest,deadline_at,elapsed_seconds,result_bytes,occupies_slot) VALUES(?1,?2,?3,'12345678-1234-1234-1234-123456789abd',?4,10000,5,1024,1)",params!["3".repeat(32),"5".repeat(32),"6".repeat(32),"a".repeat(64)]).unwrap();
    let result=tx(&conn,|conn|delete_rows(conn,scope(),"thread",2000)).unwrap();
    assert!(matches!(result,DeleteResult::BlockedActive {ref owners} if owners.contains(&"5".repeat(32))));
    let occupied:i64=conn.query_row("SELECT occupies_slot FROM child_job_reservations",[],|row|row.get(0)).unwrap();assert_eq!(occupied,1);
}
#[test]
fn conversations_delete_pending_write_approval_blocks_without_resolving_it(){
    let conn=db();let parent=begin(&conn,1);complete_at(&conn,&parent,1000);
    conn.execute("INSERT INTO pending_writes(pending_id,vault_id,run_id,actor,tool,target,input,input_hash,grant_json,queued_at) VALUES(?1,?2,?3,'process:writer','append_note','notes/report.md','{}',?4,'{}','2026-10-26T00:00:00Z')",params!["7".repeat(32),VAULT,parent.first_run_id,"a".repeat(64)]).unwrap();
    let result=tx(&conn,|conn|delete_rows(conn,scope(),"thread",2000)).unwrap();
    assert!(matches!(result,DeleteResult::BlockedActive {ref owners} if owners.contains(&"7".repeat(32))));
    let state:String=conn.query_row("SELECT state FROM pending_writes",[],|row|row.get(0)).unwrap();assert_eq!(state,"pending");
}
#[test]
fn conversations_retention_forever_at_real_256mib_capacity_never_evicts_admitted_content(){
    let conn=db();let cleanup=std::path::Path::new(conn.path().unwrap()).parent().unwrap().to_owned();
    conn.execute("INSERT INTO conversation_retention(owner_person,vault_id,store_uuid,choice) VALUES('human:me',?1,'store','forever')",[VAULT]).unwrap();
    let words="x".repeat(crate::agent::journal::RUN_BYTES-4096);
    let turn=crate::agent::archive_codec::ArchiveTurnV1 {version:1,blocks:vec![crate::agent::archive_codec::Block::Text {message_id:"large-answer".into(),text:words}],availability:crate::agent::archive_codec::Availability::Complete,references:Vec::new(),last_uuid:None};
    for n in 1..=64 {
        let receipt=begin(&conn,n);
        tx(&conn,|conn|stage_rows(conn,scope(),&receipt.current_run_id,&turn)).unwrap();complete_at(&conn,&receipt,i64::from(n)*1000);
    }
    let (count,bytes):(i64,i64)=conn.query_row("SELECT count(*),sum(logical_bytes) FROM conversation_content",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();assert_eq!(count,64);assert!(bytes<=268_435_456);
    let refused=begin(&conn,65);tx(&conn,|conn|stage_rows(conn,scope(),&refused.current_run_id,&turn)).unwrap();complete_at(&conn,&refused,65000);
    let after:(i64,i64)=conn.query_row("SELECT count(*),sum(logical_bytes) FROM conversation_content",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();assert_eq!(after,(count,bytes));
    let state:String=conn.query_row("SELECT archive_state FROM conversation_bindings WHERE generation_id=?1",[refused.generation_id],|row|row.get(0)).unwrap();assert_eq!(state,"unavailable");
    drop(conn);std::fs::remove_dir_all(cleanup).unwrap();
}

#[test]
fn conversations_retention_two_stores_share_actual_vault_capacity_without_cross_store_read(){
 let conn=db();struct Cleanup(std::path::PathBuf);impl Drop for Cleanup {fn drop(&mut self){let _=std::fs::remove_dir_all(&self.0);}}
 let _cleanup=Cleanup(std::path::Path::new(conn.path().unwrap()).parent().unwrap().to_owned());
 tx(&conn,|conn|set_rows(conn,scope(),RetentionChoice::Forever,0)).unwrap();
 let turn=ArchiveTurnV1 {version:1,blocks:vec![Block::Text {message_id:"old-store-body".into(),text:"x".repeat(crate::agent::journal::RUN_BYTES-4096)}],availability:Availability::Complete,references:Vec::new(),last_uuid:None};
 let first=begin(&conn,1);tx(&conn,|conn|stage_rows(conn,scope(),&first.current_run_id,&turn)).unwrap();complete_at(&conn,&first,1000);
 let replacement=Scope {store:"replacement-store",..scope()};tx(&conn,|conn|set_rows(conn,replacement,RetentionChoice::Forever,0)).unwrap();
 let used:i64=conn.query_row("SELECT sum(logical_bytes) FROM conversation_content",[],|row|row.get(0)).unwrap();
 assert_eq!(crate::conversations::rows::setting(&conn,replacement).unwrap().logical_bytes.get(),used as u64,"per-vault capacity cannot forget unexpired bytes in a retired store");
 assert!(crate::conversations::rows::threads(&conn,replacement,None,None,50,1001).unwrap().items.is_empty(),"aggregate size does not authorize old-store body/title reads");
 for n in 2..=64 {let receipt=begin(&conn,n);tx(&conn,|conn|stage_rows(conn,scope(),&receipt.current_run_id,&turn)).unwrap();complete_at(&conn,&receipt,i64::from(n)*1000);}
 let Admission::New(receipt)=tx(&conn,|conn|generations::begin_rows(conn,replacement,&"f".repeat(32),&"b".repeat(64))).unwrap() else{panic!("replacement original")};
 tx(&conn,|conn|{begin_rows(conn,replacement,&receipt,&AttemptBinding {thread_id:"replacement-thread".into(),user_message_id:"replacement-question".into(),assistant_message_id:"replacement-answer".into(),parent_thread_id:None,branch_message_id:None,display_message:DisplayMessage {text:"Replacement question".into(),addressed_label:None,attachment_refs:Vec::new()}},65_000)?;stage_rows(conn,replacement,&receipt.current_run_id,&turn)?;conn.execute("UPDATE chat_generation_runs SET state='completed' WHERE run_id=?1",[&receipt.current_run_id]).unwrap();conn.execute("UPDATE chat_generations SET state='completed' WHERE generation_id=?1",[&receipt.generation_id]).unwrap();settle_rows(conn,replacement,&receipt.generation_id,&receipt.current_run_id,65_000)}).unwrap();
 let state:String=conn.query_row("SELECT archive_state FROM conversation_bindings WHERE generation_id=?1",[receipt.generation_id],|row|row.get(0)).unwrap();assert_eq!(state,"unavailable");
 let count:i64=conn.query_row("SELECT count(*) FROM conversation_content",[],|row|row.get(0)).unwrap();assert_eq!(count,64,"replacement cannot evict or duplicate the original cap");
}
