//! Actual durable origins/pinned definitions; these rows mint no native authority.
use super::*;
use crate::actions::native_owner::native_workflows::views;
use crate::workflows::transport::*;
fn view_context()->WorkflowContext{WorkflowContext{vault_id:VAULT.into(),store_uuid:"store".into()}}
#[test]fn workflow_views_require_existing_transaction(){let conn=db();let(_,origin)=driver_fixture(&conn,vec![driver_result()],&permissions(),"{}");assert_eq!(views::run_rows(&conn,facts(),&origin.flow_run,&conn.dir),Err(flow::Error::Unavailable));}
#[test]fn workflow_views_pending_run_uses_pinned_labels_and_absence_states(){
 let conn=db();let(_,origin)=driver_fixture(&conn,vec![driver_result()],&permissions(),"{}");let view=tx(&conn,|c|views::run_rows(c,facts(),&origin.flow_run,&conn.dir)).unwrap();assert_eq!(view.context,view_context());assert_eq!(view.run_id,origin.flow_run);assert_eq!(view.native_run_id,origin.native_run);assert_eq!(view.state,WorkflowRunState::Queued);assert_eq!(view.steps.len(),1);assert_eq!(view.steps[0].step_id,"done");assert_eq!(view.steps[0].label,"done");assert_eq!(view.steps[0].ordinal.get(),0);assert!(matches!(view.steps[0].input,WorkflowValueView::NotRecorded{}));assert!(matches!(view.steps[0].output,WorkflowValueView::NotRecorded{}));assert!(view.steps[0].wait.is_none());assert_eq!(count(&conn,"runs"),1);
}
#[test]fn workflow_views_terminal_off_reads_finite_history_without_operational_input(){
 let conn=db();let(pinned,origin)=driver_fixture(&conn,vec![driver_result()],&permissions(),"{}");driver_apply(&conn,&pinned,&origin).unwrap();assert_eq!(conn.query_row("SELECT count(*) FROM workflow_values WHERE run_id=?1",[&origin.flow_run],|r|r.get::<_,i64>(0)).unwrap(),0);let view=tx(&conn,|c|views::run_rows(c,facts(),&origin.flow_run,&conn.dir)).unwrap();assert_eq!(view.state,WorkflowRunState::Succeeded);assert!(matches!(view.steps[0].input,WorkflowValueView::NotRetained{..}));assert!(matches!(view.steps[0].output,WorkflowValueView::NotRetained{..}));assert_eq!(view.steps[0].state,WorkflowStepState::Succeeded);
}
#[test]fn workflow_views_value_requires_exact_original_role_step_and_digest(){
 let conn=db();let(_,origin)=driver_fixture(&conn,vec![driver_result()],&permissions(),r#"{"value":9007199254740993.0000000000000001}"#);let input:String=conn.query_row("SELECT input_digest FROM workflow_runs WHERE run_id=?1",[&origin.flow_run],|r|r.get(0)).unwrap();let request=WorkflowValueRequest{context:view_context(),run_id:origin.flow_run.clone(),step_id:String::new(),role:WorkflowValueRole::RunInput,digest:input.clone()};let value=tx(&conn,|c|views::value_rows(c,facts(),&request)).unwrap();assert_eq!(value.digest,input);assert_eq!(value.json,r#"{"value":90071992547409930000000000000001e-16}"#);
 for wrong in [WorkflowValueRequest{step_id:"done".into(),..request.clone()},WorkflowValueRequest{digest:"b".repeat(64),..request.clone()},WorkflowValueRequest{role:WorkflowValueRole::StepOutput,step_id:"done".into(),..request.clone()}]{assert_eq!(tx(&conn,|c|views::value_rows(c,facts(),&wrong)),Err(flow::Error::Denied));}
}
#[test]fn workflow_views_missing_active_value_is_unavailable_not_not_retained(){
 let conn=db();let(pinned,origin)=driver_fixture(&conn,vec![driver_read(),driver_result()],&permissions(),"{}");assert!(matches!(driver_apply(&conn,&pinned,&origin).unwrap(),driver::Step::Read(_)));conn.execute("DELETE FROM workflow_values WHERE run_id=?1 AND role='step_input'",[&origin.flow_run]).unwrap();let view=tx(&conn,|c|views::run_rows(c,facts(),&origin.flow_run,&conn.dir)).unwrap();assert!(matches!(view.steps[0].input,WorkflowValueView::Unavailable{}));assert!(matches!(view.steps[0].output,WorkflowValueView::NotRecorded{}));
}
#[test]fn workflow_views_wrong_original_scope_denied_without_adopting_rows(){
 let conn=db();let(_,origin)=driver_fixture(&conn,vec![driver_result()],&permissions(),"{}");for wrong in [OpeningFacts{store:"other",..facts()},OpeningFacts{vault:"dddddddddddddddddddddddddddddddd",..facts()},OpeningFacts{owner:"human:other",..facts()}]{assert_eq!(tx(&conn,|c|views::run_rows(c,wrong,&origin.flow_run,&conn.dir)),Err(flow::Error::Denied));}assert_eq!(count(&conn,"runs"),1);
}
#[test]fn workflow_views_run_catalog_has_visible_bounded_continuation(){
 let conn=db();let(pinned,_)=driver_fixture(&conn,vec![driver_result()],&permissions(),"{}");let graph=pinned.steps();let p=permissions();for n in 2..=34{let key=format!("{n:032x}");tx(&conn,|c|start_rows(c,facts(),Start{key:&key,workflow:pinned.workflow(),version:pinned.version(),schema:pinned.schema(),input:pinned.input(),configuration:HASH,permissions:&p,selectors:&[],entry:pinned.entry(),steps:&graph,now:time()+chrono::Duration::milliseconds(n)})).unwrap();}
 let first=tx(&conn,|c|views::catalog_rows(c,facts(),None)).unwrap();assert_eq!(first.items.len(),flow::catalog_policy().page_size);assert!(first.truncated);let cursor=first.next_cursor.as_deref().expect("visible continuation");let rest=tx(&conn,|c|views::catalog_rows(c,facts(),Some(cursor))).unwrap();assert_eq!(rest.items.len(),2);assert!(!rest.truncated);assert!(rest.next_cursor.is_none());let ids=first.items.iter().chain(&rest.items).map(|item|&item.run_id).collect::<std::collections::BTreeSet<_>>();assert_eq!(ids.len(),34);assert_eq!(first.context,view_context());assert_eq!(tx(&conn,|c|views::catalog_rows(c,facts(),Some("f".repeat(32).as_str()))),Err(flow::Error::Denied));
}

#[test]
fn workflow_access_requires_existing_transaction(){let conn=db();let origin=original(&conn);assert_eq!(views::access_rows(&conn,facts(),&origin.flow_run),Err(flow::Error::Unavailable));}
#[test]
fn workflow_access_preserves_actual_original_ceiling_and_exact_input_current_selection(){
 let conn=db();let(mut original_permissions,selector)=selected_account(&conn);original_permissions.read_prefixes=vec![String::new(),"visible".into()];original_permissions.accounts[0].input_scope="exact_canonical_input".into();original_permissions.accounts[0].input_digest=Some("b".repeat(64));let origin=selected_start(&conn,&original_permissions,&selector);
 let mut narrowed=original_permissions.clone();narrowed.read_prefixes=vec!["visible/review".into()];narrowed.query_records=false;let admitted=tx(&conn,|c|reauthorize_rows(c,facts(),&origin.flow_run,origin.epoch,&narrowed,time())).unwrap();
 let view=tx(&conn,|c|views::access_rows(c,facts(),&origin.flow_run)).unwrap();assert_eq!(view.context,view_context());assert_eq!(view.run_id,origin.flow_run);assert_eq!(view.admission_epoch.get(),admitted.epoch);assert_eq!(serde_json::to_value(&view.original).unwrap(),serde_json::to_value(&original_permissions).unwrap());assert_eq!(serde_json::to_value(&view.current).unwrap(),serde_json::to_value(&narrowed).unwrap());assert_eq!(view.current.accounts[0].input_scope,WorkflowInputScope::ExactCanonicalInput);assert_eq!(view.current.accounts[0].input_digest.as_deref(),Some("b".repeat(64).as_str()));assert_eq!(view.current.accounts[0].capabilities,original_permissions.accounts[0].capabilities);assert_eq!(count(&conn,"grants"),1,"read never duplicates real ACT grant");
}
#[test]
fn workflow_access_query_only_read_never_promotes_definition_selector_to_permission(){
 let conn=db();let(_,selector)=selected_account(&conn);let origin=selected_start(&conn,&permissions(),&selector);let before=conn.total_changes();conn.pragma_update(None,"query_only",true).unwrap();let transaction=Transaction::new_unchecked(&conn,TransactionBehavior::Deferred).unwrap();let view=views::access_rows(&transaction,facts(),&origin.flow_run).unwrap();transaction.commit().unwrap();assert!(view.original.accounts.is_empty());assert!(view.current.accounts.is_empty());assert_eq!(conn.total_changes(),before);assert_eq!(count(&conn,"grants"),0);
}
#[test]
fn workflow_access_refuses_other_original_owner_vault_or_store(){let conn=db();let origin=original(&conn);for wrong in [OpeningFacts{owner:"human:other",..facts()},OpeningFacts{vault:"dddddddddddddddddddddddddddddddd",..facts()},OpeningFacts{store:"replacement",..facts()}]{assert_eq!(tx(&conn,|c|views::access_rows(c,wrong,&origin.flow_run)),Err(flow::Error::Denied));}}
