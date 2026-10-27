//! Real file service + command result classification, no native proof factory.
use super::*;
struct Vault(std::path::PathBuf);
impl Vault{fn new()->Self{Self(crate::vault::testutil::temp_vault("workflow-command"))}}
impl Drop for Vault{fn drop(&mut self){let _=std::fs::remove_dir_all(&self.0);}}
fn context()->WorkflowContext{WorkflowContext{vault_id:"a".repeat(32),store_uuid:"original-store".into()}}
fn draft()->WorkflowDraft{WorkflowDraft{workflow_id:"example".into(),entry_step_id:"done".into(),input_schema_json:r#"{"type":"object","properties":{},"additionalProperties":false}"#.into(),trigger_json:r#"{"kind":"manual"}"#.into(),steps:vec![WorkflowStepDraft{step_id:"done".into(),label:"Result".into(),operation:WorkflowOperationDraft::Result{output_json:r#"{"kind":"literal","value":1}"#.into()}}]}}
fn save(vault:&Vault)->WorkflowDraftSnapshot{document_service::save(&vault.0,&WorkflowSaveRequest{context:context(),draft:draft(),expected_etag:None},"human:me").unwrap()}
#[test]fn command_saved_draft_ack_survives_later_original_opening_loss(){
 let vault=Vault::new();let saved=save(&vault);let acknowledged=finish_file(Ok(saved.clone()),false,FileUse::Mutation).expect("known saved revision remains acknowledged");assert_eq!(acknowledged,saved);assert_eq!(document_service::document(&vault.0,context(),"example").unwrap().draft,Some(acknowledged));
}
#[test]fn command_published_version_ack_survives_later_original_opening_loss(){
 let vault=Vault::new();let saved=save(&vault);let publication=document_service::publish(&vault.0,&WorkflowPublishRequest{context:context(),workflow_id:"example".into(),expected_draft_etag:saved.etag,expected_publication_revision:None}).unwrap();let acknowledged=finish_file(Ok(publication.clone()),false,FileUse::Mutation).expect("known immutable publication remains acknowledged");assert_eq!(acknowledged,publication);let pinned=document_service::version(&vault.0,&acknowledged.version).unwrap();assert_eq!(pinned.workflow_id,"example");assert_eq!(pinned.steps,draft().steps);
}
#[test]fn command_read_loss_remains_unavailable_without_mutation(){
 let vault=Vault::new();let catalog=document_service::catalog(&vault.0,context(),None).unwrap();assert_eq!(finish_file(Ok(catalog),false,FileUse::Read).unwrap_err().code,WorkflowErrorCode::Unavailable);assert!(!vault.0.join(".cerebro").exists());
}
#[test]fn command_original_context_compares_both_vault_and_store(){
 let original=context();assert_eq!(check_context(&original,&context()),Ok(()));let mut changed=context();changed.vault_id="b".repeat(32);assert_eq!(check_context(&original,&changed).unwrap_err().code,WorkflowErrorCode::Denied);changed=context();changed.store_uuid="replacement-store".into();assert_eq!(check_context(&original,&changed).unwrap_err().code,WorkflowErrorCode::Denied);
}
#[test]fn command_current_file_result_preserves_real_cas_conflict(){
 let vault=Vault::new();let saved=save(&vault);let conflict=document_service::save(&vault.0,&WorkflowSaveRequest{context:context(),draft:draft(),expected_etag:None},"human:me");assert_eq!(finish_file(conflict,true,FileUse::Mutation).unwrap_err().code,WorkflowErrorCode::Conflict);assert_eq!(document_service::document(&vault.0,context(),"example").unwrap().draft,Some(saved));
}
