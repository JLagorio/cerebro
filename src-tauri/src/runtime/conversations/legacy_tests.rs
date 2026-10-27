use super::*;
use rusqlite::{Transaction,TransactionBehavior};
const VAULT:&str="dddddddddddddddddddddddddddddddd";
fn scope()->Scope<'static>{Scope {owner:"human:me",vault:VAULT,store:"store",actor:"human:me",process:"legacy-test-process"}}
fn batch()->ImportBatch {ImportBatch {source_vault_path:"/selected-vault".into(),thread_id:"old-thread".into(),attempts:vec![LegacyAttempt {user_message_id:"old-question".into(),assistant_message_id:"old-answer".into(),display_message:DisplayMessage {text:"Cached question".into(),addressed_label:None,attachment_refs:Vec::new()},answer:ArchiveTurnV1 {version:1,blocks:vec![Block::Text {message_id:"cached-final".into(),text:"Cached answer".into()}],availability:Availability::Partial,references:Vec::new(),last_uuid:None},completed_at:None,session_id:None}]}}
struct Fixture{conn:Connection,data:std::path::PathBuf}
impl Fixture{fn new(choice:RetentionChoice)->Self{let data=crate::vault::testutil::temp_vault("archive-legacy-import");let conn=crate::runtime::open(&data).unwrap();conn.execute("INSERT INTO vault_registry(vault_id,vault_path,first_seen_at) VALUES(?1,'/selected-vault','2026-10-26T00:00:00Z')",[VAULT]).unwrap();let tx=Transaction::new_unchecked(&conn,TransactionBehavior::Immediate).unwrap();super::super::retention::set_rows(&tx,scope(),choice,0).unwrap();tx.commit().unwrap();Self{conn,data}}}
impl Drop for Fixture{fn drop(&mut self){let _=std::fs::remove_dir_all(&self.data);}}
#[test]
fn archive_legacy_import_forever_preserves_ids_unknown_completion_and_no_fake_generation(){
 let fixture=Fixture::new(RetentionChoice::Forever);let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();
 let items=import_rows(&tx,scope(),&batch(),1000).unwrap();assert!(matches!(items.as_slice(),[ImportItem::Retained {user_message_id,assistant_message_id,..}] if user_message_id=="old-question"&&assistant_message_id=="old-answer"));tx.commit().unwrap();
 let count:i64=fixture.conn.query_row("SELECT count(*) FROM chat_generations",[],|row|row.get(0)).unwrap();assert_eq!(count,0,"import cannot manufacture an execution attempt");
 let row:(Option<i64>,i64)=fixture.conn.query_row("SELECT original_completed_at,imported_at FROM conversation_legacy_attempts",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();assert_eq!(row,(None,1000));
 let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();let again=import_rows(&tx,scope(),&batch(),2000).unwrap();assert!(matches!(again.as_slice(),[ImportItem::Retained {..}]));tx.commit().unwrap();
 let count:i64=fixture.conn.query_row("SELECT count(*) FROM conversation_legacy_content",[],|row|row.get(0)).unwrap();assert_eq!(count,1);
 let imported:i64=fixture.conn.query_row("SELECT imported_at FROM conversation_legacy_attempts",[],|row|row.get(0)).unwrap();assert_eq!(imported,1000,"retry cannot renew age/order");
}
#[test]
fn archive_legacy_import_timed_unknown_and_off_do_not_create_body_or_timestamp(){
 for choice in [RetentionChoice::Days30,RetentionChoice::Off] {
  let fixture=Fixture::new(choice);let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();let result=import_rows(&tx,scope(),&batch(),1000).unwrap();let reason=if choice==RetentionChoice::Off {ImportSkip::Off}else{ImportSkip::UnknownCompletion};assert!(matches!(result.as_slice(),[ImportItem::Skipped {reason:actual,..}] if actual==&reason));tx.commit().unwrap();
  let count:i64=fixture.conn.query_row("SELECT count(*) FROM conversation_legacy_content",[],|row|row.get(0)).unwrap();assert_eq!(count,0);
 }
}
#[test]
fn archive_legacy_import_partial_conflict_and_tombstone_do_not_overwrite_or_resurrect(){
 let fixture=Fixture::new(RetentionChoice::Forever);let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();import_rows(&tx,scope(),&batch(),1000).unwrap();tx.commit().unwrap();
 let mut changed=batch();changed.attempts[0].display_message.text="Rewritten question".into();changed.attempts.push(LegacyAttempt {user_message_id:"second-question".into(),assistant_message_id:"second-answer".into(),..batch().attempts.remove(0)});
 let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();let result=import_rows(&tx,scope(),&changed,2000).unwrap();assert!(matches!(result.as_slice(),[ImportItem::Skipped {reason:ImportSkip::Conflict,..},ImportItem::Retained {..}]));tx.commit().unwrap();
 let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();super::super::retention::delete_rows(&tx,scope(),"old-thread",3000).unwrap();tx.commit().unwrap();
 let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();let result=import_rows(&tx,scope(),&batch(),4000).unwrap();assert!(result.iter().all(|item|matches!(item,ImportItem::Skipped {reason:ImportSkip::Conflict,..})));tx.commit().unwrap();
 let count:i64=fixture.conn.query_row("SELECT count(*) FROM conversation_legacy_content",[],|row|row.get(0)).unwrap();assert_eq!(count,0);
}
#[test]
fn archive_legacy_import_contract_rejects_raw_payload_and_assembled_prompt_fields(){
 let mut value=serde_json::to_value(batch()).unwrap();value["attempts"][0]["rawOutput"]=serde_json::json!("PRIVATE");assert!(serde_json::from_value::<ImportBatch>(value).is_err());
}

#[test]
fn archive_legacy_import_requires_actual_durable_readback_and_refuses_missing_body(){
 let fixture=Fixture::new(RetentionChoice::Forever);let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();let items=import_rows(&tx,scope(),&batch(),1000).unwrap();tx.commit().unwrap();
 let path=crate::runtime::runtime_db_path(&fixture.data);let read=Connection::open_with_flags(&path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();read.pragma_update(None,"query_only",true).unwrap();verify_rows(&read,scope(),&items,1001).unwrap();assert!(read.execute("DELETE FROM conversation_legacy_content",[]).is_err());drop(read);
 fixture.conn.execute("DELETE FROM conversation_legacy_content",[]).unwrap();let read=Connection::open_with_flags(path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();assert!(verify_rows(&read,scope(),&items,1001).is_err(),"a committed identity without actual bytes cannot clear a browser copy");
}
#[test]
fn archive_legacy_import_unifies_partial_timed_search_expiry_and_delete(){
 let fixture=Fixture::new(RetentionChoice::Days30);let mut selected=batch();selected.attempts[0].completed_at=Some(crate::actions::SafeCounter::new(1000).unwrap());selected.attempts.push(LegacyAttempt {user_message_id:"unknown-question".into(),assistant_message_id:"unknown-answer".into(),..batch().attempts.remove(0)});
 let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();let result=import_rows(&tx,scope(),&selected,1001).unwrap();assert!(matches!(result.as_slice(),[ImportItem::Retained {..},ImportItem::Skipped {reason:ImportSkip::UnknownCompletion,..}]));tx.commit().unwrap();
 let page=crate::conversations::rows::messages(&fixture.conn,scope(),"old-thread",None,50,1002).unwrap();assert_eq!(page.items.len(),1);assert!(page.items[0].run_id.is_none());assert_eq!(page.items[0].origin,crate::conversations::transport::ContentOrigin::BrowserCache);assert_eq!(page.items[0].completed_at.as_deref(),Some("1970-01-01T00:00:01.000Z"));assert_eq!(page.items[0].imported_at.as_deref(),Some("1970-01-01T00:00:01.001Z"));
 assert_eq!(crate::conversations::rows::threads(&fixture.conn,scope(),None,Some("Cached answer"),50,2_592_000_999).unwrap().items.len(),1);
 assert!(crate::conversations::rows::threads(&fixture.conn,scope(),None,Some("Cached answer"),50,2_592_001_000).unwrap().items.is_empty());
 let expired=crate::conversations::rows::messages(&fixture.conn,scope(),"old-thread",None,50,2_592_001_000).unwrap();assert!(expired.items[0].content.is_none());assert_eq!(expired.items[0].content_state,crate::conversations::transport::ContentState::Expired);
 let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();let report=super::super::retention::prune_rows(&tx,scope(),2_592_001_000).unwrap();assert_eq!(report.removed_messages,1);assert_eq!(report.removed_search_rows,1);super::super::retention::delete_rows(&tx,scope(),"old-thread",2_592_001_001).unwrap();tx.commit().unwrap();assert!(crate::conversations::rows::threads(&fixture.conn,scope(),None,None,50,2_592_001_002).unwrap().items.is_empty());
}
#[test]
fn archive_legacy_import_unknown_completion_stays_null_in_read(){
 let fixture=Fixture::new(RetentionChoice::Forever);let mut selected=batch();selected.attempts[0].session_id=Some("55555555-5555-4555-8555-555555555555".into());let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();let items=import_rows(&tx,scope(),&selected,1000).unwrap();tx.commit().unwrap();verify_rows(&fixture.conn,scope(),&items,1001).unwrap();
 let page=crate::conversations::rows::messages(&fixture.conn,scope(),"old-thread",None,50,1001).unwrap();assert!(page.items[0].completed_at.is_none());assert!(page.items[0].run_id.is_none());assert_eq!(page.items[0].imported_at.as_deref(),Some("1970-01-01T00:00:01.000Z"));assert_eq!(page.items[0].content.as_ref().unwrap().completion_status,"not_recorded");
}
#[test]
fn archive_legacy_import_preserves_selected_registration_and_refuses_active_generation(){
 let fixture=Fixture::new(RetentionChoice::Forever);let mut foreign=batch();foreign.source_vault_path="/another-vault".into();let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();assert!(import_rows(&tx,scope(),&foreign,1000).is_err());tx.rollback().unwrap();
 let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();let super::super::super::chat_generations::Admission::New(receipt)=super::super::super::chat_generations::begin_rows(&tx,scope(),&"1".repeat(32),&"a".repeat(64)).unwrap() else{panic!("new original")};
 super::super::begin_rows(&tx,scope(),&receipt,&AttemptBinding {thread_id:"old-thread".into(),user_message_id:"active-question".into(),assistant_message_id:"active-answer".into(),parent_thread_id:None,branch_message_id:None,display_message:batch().attempts.remove(0).display_message},1000).unwrap();let result=import_rows(&tx,scope(),&batch(),1001).unwrap();assert!(matches!(result.as_slice(),[ImportItem::Skipped {reason:ImportSkip::BlockedActive,..}]));tx.commit().unwrap();
 let count:i64=fixture.conn.query_row("SELECT count(*) FROM conversation_legacy_content",[],|row|row.get(0)).unwrap();assert_eq!(count,0);
}
#[test]
#[ignore="bounded actual shared256MiB admission control; root invokes separately"]
fn archive_legacy_import_shares_actual_256mib_budget_with_native_producer_without_eviction(){
 let fixture=Fixture::new(RetentionChoice::Forever);let words="x".repeat(crate::agent::journal::RUN_BYTES-4096);
 for n in 0..63 {let mut selected=batch();selected.attempts[0].user_message_id=format!("legacy-question-{n}");selected.attempts[0].assistant_message_id=format!("legacy-answer-{n}");selected.attempts[0].answer.blocks=vec![Block::Text {message_id:"large".into(),text:words.clone()}];let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();assert!(matches!(import_rows(&tx,scope(),&selected,1000).unwrap().as_slice(),[ImportItem::Retained {..}]));tx.commit().unwrap();}
 let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();let super::super::super::chat_generations::Admission::New(receipt)=super::super::super::chat_generations::begin_rows(&tx,scope(),&"2".repeat(32),&"b".repeat(64)).unwrap() else{panic!("original native")};super::super::begin_rows(&tx,scope(),&receipt,&AttemptBinding {thread_id:"native-thread".into(),user_message_id:"native-question".into(),assistant_message_id:"native-answer".into(),parent_thread_id:None,branch_message_id:None,display_message:batch().attempts.remove(0).display_message},1000).unwrap();let turn=ArchiveTurnV1 {version:1,blocks:vec![Block::Text {message_id:"native-body".into(),text:words.clone()}],availability:Availability::Complete,references:Vec::new(),last_uuid:None};super::super::stage_rows(&tx,scope(),&receipt.current_run_id,&turn).unwrap();tx.execute("UPDATE chat_generation_runs SET state='completed' WHERE run_id=?1",[&receipt.current_run_id]).unwrap();tx.execute("UPDATE chat_generations SET state='completed' WHERE generation_id=?1",[&receipt.generation_id]).unwrap();super::super::settle_rows(&tx,scope(),&receipt.generation_id,&receipt.current_run_id,1000).unwrap();tx.commit().unwrap();
 let mut overflow=batch();overflow.attempts[0].user_message_id="overflow-question".into();overflow.attempts[0].assistant_message_id="overflow-answer".into();overflow.attempts[0].answer.blocks=vec![Block::Text {message_id:"overflow".into(),text:words}];let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();assert!(matches!(import_rows(&tx,scope(),&overflow,1000).unwrap().as_slice(),[ImportItem::Skipped {reason:ImportSkip::Unavailable,..}]));tx.commit().unwrap();let count:i64=fixture.conn.query_row("SELECT (SELECT count(*) FROM conversation_content)+(SELECT count(*) FROM conversation_legacy_content)",[],|row|row.get(0)).unwrap();assert_eq!(count,64,"all admitted unexpired native+legacy bodies remain");
}

#[test]
fn archive_legacy_import_schema_names_match_actual_serde_wire_fields(){
 let schema=serde_json::to_value(schemars::schema_for!(ImportItem)).unwrap();
 for item in [ImportItem::Retained {attempt_id:"attempt".into(),user_message_id:"question".into(),assistant_message_id:"answer".into()},ImportItem::Skipped {user_message_id:"question".into(),assistant_message_id:"answer".into(),reason:ImportSkip::UnknownCompletion}] {
  let wire=serde_json::to_value(item).unwrap();let alternatives=schema["oneOf"].as_array().or_else(||schema["anyOf"].as_array()).unwrap();let shape=alternatives.iter().find(|shape|shape["properties"]["state"]["enum"][0]==wire["state"]).unwrap();
  for field in wire.as_object().unwrap().keys(){assert!(shape["properties"].get(field).is_some(),"actual serialized field {field} missing from generated contract");}
 }
}

#[test]
fn archive_legacy_import_capacity_counts_unexpired_retired_store_but_not_expired_physical_residue(){
 let fixture=Fixture::new(RetentionChoice::Days30);let mut selected=batch();selected.attempts[0].completed_at=Some(crate::actions::SafeCounter::new(1000).unwrap());let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();import_rows(&tx,scope(),&selected,1001).unwrap();tx.commit().unwrap();
 let replacement=Scope {store:"replacement",..scope()};assert!(used_bytes(&fixture.conn,replacement,2_592_000_999).unwrap()>0);assert_eq!(used_bytes(&fixture.conn,replacement,2_592_001_000).unwrap(),0,"expired old-store physical bytes do not consume logical capacity");
 let physical:i64=fixture.conn.query_row("SELECT count(*) FROM conversation_legacy_content",[],|row|row.get(0)).unwrap();assert_eq!(physical,1,"logical accounting does not widen physical deletion authority");assert!(crate::conversations::rows::messages(&fixture.conn,replacement,"old-thread",None,50,1001).is_err(),"capacity accounting never authorizes cross-store content reads");
}

fn original_without_archive(fixture:&Fixture,selected:&ImportBatch,oversize:bool)->String{
 let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();let super::super::super::chat_generations::Admission::New(receipt)=super::super::super::chat_generations::begin_rows(&tx,scope(),&"3".repeat(32),&"c".repeat(64)).unwrap() else{panic!("original native")};
 super::super::begin_rows(&tx,scope(),&receipt,&AttemptBinding {thread_id:selected.thread_id.clone(),user_message_id:selected.attempts[0].user_message_id.clone(),assistant_message_id:selected.attempts[0].assistant_message_id.clone(),parent_thread_id:None,branch_message_id:None,display_message:selected.attempts[0].display_message.clone()},100).unwrap();
 if oversize {let turn=ArchiveTurnV1 {version:1,blocks:vec![Block::Text {message_id:"original".into(),text:"x".repeat(crate::agent::journal::RUN_BYTES-4096)}],availability:Availability::Complete,references:Vec::new(),last_uuid:None};super::super::stage_rows(&tx,scope(),&receipt.current_run_id,&turn).unwrap();}
 tx.execute("UPDATE chat_generation_runs SET state='completed' WHERE run_id=?1",[&receipt.current_run_id]).unwrap();tx.execute("UPDATE chat_generations SET state='completed' WHERE generation_id=?1",[&receipt.generation_id]).unwrap();super::super::settle_rows(&tx,scope(),&receipt.generation_id,&receipt.current_run_id,1000).unwrap();tx.commit().unwrap();receipt.generation_id
}
fn copy_completed_native_cache(original_choice:RetentionChoice,oversize:bool,expected:&str){
 let fixture=Fixture::new(original_choice);let mut selected=batch();if oversize {selected.attempts[0].display_message.text="Q".repeat(DISPLAY_BYTES-4096);}
 let generation=original_without_archive(&fixture,&selected,oversize);let before:String=fixture.conn.query_row("SELECT archive_state FROM conversation_bindings WHERE generation_id=?1",[&generation],|row|row.get(0)).unwrap();assert_eq!(before,expected);let native_bodies:i64=fixture.conn.query_row("SELECT count(*) FROM conversation_content",[],|row|row.get(0)).unwrap();assert_eq!(native_bodies,0);
 if original_choice!=RetentionChoice::Forever {let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();super::super::retention::set_rows(&tx,scope(),RetentionChoice::Forever,1).unwrap();tx.commit().unwrap();}
 let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();let imported=import_rows(&tx,scope(),&selected,2000).unwrap();assert!(matches!(imported.as_slice(),[ImportItem::Retained {user_message_id,assistant_message_id,..}] if user_message_id=="old-question"&&assistant_message_id=="old-answer"),"explicit checked cache import may copy exact completed metadata identity with no native body");tx.commit().unwrap();verify_rows(&fixture.conn,scope(),&imported,2001).unwrap();
 let after:(String,i64)=fixture.conn.query_row("SELECT archive_state,completed_at FROM conversation_bindings WHERE generation_id=?1",[&generation],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();assert_eq!(after,(expected.into(),1000),"native completion and original retention state stay immutable");let count:i64=fixture.conn.query_row("SELECT count(*) FROM chat_generations",[],|row|row.get(0)).unwrap();assert_eq!(count,1,"no fake execution generation");
 let page=crate::conversations::rows::messages(&fixture.conn,scope(),"old-thread",None,50,2001).unwrap();assert_eq!(page.items.len(),1,"same original message identity must have one content projection");assert_eq!(page.items[0].completed_at.as_deref(),Some("1970-01-01T00:00:01.000Z"));assert_eq!(page.items[0].imported_at.as_deref(),Some("1970-01-01T00:00:02.000Z"));assert_eq!(page.items[0].origin,crate::conversations::transport::ContentOrigin::BrowserCache);assert!(page.items[0].content.as_ref().unwrap().answer.search_text().contains("Cached answer"));
}
#[test]
fn archive_legacy_import_explicitly_copies_completed_off_binding_without_changing_native_history(){copy_completed_native_cache(RetentionChoice::Off,false,"off");}
#[test]
fn archive_legacy_import_explicitly_copies_completed_unavailable_binding_without_changing_native_history(){copy_completed_native_cache(RetentionChoice::Forever,true,"unavailable");}

#[test]
fn archive_legacy_import_native_copy_refuses_active_expired_deleted_and_conflicting_metadata(){
 let active=Fixture::new(RetentionChoice::Forever);let tx=Transaction::new_unchecked(&active.conn,TransactionBehavior::Immediate).unwrap();let super::super::super::chat_generations::Admission::New(receipt)=super::super::super::chat_generations::begin_rows(&tx,scope(),&"4".repeat(32),&"d".repeat(64)).unwrap() else{panic!("new active")};super::super::begin_rows(&tx,scope(),&receipt,&AttemptBinding {thread_id:"old-thread".into(),user_message_id:"old-question".into(),assistant_message_id:"old-answer".into(),parent_thread_id:None,branch_message_id:None,display_message:batch().attempts.remove(0).display_message},100).unwrap();let result=import_rows(&tx,scope(),&batch(),2000).unwrap();assert!(matches!(result.as_slice(),[ImportItem::Skipped {reason:ImportSkip::BlockedActive,..}]));tx.commit().unwrap();
 for deleted in [false,true] {
  let fixture=Fixture::new(if deleted {RetentionChoice::Off}else{RetentionChoice::Days30});let selected=batch();let generation=original_without_archive(&fixture,&selected,false);let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();
  if deleted {super::super::retention::delete_rows(&tx,scope(),"old-thread",2000).unwrap();}else{super::super::retention::prune_rows(&tx,scope(),2_592_001_000).unwrap();}
  super::super::retention::set_rows(&tx,scope(),RetentionChoice::Forever,1).unwrap();let result=import_rows(&tx,scope(),&selected,2_592_001_001).unwrap();assert!(matches!(result.as_slice(),[ImportItem::Skipped {reason:ImportSkip::Conflict,..}])||matches!(result.as_slice(),[ImportItem::Skipped {reason:ImportSkip::Expired,..}]));tx.commit().unwrap();
  let count:i64=fixture.conn.query_row("SELECT count(*) FROM conversation_legacy_content",[],|row|row.get(0)).unwrap();assert_eq!(count,0);let at:i64=fixture.conn.query_row("SELECT completed_at FROM conversation_bindings WHERE generation_id=?1",[generation],|row|row.get(0)).unwrap();assert_eq!(at,1000);
 }
 let fixture=Fixture::new(RetentionChoice::Off);let generation=original_without_archive(&fixture,&batch(),false);let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();super::super::retention::set_rows(&tx,scope(),RetentionChoice::Forever,1).unwrap();let mut changed=batch();changed.thread_id="different-thread".into();assert!(matches!(import_rows(&tx,scope(),&changed,2000).unwrap().as_slice(),[ImportItem::Skipped {reason:ImportSkip::Conflict,..}]));tx.commit().unwrap();let state:String=fixture.conn.query_row("SELECT archive_state FROM conversation_bindings WHERE generation_id=?1",[generation],|row|row.get(0)).unwrap();assert_eq!(state,"off");
}
#[test]
fn archive_legacy_import_native_copy_uses_frozen_original_time_for_timed_choice_and_retry(){
 let fixture=Fixture::new(RetentionChoice::Off);let generation=original_without_archive(&fixture,&batch(),false);let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();super::super::retention::set_rows(&tx,scope(),RetentionChoice::Days30,1).unwrap();let mut forged=batch();forged.attempts[0].completed_at=Some(crate::actions::SafeCounter::new(2000).unwrap());assert!(matches!(import_rows(&tx,scope(),&forged,2000).unwrap().as_slice(),[ImportItem::Skipped {reason:ImportSkip::Conflict,..}]));let items=import_rows(&tx,scope(),&batch(),2000).unwrap();assert!(matches!(items.as_slice(),[ImportItem::Retained {..}]));tx.commit().unwrap();verify_rows(&fixture.conn,scope(),&items,2001).unwrap();
 let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();assert!(matches!(import_rows(&tx,scope(),&batch(),3000).unwrap().as_slice(),[ImportItem::Retained {..}]));tx.commit().unwrap();
 let actual:(Option<i64>,Option<i64>,i64)=fixture.conn.query_row("SELECT original_completed_at,expires_at,imported_at FROM conversation_legacy_attempts",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();assert_eq!(actual,(Some(1000),Some(2_592_001_000),2000));let original:(String,i64,Option<i64>)=fixture.conn.query_row("SELECT archive_state,completed_at,expires_at FROM conversation_bindings WHERE generation_id=?1",[generation],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();assert_eq!(original,("off".into(),1000,None));
}
#[test]
fn archive_legacy_import_native_copy_suppresses_metadata_before_cursor_limit(){
 let fixture=Fixture::new(RetentionChoice::Off);original_without_archive(&fixture,&batch(),false);let mut selected=batch();selected.attempts.push(LegacyAttempt {user_message_id:"second-question".into(),assistant_message_id:"second-answer".into(),..batch().attempts.remove(0)});
 let tx=Transaction::new_unchecked(&fixture.conn,TransactionBehavior::Immediate).unwrap();super::super::retention::set_rows(&tx,scope(),RetentionChoice::Forever,1).unwrap();let result=import_rows(&tx,scope(),&selected,2000).unwrap();assert!(result.iter().all(|item|matches!(item,ImportItem::Retained {..})));tx.commit().unwrap();
 let first=crate::conversations::rows::messages(&fixture.conn,scope(),"old-thread",None,1,2001).unwrap();assert_eq!(first.items.len(),1);assert!(first.next_cursor.is_some());let second=crate::conversations::rows::messages(&fixture.conn,scope(),"old-thread",first.next_cursor.as_deref(),1,2001).unwrap();assert_eq!(second.items.len(),1);assert!(second.next_cursor.is_none(),"excluded native metadata cannot create a phantom third page");let ids=std::collections::BTreeSet::from([first.items[0].assistant_message_id.as_str(),second.items[0].assistant_message_id.as_str()]);assert_eq!(ids,std::collections::BTreeSet::from(["old-answer","second-answer"]));
}
