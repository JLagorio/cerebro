use super::*;
fn bundle()->serde_json::Value{serde_json::json!({"version":1,"types":{
"WorkflowScheduleView":schemars::schema_for!(WorkflowScheduleView),
"WorkflowScheduleEnableRequest":schemars::schema_for!(WorkflowScheduleEnableRequest),
"WorkflowScheduleChangeRequest":schemars::schema_for!(WorkflowScheduleChangeRequest),
"WorkflowScheduleAck":schemars::schema_for!(WorkflowScheduleAck),
"WorkflowScheduleMonitorAck":schemars::schema_for!(WorkflowScheduleMonitorAck),
"WorkflowSchedulePreview":schemars::schema_for!(WorkflowSchedulePreview),
"WorkflowContext":schemars::schema_for!(WorkflowContext),
"WorkflowDraft":schemars::schema_for!(WorkflowDraft),
"WorkflowDocument":schemars::schema_for!(WorkflowDocument),
"WorkflowCatalog":schemars::schema_for!(WorkflowCatalog),
"WorkflowValidation":schemars::schema_for!(WorkflowValidation),
"WorkflowStartRequest":schemars::schema_for!(WorkflowStartRequest),
"WorkflowStartAck":schemars::schema_for!(WorkflowStartAck),
"WorkflowSaveRequest":schemars::schema_for!(WorkflowSaveRequest),
"WorkflowPublishRequest":schemars::schema_for!(WorkflowPublishRequest),
"WorkflowUnpublishRequest":schemars::schema_for!(WorkflowUnpublishRequest),
"WorkflowUnpublishAck":schemars::schema_for!(WorkflowUnpublishAck),
"WorkflowRunRequest":schemars::schema_for!(WorkflowRunRequest),
"WorkflowReauthorizeRequest":schemars::schema_for!(WorkflowReauthorizeRequest),
"WorkflowWaitAnswer":schemars::schema_for!(WorkflowWaitAnswer),
"WorkflowActionAnswer":schemars::schema_for!(WorkflowActionAnswer),
"WorkflowRunView":schemars::schema_for!(WorkflowRunView),
"WorkflowAccessView":schemars::schema_for!(WorkflowAccessView),
"WorkflowRunCatalog":schemars::schema_for!(WorkflowRunCatalog),
"WorkflowValueRequest":schemars::schema_for!(WorkflowValueRequest),
"WorkflowValueDetail":schemars::schema_for!(WorkflowValueDetail),
"WorkflowError":schemars::schema_for!(WorkflowError)
}})}
#[test]
#[ignore="explicit workflow contract regeneration"]
fn export_workflow_contract_schema(){let path=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/workflows/contracts.v1.json");std::fs::write(path,format!("{}\n",serde_json::to_string_pretty(&bundle()).unwrap())).unwrap();}
#[test]
fn rust_workflow_declarations_match_committed_schema(){let path=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/workflows/contracts.v1.json");assert_eq!(std::fs::read_to_string(path).unwrap(),format!("{}\n",serde_json::to_string_pretty(&bundle()).unwrap()));}
#[test]
fn workflow_dto_json_leaves_never_round_exact_decimal_values(){let expression=r#"{"kind":"literal","value":9007199254740993.00000000000000001}"#;let operation=WorkflowOperationDraft::Result{output_json:expression.into()};let encoded=serde_json::to_string(&operation).unwrap();let decoded:WorkflowOperationDraft=serde_json::from_str(&encoded).unwrap();assert_eq!(decoded,operation);let WorkflowOperationDraft::Result{output_json}=decoded else{panic!("result")};assert_eq!(output_json,expression);}
#[test]
fn workflow_dtos_refuse_wire_authority_and_optional_agent_operation(){assert!(serde_json::from_str::<WorkflowContext>(r#"{"vaultId":"v","storeUuid":"s","owner":"human:other"}"#).is_err());assert!(serde_json::from_str::<WorkflowOperationDraft>(r#"{"kind":"agent","objective":"execute"}"#).is_err());}
#[test]
fn workflow_dto_null_is_explicit_and_counters_remain_exact(){assert!(serde_json::from_str::<WorkflowDiagnostic>(r#"{"code":"invalid_input","field":null}"#).is_err());assert!(serde_json::from_str::<WorkflowRunRequest>(r#"{"context":{"vaultId":"v","storeUuid":"s"},"runId":"r","expectedRevision":9007199254740992,"expectedEpoch":1}"#).is_err());assert_eq!(serde_json::to_string(&WorkflowValueView::NotRecorded{}).unwrap(),r#"{"state":"not_recorded"}"#);assert_ne!(WorkflowValueView::NotRecorded{},WorkflowValueView::Unavailable{});}

#[test]
fn every_workflow_operation_schema_accepts_actual_rust_serialized_field_names(){
 let variants=vec![
  WorkflowOperationDraft::Read{query_json:"{}".into(),output_schema_json:"{}".into(),next_step_id:"next".into()},
  WorkflowOperationDraft::Transform{mapping_json:"{}".into(),output_schema_json:"{}".into(),next_step_id:"next".into()},
  WorkflowOperationDraft::Condition{predicate_json:"{}".into(),if_true:"yes".into(),if_false:"no".into()},
  WorkflowOperationDraft::Action{action_id:"action".into(),definition_digest:"d".into(),connection_id:"connection".into(),account_id:"account".into(),input_json:"{}".into(),next_step_id:"next".into()},
  WorkflowOperationDraft::Timer{at:"2026-01-01T00:00:00Z".into(),next_step_id:"next".into()},
  WorkflowOperationDraft::ExternalInput{schema_json:"{}".into(),expires_at:"2026-01-01T00:00:00Z".into(),next_step_id:"next".into()},
  WorkflowOperationDraft::Result{output_json:"{}".into()},
 ];
 let schema=serde_json::to_value(schemars::schema_for!(WorkflowOperationDraft)).unwrap();
 for operation in variants{
  let value=serde_json::to_value(&operation).unwrap();let kind=value["kind"].as_str().unwrap();
  let variant=schema["oneOf"].as_array().unwrap().iter().find(|variant|variant["properties"]["kind"]["enum"][0].as_str()==Some(kind)).unwrap();
  let actual=value.as_object().unwrap().keys().cloned().collect::<std::collections::BTreeSet<_>>();
  let declared=variant["properties"].as_object().unwrap().keys().cloned().collect::<std::collections::BTreeSet<_>>();
  let required=variant["required"].as_array().unwrap().iter().map(|field|field.as_str().unwrap().to_owned()).collect::<std::collections::BTreeSet<_>>();
  assert_eq!(actual,declared,"actual Rust wire keys must match generated schema for {kind}");assert_eq!(actual,required,"every operation field is required for {kind}");
  assert_eq!(serde_json::from_value::<WorkflowOperationDraft>(value).unwrap(),operation);
 }
}

#[test]
fn schedule_transport_keeps_selected_decimal_text_and_refuses_wire_monitor_authority(){
 let value=serde_json::json!({"context":{"vaultId":"vault","storeUuid":"store"},"version":{"workflowId":"flow","definitionHash":"d".repeat(64)},"requestKey":"a".repeat(32),"expectedRevision":0,"inputJson":"{\"number\":9007199254740993.0000000000000001}","permissions":{"readPrefixes":[],"queryRecords":false,"accounts":[]}});
 let request:WorkflowScheduleEnableRequest=serde_json::from_value(value.clone()).unwrap();assert_eq!(request.input_json,r#"{"number":9007199254740993.0000000000000001}"#);
 let mut extra=value;extra["sameOpening"]=serde_json::json!(true);assert!(serde_json::from_value::<WorkflowScheduleEnableRequest>(extra).is_err());
 assert!(serde_json::from_str::<WorkflowScheduleMonitorAck>(r#"{"context":{"vaultId":"v","storeUuid":"s"},"monitoring":"enabled"}"#).is_err(),"configuration enabled is not evidence of a monitoring worker");
}
#[test]
fn schedule_transport_requires_explicit_absence_and_exact_revision(){
 assert!(serde_json::from_str::<WorkflowScheduleView>(r#"{"context":{"vaultId":"v","storeUuid":"s"},"workflowId":"flow","readiness":"unavailable"}"#).is_err());
 assert!(serde_json::from_str::<WorkflowScheduleChangeRequest>(r#"{"context":{"vaultId":"v","storeUuid":"s"},"workflowId":"flow","requestKey":"key","expectedRevision":9007199254740992}"#).is_err());
 let absent:WorkflowScheduleView=serde_json::from_str(r#"{"context":{"vaultId":"v","storeUuid":"s"},"workflowId":"flow","configuration":null,"readiness":"unconfigured","monitoring":"stopped"}"#).unwrap();assert!(absent.configuration.is_none());
}

#[test]
fn unpublish_transport_carries_exact_original_and_no_execution_authority() {
    let value = serde_json::json!({
        "context":{"vaultId":"vault","storeUuid":"store"},"requestKey":"a".repeat(32),
        "publication":{"version":{"workflowId":"flow","definitionHash":"b".repeat(64)},"revision":9}
    });
    let request: WorkflowUnpublishRequest = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(request.publication.revision.get(), 9);
    assert_eq!(serde_json::to_value(&request).unwrap(), value);
    let mut unexpected = value;
    unexpected["cancelRunning"] = serde_json::json!(true);
    assert!(serde_json::from_value::<WorkflowUnpublishRequest>(unexpected).is_err());
    let ack = WorkflowUnpublishAck {
        context: request.context, request_key: request.request_key, original: request.publication,
        publication_revision: SafeCounter::new(10).unwrap(), replayed: true,
    };
    assert_eq!(serde_json::from_str::<WorkflowUnpublishAck>(&serde_json::to_string(&ack).unwrap()).unwrap(), ack);
    let mut document = serde_json::json!({
        "context":{"vaultId":"vault","storeUuid":"store"},"workflowId":"flow",
        "draft":null,"publication":null,"versions":[],"versionsTruncated":false,"activation":{"state":"unavailable"}
    });
    assert!(serde_json::from_value::<WorkflowDocument>(document.clone()).is_err(), "absence of a target cannot erase its revision");
    document["publicationRevision"] = serde_json::json!(2);
    assert_eq!(serde_json::from_value::<WorkflowDocument>(document.clone()).unwrap().publication_revision.get(), 2);
    document["publicationRevision"] = serde_json::json!(9007199254740992u64);
    assert!(serde_json::from_value::<WorkflowDocument>(document).is_err());
}
