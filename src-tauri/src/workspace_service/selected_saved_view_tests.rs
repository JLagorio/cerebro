//! Actual production saved-view service over the existing disposable schema4 store.
use super::*;
use selected::{SelectedSavedViewRequest,SelectedSavedViewLayout};
fn st(value:&str)->Value { json!({"kind":"string","value":value}) }
fn dec(value:&str)->Value { json!({"kind":"decimal","value":value}) }
fn obj(value:Value)->Value { json!({"kind":"object","value":value}) }
fn arr(value:Vec<Value>)->Value { json!({"kind":"array","value":value}) }
fn view()->Value {
 obj(json!({"id":st("exact"),"name":st("Exact amounts"),"filters":obj(json!({"all":arr(vec![obj(json!({"field":st("amount"),"op":st("gt"),"value":dec("9007199254740993.124")}))])})),"presentation":obj(json!({"type":st("table"),"group":arr(vec![]),"sort":arr(vec![obj(json!({"field":st("amount"),"dir":st("asc")}))]),"columns":arr(vec![obj(json!({"field":st("amount")})),obj(json!({"field":st("code")}))])}))}))
}
fn install(f:&Fixture, saved:Value) {
 let conn=f.conn();let text:String=conn.query_row("SELECT metadata FROM records WHERE id=?1",[TYPE_ID],|row|row.get(0)).unwrap();let mut metadata:Value=serde_json::from_str(&text).unwrap();
 metadata["value"]["fields"]["value"]["amount"]=st("number");metadata["value"]["fields"]["value"]["due"]=st("date");metadata["value"]["views"]=arr(vec![saved]);
 conn.execute("UPDATE records SET metadata=?1 WHERE id=?2",rusqlite::params![metadata.to_string(),TYPE_ID]).unwrap();
 let mut metadata=f.stored();metadata["value"]["amount"]=dec("9007199254740993.126");conn.execute("UPDATE records SET metadata=?1 WHERE id=?2",rusqlite::params![metadata.to_string(),RECORD]).unwrap();
 add(f,"c9fa3b3a-cc09-49fb-9e50-2d85ddc30b01","first.md","9007199254740993.125");
}
fn add(f:&Fixture,id:&str,path:&str,amount:&str){
 let body=format!("# {path}\n");testutil::write(&f.root,path,&body);let metadata=obj(json!({"type":st("Task"),"amount":dec(amount),"code":st("007"),"present":json!({"kind":"null"})}));
 f.conn().execute("INSERT INTO records VALUES (?1,?2,1,?3,?4)",rusqlite::params![id,path,crate::ledger::sha256_hex(body.as_bytes()),metadata.to_string()]).unwrap();
}
fn q(f:&Fixture)->SelectedSavedViewRequest {
 let (revision,body_hash,metadata):(i64,String,String)=f.conn().query_row("SELECT revision,body_hash,metadata FROM records WHERE id=?1",[TYPE_ID],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
 SelectedSavedViewRequest{target:selected::SelectedEditorTarget{workspace_id:WORKSPACE.into(),record_id:TYPE_ID.into()},expected_version:SelectedRecordVersion{kind:SelectedAuthorityKind::SqliteMetadata,workspace_id:WORKSPACE.into(),record_id:TYPE_ID.into(),metadata_revision:revision.to_string(),metadata_hash:crate::ledger::sha256_hex(metadata.as_bytes()),body_hash},view_id:"exact".into()}
}
fn publish(f:&Fixture){let context=authority::context().unwrap();let attempt=context.request_open(&f.root).unwrap();context.enter_open(&attempt).unwrap();context.publish_attempt_with(&attempt,||Ok(())).unwrap();}
fn read(f:&Fixture,request:&SelectedSavedViewRequest)->Result<selected::SelectedSavedViewFrame,AuthorityError>{selected::read_saved_view(&f.root,"task-type.md",request,chrono_tz::UTC,chrono::NaiveDate::from_ymd_opt(2026,10,27).unwrap())}
#[test]
fn actual_saved_view_uses_exact_decimal_predicate_order_and_one_snapshot_evidence(){
 let f=fixture("view-decimal",true);let saved=view();install(&f,saved.clone());f.run(||{publish(&f);let request=q(&f);let before=counts(&f);let result=read(&f,&request).unwrap();
 assert_eq!(result.view_id,"exact");assert_eq!(result.view_name,"Exact amounts");assert_eq!(result.layout,SelectedSavedViewLayout::Table);assert_eq!(result.entries.iter().map(|row|row.path.as_str()).collect::<Vec<_>>(),["first.md","page.md"]);assert_eq!((result.shown,result.total,result.capped),(2,2,false));
 assert_eq!(result.type_record.authority,request.expected_version);assert_eq!(serde_json::to_value(&result.configuration).unwrap(),saved);assert!(result.schema_evidence.iter().any(|row|row.authority.record_id==TYPE_ID));assert_eq!(result.snapshot_epoch,"11");assert_eq!(result.today,"2026-10-27");assert_eq!(result.timezone,"UTC");
 assert_eq!(serde_json::to_value(&result.entries[1].canonical_properties.value).unwrap()["value"]["amount"],dec("9007199254740993.126"));assert_eq!(serde_json::to_value(&result.entries[1].canonical_properties.value).unwrap()["value"]["huge"],f.stored()["value"]["huge"]);assert_eq!(result.entries[1].hash,result.entries[1].authority.body_hash);assert_eq!(counts(&f),before);assert_eq!(fs::read(f.root.join("page.md")).unwrap(),BODY.as_bytes());
 });
}
#[test]
fn actual_saved_view_never_rounds_a_huge_exponent_operand_or_discards_unrelated_values(){
 let f=fixture("view-exponent",true);let mut saved=view();saved["value"]["filters"]["value"]["all"]["value"][0]["value"]["value"]=dec("1e400");saved["value"]["filters"]["value"]["all"]["value"][0]["value"]["op"]=st("equals");install(&f,saved);let mut metadata=f.stored();metadata["value"]["amount"]=dec("1e400");f.conn().execute("UPDATE records SET metadata=?1 WHERE id=?2",rusqlite::params![metadata.to_string(),RECORD]).unwrap();f.run(||{publish(&f);let result=read(&f,&q(&f)).unwrap();assert_eq!(result.entries.len(),1);assert_eq!(result.entries[0].path,"page.md");assert_eq!(serde_json::to_value(&result.entries[0].canonical_properties.value).unwrap()["value"]["amount"],dec("1e400"));assert_eq!(counts(&f),(11,7,0,0));});
}
#[test]
fn actual_saved_view_rejects_wrong_original_type_identity(){let f=fixture("view-wrong-id",true);install(&f,view());f.run(||{publish(&f);let mut request=q(&f);request.target.record_id=RECORD.into();assert_eq!(read(&f,&request).unwrap_err().kind,AuthorityErrorKind::WrongIdentity);assert_eq!(counts(&f),(11,7,0,0));});}
#[test]
fn actual_saved_view_rejects_original_type_metadata_change_without_selecting_new_settings(){let f=fixture("view-stale-config",true);install(&f,view());f.run(||{publish(&f);let request=q(&f);let mut saved=view();saved["value"]["name"]=st("Changed later");let text:String=f.conn().query_row("SELECT metadata FROM records WHERE id=?1",[TYPE_ID],|row|row.get(0)).unwrap();let mut metadata:Value=serde_json::from_str(&text).unwrap();metadata["value"]["views"]=arr(vec![saved]);f.conn().execute("UPDATE records SET metadata=?1,revision=2 WHERE id=?2",rusqlite::params![metadata.to_string(),TYPE_ID]).unwrap();assert_eq!(read(&f,&request).unwrap_err().kind,AuthorityErrorKind::StaleMetadata);assert_eq!(counts(&f),(11,7,0,0));});}
#[test]
fn actual_saved_view_refuses_external_type_body_instead_of_recomputing_its_h1_identity(){let f=fixture("view-type-body",true);install(&f,view());f.run(||{publish(&f);let request=q(&f);fs::write(f.root.join("task-type.md"),b"# Renamed outside\n").unwrap();assert_eq!(read(&f,&request).unwrap_err().kind,AuthorityErrorKind::SourceChanged);});}
#[test]
fn actual_saved_view_missing_exact_id_never_falls_back_to_first_view(){let f=fixture("view-missing-id",true);install(&f,view());f.run(||{publish(&f);let mut request=q(&f);request.view_id="missing".into();assert_eq!(read(&f,&request).unwrap_err().kind,AuthorityErrorKind::UnsupportedProjection);});}
#[test]
fn actual_saved_view_requires_an_actual_published_selected_opening(){let f=fixture("view-not-published",true);install(&f,view());f.run(||{assert_eq!(read(&f,&q(&f)).unwrap_err().kind,AuthorityErrorKind::SourceChanged);assert_eq!(counts(&f),(11,7,0,0));});}
#[test]
fn actual_saved_view_rejects_unsupported_group_before_returning_partial_rows(){let f=fixture("view-group",true);let mut saved=view();saved["value"]["presentation"]["value"]["group"]=arr(vec![obj(json!({"field":st("amount")}))]);install(&f,saved);f.run(||{publish(&f);assert_eq!(read(&f,&q(&f)).unwrap_err().kind,AuthorityErrorKind::UnsupportedProjection);});}
#[test]
fn actual_saved_view_rejects_hidden_footer_before_returning_partial_rows(){let f=fixture("view-footer",true);let mut saved=view();saved["value"]["presentation"]["value"]["columns"]["value"][0]["value"]["calc"]=st("sum");saved["value"]["presentation"]["value"]["columns"]["value"][0]["value"]["hidden"]=json!({"kind":"boolean","value":true});install(&f,saved);f.run(||{publish(&f);assert_eq!(read(&f,&q(&f)).unwrap_err().kind,AuthorityErrorKind::UnsupportedProjection);});}
#[test]
fn actual_saved_view_rejects_layout_without_canonical_frame_support(){let f=fixture("view-chart",true);let mut saved=view();saved["value"]["presentation"]["value"]["type"]=st("chart");install(&f,saved);f.run(||{publish(&f);assert_eq!(read(&f,&q(&f)).unwrap_err().kind,AuthorityErrorKind::UnsupportedProjection);});}
#[test]
fn saved_view_request_rejects_renderer_predicate_or_clock_overrides(){let f=fixture("view-wire",true);install(&f,view());let request=q(&f);let mut wire=serde_json::to_value(&request).unwrap();wire["filters"]=json!({"all":[]});assert!(serde_json::from_value::<SelectedSavedViewRequest>(wire).is_err());let wire=serde_json::to_value(&request).unwrap();assert!(wire.get("expectedVersion").is_some());assert!(wire.get("viewId").is_some());assert!(wire.get("expected_version").is_none());}

#[test]
fn actual_saved_view_keeps_shared_date_before_instant_midnight_sort_without_predicate_redefinition(){
 let f=fixture("view-date-sort",true);let mut saved=view();saved["value"]["filters"]=json!({"kind":"null"});saved["value"]["presentation"]["value"]["sort"]=arr(vec![obj(json!({"field":st("due"),"dir":st("asc")}))]);saved["value"]["presentation"]["value"]["columns"]=arr(vec![obj(json!({"field":st("due")}))]);install(&f,saved);
 for (id,value) in [(RECORD,json!({"kind":"date","value":"2026-10-27"})),("c9fa3b3a-cc09-49fb-9e50-2d85ddc30b01",json!({"kind":"instant","value":"2026-10-27T00:00:00Z"}))] {let text:String=f.conn().query_row("SELECT metadata FROM records WHERE id=?1",[id],|row|row.get(0)).unwrap();let mut metadata:Value=serde_json::from_str(&text).unwrap();metadata["value"]["due"]=value;f.conn().execute("UPDATE records SET metadata=?1 WHERE id=?2",rusqlite::params![metadata.to_string(),id]).unwrap();}
 f.run(||{publish(&f);let result=read(&f,&q(&f)).unwrap();assert_eq!(result.entries.iter().map(|row|row.path.as_str()).collect::<Vec<_>>(),["page.md","first.md"]);assert_eq!(result.columns[0].kind,"date");});
}
#[test]
fn actual_saved_view_preserves_present_null_and_does_not_equal_absent(){
 let f=fixture("view-null-absence",true);let mut saved=view();saved["value"]["filters"]["value"]["all"]["value"][0]=obj(json!({"field":st("present"),"op":st("equals"),"value":json!({"kind":"null"})}));install(&f,saved);let id="c9fa3b3a-cc09-49fb-9e50-2d85ddc30b01";let text:String=f.conn().query_row("SELECT metadata FROM records WHERE id=?1",[id],|row|row.get(0)).unwrap();let mut metadata:Value=serde_json::from_str(&text).unwrap();metadata["value"].as_object_mut().unwrap().remove("present");f.conn().execute("UPDATE records SET metadata=?1 WHERE id=?2",rusqlite::params![metadata.to_string(),id]).unwrap();f.run(||{publish(&f);let result=read(&f,&q(&f)).unwrap();assert_eq!(result.entries.len(),1);assert_eq!(result.entries[0].path,"page.md");assert_eq!(serde_json::to_value(&result.entries[0].canonical_properties.value).unwrap()["value"]["present"],json!({"kind":"null"}));});
}
#[test]
fn actual_saved_view_refuses_relation_predicates_before_partial_output(){let f=fixture("view-relation",true);let mut saved=view();saved["value"]["filters"]["value"]["all"]["value"][0]=obj(json!({"field":st("related"),"op":st("equals"),"value":json!({"kind":"relation","spelling":"[[Self]]","fragment":null,"resolution":{"status":"resolved","targetId":RECORD}})}));install(&f,saved);f.run(||{publish(&f);assert_eq!(read(&f,&q(&f)).unwrap_err().kind,AuthorityErrorKind::UnsupportedProjection);});}
#[test]
fn actual_saved_view_refuses_a_computed_column_even_if_no_visible_record_would_expose_it(){let f=fixture("view-computed",true);let mut saved=view();saved["value"]["presentation"]["value"]["columns"]=arr(vec![obj(json!({"field":st("doubled")}))]);install(&f,saved);let text:String=f.conn().query_row("SELECT metadata FROM records WHERE id=?1",[TYPE_ID],|row|row.get(0)).unwrap();let mut metadata:Value=serde_json::from_str(&text).unwrap();metadata["value"]["fields"]["value"]["doubled"]=obj(json!({"kind":st("formula"),"formula":st("amount * 2")}));f.conn().execute("UPDATE records SET metadata=?1 WHERE id=?2",rusqlite::params![metadata.to_string(),TYPE_ID]).unwrap();f.run(||{publish(&f);assert_eq!(read(&f,&q(&f)).unwrap_err().kind,AuthorityErrorKind::UnsupportedProjection);});}
#[test]
fn actual_saved_view_does_not_choose_between_duplicate_visible_type_declarations(){let f=fixture("view-duplicate-type",true);install(&f,view());let body="# Task\n";testutil::write(&f.root,"duplicate-type.md",body);let text:String=f.conn().query_row("SELECT metadata FROM records WHERE id=?1",[TYPE_ID],|row|row.get(0)).unwrap();f.conn().execute("INSERT INTO records VALUES ('fa80f181-4282-4f8b-a214-3cdb84eac064','duplicate-type.md',1,?1,?2)",rusqlite::params![crate::ledger::sha256_hex(body.as_bytes()),text]).unwrap();f.run(||{publish(&f);assert_eq!(read(&f,&q(&f)).unwrap_err().kind,AuthorityErrorKind::UnsupportedProjection);});}
#[test]
fn actual_saved_view_reports_capped_total_instead_of_silent_omission(){let f=fixture("view-row-cap",true);let mut saved=view();saved["value"]["filters"]=json!({"kind":"null"});saved["value"]["presentation"]["value"]["limit"]=dec("1000");install(&f,saved);for i in 1..=103{add(&f,&format!("c9fa3b3a-cc09-49fb-9e50-{i:012x}"),&format!("bulk-{i:03}.md"),&i.to_string());}f.run(||{publish(&f);let result=read(&f,&q(&f)).unwrap();assert_eq!((result.shown,result.total,result.capped),(100,105,true));assert_eq!(result.entries.len(),100);assert_eq!(counts(&f),(11,7,0,0));});}
#[test]
fn actual_saved_view_refuses_same_path_reopen_at_its_real_publication_gate(){let f=fixture("view-reopen",true);install(&f,view());f.run(||{publish(&f);let context=authority::context().unwrap();let root=f.root.clone();let called=std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));let mark=called.clone();let result=selected::with_saved_view_before_publish_for_test(move||{mark.store(true,std::sync::atomic::Ordering::SeqCst);let attempt=context.request_open(&root).unwrap();context.enter_open(&attempt).unwrap();context.publish_attempt_with(&attempt,||Ok(())).unwrap();},||read(&f,&q(&f)));assert!(called.load(std::sync::atomic::Ordering::SeqCst),"actual publication gate must be reached");assert_eq!(result.unwrap_err().kind,AuthorityErrorKind::SourceChanged);});}
#[test]
fn actual_saved_view_does_not_adopt_a_replacement_database_object_at_publication(){let f=fixture("view-db-replaced",true);install(&f,view());f.run(||{publish(&f);let path=f.db.clone();let called=std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));let mark=called.clone();let result=selected::with_saved_view_before_publish_for_test(move||{mark.store(true,std::sync::atomic::Ordering::SeqCst);let original=path.with_extension("original");fs::rename(&path,&original).unwrap();fs::copy(&original,&path).unwrap();private_file(&path);},||read(&f,&q(&f)));assert!(called.load(std::sync::atomic::Ordering::SeqCst),"actual publication gate must be reached");assert_eq!(result.unwrap_err().kind,AuthorityErrorKind::SourceChanged);});}
#[test]
fn actual_saved_view_response_bound_refuses_without_truncating_exact_values_or_evidence(){let f=fixture("view-byte-cap",true);install(&f,view());f.run(||{publish(&f);let before=counts(&f);let result=selected::with_saved_view_response_limit_for_test(64,||read(&f,&q(&f)));assert_eq!(result.unwrap_err().kind,AuthorityErrorKind::SourceLimit);assert_eq!(counts(&f),before);});}
