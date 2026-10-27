//! Actual injected native file commands. Wire context is only a comparison constraint.
use super::{WorkflowOpening,kernel,publication_service,action_error};
use crate::workflows::publication;
use crate::runtime::workflows as flow;
use crate::{actions::effect_types::{ActionError,ActionErrorCode},workflows::{document_service,transport::*}};
use std::sync::Arc;
use tauri::{AppHandle,WebviewWindow};
fn error(code:WorkflowErrorCode)->WorkflowError{WorkflowError{code,diagnostics:Vec::new()}}
fn unavailable()->WorkflowError{error(WorkflowErrorCode::Unavailable)}
pub(super) fn action(value:ActionError)->WorkflowError{error(match value.code{ActionErrorCode::InvalidInput=>WorkflowErrorCode::InvalidInput,ActionErrorCode::Denied|ActionErrorCode::DefinitionMismatch=>WorkflowErrorCode::Denied,ActionErrorCode::RequestKeyConflict=>WorkflowErrorCode::Conflict,ActionErrorCode::RevisionConflict=>WorkflowErrorCode::Stale,ActionErrorCode::LimitExceeded=>WorkflowErrorCode::LimitExceeded,_=>WorkflowErrorCode::Unavailable})}
pub(super) fn observed(opening:&WorkflowOpening)->WorkflowContext{WorkflowContext{vault_id:opening.scope.vault_id.clone(),store_uuid:opening.store.info.store_id.clone()}}
pub(super) fn bound(app:&AppHandle,window:&WebviewWindow,requested:&WorkflowContext)->Result<Arc<WorkflowOpening>,WorkflowError>{
 let opening=WorkflowOpening::capture(app,window).map_err(action)?;
 check_context(&observed(&opening),requested)?;Ok(opening)
}
fn check_context(actual:&WorkflowContext,requested:&WorkflowContext)->Result<(),WorkflowError>{if actual!=requested{return Err(error(WorkflowErrorCode::Denied));}Ok(())}
#[derive(Clone,Copy)]enum FileUse{Read,Mutation}
// Plain result classification, not authority. Production alone observes current.
fn finish_file<T>(value:Result<T,WorkflowError>,current:bool,use_:FileUse)->Result<T,WorkflowError>{
 // A known completed file mutation retains its exact acknowledgement. Source
 // loss prevents another operation; it does not undo the completed write.
 if matches!(use_,FileUse::Mutation)&&value.is_ok(){return value;}
 if !current{return Err(unavailable());}value
}
fn files<T>(app:&AppHandle,window:&WebviewWindow,requested:&WorkflowContext,use_:FileUse,work:impl FnOnce(&WorkflowOpening)->Result<T,WorkflowError>)->Result<T,WorkflowError>{
 let opening=bound(app,window,requested)?;
 let(result,current)=opening.guarded_rows(app,|owner,recheck|{
  owner.read_snapshot(|_|Ok(())).map_err(|_|kernel::unavailable())?;
  recheck()?;let value=work(&opening);let still_original=recheck().is_ok();Ok((value,still_original))
 }).map_err(action)?;
 let(value,still_original)=result.map_err(action)?;
 finish_file(value,current&&still_original,use_)
}
pub(crate) fn workflow_context(app:&AppHandle,window:&WebviewWindow)->Result<WorkflowContext,WorkflowError>{
 let opening=WorkflowOpening::capture(app,window).map_err(action)?;opening.guarded(app,|_,recheck|{recheck()?;Ok(observed(&opening))}).map_err(action)
}
pub(crate) fn workflow_catalog(app:&AppHandle,window:&WebviewWindow,context:WorkflowContext,after:Option<String>)->Result<WorkflowCatalog,WorkflowError>{files(app,window,&context,FileUse::Read,|opening|document_service::catalog(&opening.root,observed(opening),after.as_deref()))}
pub(crate) fn workflow_document(app:&AppHandle,window:&WebviewWindow,context:WorkflowContext,id:String)->Result<WorkflowDocument,WorkflowError>{files(app,window,&context,FileUse::Read,|opening|document_service::document(&opening.root,observed(opening),&id))}
pub(crate) fn workflow_version(app:&AppHandle,window:&WebviewWindow,context:WorkflowContext,version:WorkflowVersionRef)->Result<WorkflowDraft,WorkflowError>{files(app,window,&context,FileUse::Read,|opening|document_service::version(&opening.root,&version))}
pub(crate) fn workflow_save(app:&AppHandle,window:&WebviewWindow,request:WorkflowSaveRequest)->Result<WorkflowDraftSnapshot,WorkflowError>{files(app,window,&request.context,FileUse::Mutation,|opening|document_service::save(&opening.root,&request,&crate::actions::native_rules::admission_rules().owner_storage_key))}
pub(crate) fn workflow_publish(app:&AppHandle,window:&WebviewWindow,request:WorkflowPublishRequest)->Result<WorkflowPublication,WorkflowError>{
 let opening=bound(app,window,&request.context)?;
 let(result,_current)=opening.guarded_rows(app,|owner,recheck|{
  recheck()?;
  let directory=publication::Directory::open_existing(&opening.root,&request.workflow_id).map_err(|error|action_error(publication_service::file_error(error)))?;
  let edit=directory.edit().map_err(|error|action_error(publication_service::file_error(error)))?;
  publication_service::recover_workflow_owned(owner,opening.facts(),&edit,&request.workflow_id,chrono::Utc::now().timestamp_millis(),||recheck().map_err(|_|flow::Error::Unavailable)).map_err(action_error)?;
  recheck()?;owner.validate().map_err(|_|kernel::unavailable())?;
  // Recovery is fully committed before file CAS, with no SQL transaction held.
  let value=edit.publish(&request.workflow_id,&request.expected_draft_etag,request.expected_publication_revision.map(crate::actions::SafeCounter::get)).map_err(|error|action_error(publication_service::file_error(error)))?;
  let revision=crate::actions::SafeCounter::new(value.revision).map_err(|_|kernel::unavailable())?;
  Ok(WorkflowPublication{version:WorkflowVersionRef{workflow_id:value.workflow_id,definition_hash:value.definition_hash},revision})
 }).map_err(action)?;
 // A completed exact file write is not undone by later opening loss.
 result.map_err(action)
}
pub(crate) fn workflow_unpublish(app:&AppHandle,window:&WebviewWindow,request:WorkflowUnpublishRequest)->Result<WorkflowUnpublishAck,WorkflowError>{
 let opening=bound(app,window,&request.context)?;
 let(result,_current)=opening.guarded_rows(app,|owner,recheck|{
  recheck()?;
  let original=publication::Reference{workflow_id:request.publication.version.workflow_id.clone(),definition_hash:request.publication.version.definition_hash.clone(),revision:request.publication.revision.get()};
  let directory=publication::Directory::open_existing(&opening.root,&original.workflow_id).map_err(|error|action_error(publication_service::file_error(error)))?;
  let edit=directory.edit().map_err(|error|action_error(publication_service::file_error(error)))?;
  let completed=publication_service::complete_owned(owner,opening.facts(),&edit,&original,&request.request_key,chrono::Utc::now().timestamp_millis(),||recheck().map_err(|_|flow::Error::Unavailable)).map_err(action_error)?;
  let publication_revision=crate::actions::SafeCounter::new(completed.value.revision).map_err(|_|kernel::unavailable())?;
  Ok(WorkflowUnpublishAck{context:observed(&opening),request_key:request.request_key.clone(),original:request.publication.clone(),publication_revision,replayed:completed.replayed})
 }).map_err(action)?;
 // This ACK describes only the captured original operation, never a newer file.
 result.map_err(action)
}
pub(crate) fn workflow_validate(app:&AppHandle,window:&WebviewWindow,context:WorkflowContext,draft:WorkflowDraft)->Result<WorkflowValidation,WorkflowError>{files(app,window,&context,FileUse::Read,|_|Ok(document_service::validate(&draft,&crate::actions::native_rules::admission_rules().owner_storage_key)))}

/// Shared compiled metadata only, never an account grant or callable context.
pub(crate) fn workflow_actions(app:&AppHandle,window:&WebviewWindow,context:WorkflowContext)->Result<Vec<crate::actions::read_types::ActionDefinition>,WorkflowError>{files(app,window,&context,FileUse::Read,|_|Ok(crate::actions::compiled_catalog::compiled_catalog().map_err(|_|unavailable())?.definitions()))}

#[cfg(test)]
#[path="native_workflow_command_tests.rs"]
mod tests;
