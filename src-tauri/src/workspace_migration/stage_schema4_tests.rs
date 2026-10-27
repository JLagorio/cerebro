//! Actual explicit inactive producer/reopen path. No current vault or activation.
use super::*;
use rusqlite::Connection;
const WORKSPACE: &str="56e6fa9f-c236-49c1-99f7-0cac3d2ad5f3";
const RECORD: &str="6f6621e5-2853-4909-805b-d4824516914e";
struct Fixture { base:PathBuf, source:PathBuf, bodies:PathBuf, metadata:PathBuf, record:RecordProposal }
impl Fixture {
    fn new(label:&str)->Self {
        let base=crate::vault::testutil::temp_vault(&format!("m99-stage4-{label}"));let source=base.join("source");fs::create_dir_all(source.join("attachments")).unwrap();
        let bytes=b"---\r\ncode: '007'\r\n---\r\n# Page\r\n\r\nKeep **body** bytes.\r\n";fs::write(source.join("page.md"),bytes).unwrap();fs::write(source.join("attachments/a.bin"),[0,1,2,255]).unwrap();
        let metadata=serde_json::json!({"kind":"object","value":{"code":{"kind":"string","value":"007"},"present":{"kind":"null"},"huge":{"kind":"decimal","value":"90071992547409931234567890.00001e+200"},"nested":{"kind":"object","value":{"keep":{"kind":"string","value":"2026-10-26"}}},"related":{"kind":"relation","spelling":"[[Self]]","fragment":null,"resolution":{"status":"resolved","targetId":RECORD}}}});
        let record=RecordProposal{id:RECORD.into(),path:"page.md".into(),body_start:bytes.windows(6).position(|v|v==b"# Page").unwrap(),metadata_json:metadata.to_string(),required_parts:vec!["attachments/a.bin".into()]};
        Self{source,bodies:base.join("bodies"),metadata:base.join("metadata"),base,record}
    }
    fn plan(&self)->StagePlan {prepare_stage(&self.source,WORKSPACE,vec![self.record.clone()]).unwrap()}
    fn stage(&self)->StagedConversion{stage_conversion(self.plan(),&self.bodies,&self.metadata).unwrap()}
    fn conn(&self)->Connection{Connection::open(self.metadata.join("workspace.db")).unwrap()}
}
impl Drop for Fixture {fn drop(&mut self){let _=fs::remove_dir_all(&self.base);}}
fn republish_fixture_database(stage:&StagedConversion){
    let mut m=stage.manifest.clone();let bytes=fs::read(m.metadata.join(&rules().database)).unwrap();let part=m.parts.iter_mut().find(|p|p.location==Location::Metadata&&p.path==rules().database).unwrap();part.bytes=bytes.len()as u64;part.hash=crate::ledger::sha256_hex(&bytes);
    let bytes=serde_json::to_vec(&m).unwrap();let hash=crate::ledger::sha256_hex(&bytes);fs::write(m.bodies.join(&rules().manifest),bytes).unwrap();fs::write(m.bodies.join(&rules().marker),format_gate::marker_bytes("staged_inactive",Some(hash)).unwrap()).unwrap();
}
#[test]
fn actual_fresh_stage_emits_exact_schema4_with_empty_original_evidence_tables(){
    let f=Fixture::new("schema");let before=fs::read(f.source.join("page.md")).unwrap();let staged=f.stage();
    let schema:i64=f.conn().query_row("PRAGMA user_version",[],|r|r.get(0)).unwrap();assert_eq!(schema,4);
    let row:(i64,i64,i64,i64,i64)=f.conn().query_row("SELECT format,schema_revision,metadata_epoch,(SELECT count(*) FROM metadata_receipts),(SELECT count(*) FROM metadata_requests) FROM workspace",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();assert_eq!(row,(2,1,1,0,0));
    assert_eq!(fs::read(f.source.join("page.md")).unwrap(),before);assert!(validate_cutover(&staged).unwrap().whole_root_accounted);assert!(!validate_cutover(&staged).unwrap().activation_blockers.is_empty());
    assert_eq!(format_gate::read_marker(&f.bodies).unwrap().unwrap().state,"staged_inactive");
}
#[test]
fn actual_stage_reopens_through_bounded_offline_schema4_validation_with_exact_tags_and_bodies(){
    let f=Fixture::new("reopen");f.stage();let bytes=fs::read(f.metadata.join("workspace.db")).unwrap();
    let facts=crate::workspace_service::selected::backup::read_offline(&bytes,WORKSPACE,rules().limits.database_bytes).unwrap();assert_eq!(facts.schema_version,4);assert_eq!(facts.epoch,1);assert_eq!(facts.records.len(),1);
    let reopened=open_staged(&f.source,&f.bodies,&f.metadata,WORKSPACE).unwrap();let canonical=read_staged_metadata(&reopened,RECORD).unwrap();let value:serde_json::Value=serde_json::from_str(&canonical).unwrap();assert_eq!(value,serde_json::from_str::<serde_json::Value>(&f.record.metadata_json).unwrap());
    assert_eq!(value["value"]["huge"]["value"],"90071992547409931234567890.00001e+200");assert_eq!(value["value"]["code"]["kind"],"string");assert_eq!(value["value"]["code"]["value"],"007");assert_eq!(value["value"]["present"]["kind"],"null");
    let original=fs::read(f.source.join("page.md")).unwrap();assert_eq!(fs::read(f.bodies.join("page.md")).unwrap(),original[f.record.body_start..]);assert_eq!(fs::read(f.metadata.join("originals/page.md")).unwrap(),original);assert_eq!(fs::read(f.bodies.join("attachments/a.bin")).unwrap(),[0,1,2,255]);
}
#[test]
fn existing_format1_stage_remains_explicitly_readable_without_any_implicit_upgrade(){
    let f=Fixture::new("old-format");let staged=f.stage();let canonical=read_staged_metadata(&staged,RECORD).unwrap();let info=staged.manifest.records[0].clone();
    fs::remove_file(f.metadata.join("workspace.db")).unwrap();let conn=f.conn();conn.execute_batch("CREATE TABLE workspace (singleton INTEGER PRIMARY KEY CHECK(singleton=1), format INTEGER NOT NULL CHECK(format=1), workspace_id TEXT NOT NULL); CREATE TABLE records (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL CHECK(revision=1), body_hash TEXT NOT NULL, metadata TEXT NOT NULL);").unwrap();conn.execute("INSERT INTO workspace VALUES (1,1,?1)",[WORKSPACE]).unwrap();conn.execute("INSERT INTO records VALUES (?1,?2,1,?3,?4)",rusqlite::params![info.id,info.path,info.body_hash,canonical]).unwrap();drop(conn);republish_fixture_database(&staged);
    let before=fs::read(f.metadata.join("workspace.db")).unwrap();let old=open_staged(&f.source,&f.bodies,&f.metadata,WORKSPACE).unwrap();assert_eq!(read_staged_metadata(&old,RECORD).unwrap(),canonical);assert_eq!(fs::read(f.metadata.join("workspace.db")).unwrap(),before);assert_eq!(f.conn().query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),0);assert!(!validate_cutover(&old).unwrap().activation_blockers.is_empty());
}
#[test]
fn changed_source_before_schema4_stage_keeps_current_bytes_and_creates_no_outputs(){
    let f=Fixture::new("stale");let plan=f.plan();fs::write(f.source.join("page.md"),b"# New human source\n").unwrap();assert_eq!(stage_conversion(plan,&f.bodies,&f.metadata).unwrap_err().kind,"stale_inventory");assert_eq!(fs::read(f.source.join("page.md")).unwrap(),b"# New human source\n");assert!(!f.bodies.exists());assert!(!f.metadata.exists());
}
fn failed_publication(point:&str){
    let f=Fixture::new(point);let before=fs::read(f.source.join("page.md")).unwrap();let error=stage_with_failure(f.plan(),&f.bodies,&f.metadata,point).unwrap_err();assert_eq!(error.kind,"injected_failure");assert_eq!(fs::read(f.source.join("page.md")).unwrap(),before);
    assert_eq!(f.conn().query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),4);assert_eq!(format_gate::guard_legacy_access(&f.bodies).unwrap_err().kind,"inactive_workspace");assert!(open_staged(&f.source,&f.bodies,&f.metadata,WORKSPACE).is_err());
}
#[test]
fn schema4_database_before_manifest_failure_stays_explicitly_inactive(){failed_publication("after_database");}
#[test]
fn schema4_manifest_before_marker_failure_stays_explicitly_inactive(){failed_publication("after_manifest");}
#[test]
fn staged_schema4_reopen_refuses_unrecognized_schema_objects_even_with_resealed_manifest(){
    let f=Fixture::new("unknown-schema");let staged=f.stage();let canonical=read_staged_metadata(&staged,RECORD).unwrap();let info=staged.manifest.records[0].clone();
    fs::remove_file(f.metadata.join("workspace.db")).unwrap();let conn=f.conn();conn.execute_batch(include_str!("../workspace_service/selected_schema_v4.sql")).unwrap();conn.execute("INSERT INTO workspace VALUES (1,2,?1,1,1)",[WORKSPACE]).unwrap();conn.execute("INSERT INTO records VALUES (?1,?2,1,?3,?4)",rusqlite::params![info.id,info.path,info.body_hash,canonical]).unwrap();conn.execute_batch("CREATE TABLE unexpected_authority (grant_text TEXT);").unwrap();drop(conn);republish_fixture_database(&staged);
    assert_eq!(open_staged(&f.source,&f.bodies,&f.metadata,WORKSPACE).unwrap_err().kind,"invalid_metadata");
}

#[test]
fn initial_stage_refuses_valid_unchanged_request_history_that_keeps_all_counters_one(){
    let f=Fixture::new("unexpected-history");let staged=f.stage();let canonical=read_staged_metadata(&staged,RECORD).unwrap();let info=staged.manifest.records[0].clone();
    let hash=crate::ledger::sha256_hex(canonical.as_bytes());
    f.conn().execute("INSERT INTO metadata_requests(request_key,operation_id,workspace_id,record_id,path,payload_hash,expected_revision,expected_metadata_hash,expected_body_hash,result_kind,receipt_epoch,result_revision,result_metadata_hash,result_body_hash,actor,at) VALUES (?1,?2,?3,?4,'page.md',?5,1,?6,?7,'unchanged',NULL,1,?6,?7,'human:me','2026-10-26T00:00:00Z')",rusqlite::params!["25dabd53-065e-414e-b72b-a0a9a90bb54f","09602870-91ad-4b38-8b0f-5dd3ee756d06",WORKSPACE,RECORD,"a".repeat(64),hash,info.body_hash]).unwrap();
    republish_fixture_database(&staged);let bytes=fs::read(f.metadata.join("workspace.db")).unwrap();
    let facts=crate::workspace_service::selected::backup::read_offline(&bytes,WORKSPACE,rules().limits.database_bytes).unwrap();assert_eq!((facts.schema_revision,facts.epoch),(1,1));assert_eq!(facts.records[0].revision,1);
    assert_eq!(open_staged(&f.source,&f.bodies,&f.metadata,WORKSPACE).unwrap_err().kind,"invalid_metadata");
}
