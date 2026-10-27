//! File/DTO conversion only. Owning native commands retain the actual opening.
use super::{transport::*,definition::{self,DefinitionError},files::{self,DefinitionStore,FileError}};
use crate::actions::SafeCounter;
use serde::{Serialize,Deserialize,de::DeserializeOwned};
use serde_json::value::RawValue;
use std::{path::Path,collections::{BTreeMap,BTreeSet}};
fn error(code:WorkflowErrorCode)->WorkflowError{WorkflowError{code,diagnostics:Vec::new()}}
fn unavailable()->WorkflowError{error(WorkflowErrorCode::Unavailable)}
fn invalid()->WorkflowError{error(WorkflowErrorCode::InvalidInput)}
fn definition_error(value:DefinitionError)->WorkflowError{error(match value{DefinitionError::UnsupportedFormat=>WorkflowErrorCode::UnsupportedFormat,_=>WorkflowErrorCode::InvalidDefinition})}
fn file_error(value:FileError)->WorkflowError{match value{FileError::InvalidDefinition(value)=>definition_error(value),FileError::Conflict=>error(WorkflowErrorCode::Conflict),FileError::InvalidJson|FileError::InvalidPath=>invalid(),FileError::LimitExceeded=>error(WorkflowErrorCode::LimitExceeded),_=>unavailable()}}
fn bounded(text:&str)->Result<(),WorkflowError>{definition::canonical_json(text).map(|_|()).map_err(|error|match error{DefinitionError::LimitExceeded=>self::error(WorkflowErrorCode::LimitExceeded),_=>invalid()})}
fn raw(text:&str)->Result<Box<RawValue>,WorkflowError>{bounded(text)?;RawValue::from_string(text.to_owned()).map_err(|_|invalid())}
fn encode<T:Serialize>(value:&T)->Result<String,WorkflowError>{serde_json::to_string(value).map_err(|_|invalid())}
fn counter(value:u64)->Result<SafeCounter,WorkflowError>{SafeCounter::new(value).map_err(|_|unavailable())}
#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct StoredDraft{format_version:u32,workflow_id:String,#[serde(default,skip_serializing_if="Option::is_none")]definition_hash:Option<String>,entry_step_id:String,input_schema:Box<RawValue>,input_schema_digest:String,steps:Vec<StoredStep>,trigger:Box<RawValue>,declared_action_digests:Vec<String>,authored_by:String}
#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct StoredStep{step_id:String,label:String,operation:Box<RawValue>}
#[derive(Serialize)]
#[serde(tag="kind",rename_all="snake_case",rename_all_fields="camelCase")]
enum StoredOperation{
 Read{query:Box<RawValue>,output_schema:Box<RawValue>,next_step_id:String},
 Transform{mapping:Box<RawValue>,output_schema:Box<RawValue>,next_step_id:String},
 Condition{predicate:Box<RawValue>,if_true:String,if_false:String},
 Action{action_id:String,definition_digest:String,connection_id:String,account_id:String,input:Box<RawValue>,next_step_id:String},
 Wait{until:Box<RawValue>,next_step_id:String},Result{output:Box<RawValue>},
}
#[derive(Serialize)]
#[serde(tag="kind",rename_all="snake_case",rename_all_fields="camelCase")]
enum StoredWait{Timer{at:String},ExternalInput{schema:Box<RawValue>,expires_at:String}}
fn operation(value:&WorkflowOperationDraft)->Result<StoredOperation,WorkflowError>{Ok(match value{
 WorkflowOperationDraft::Read{query_json,output_schema_json,next_step_id}=>StoredOperation::Read{query:raw(query_json)?,output_schema:raw(output_schema_json)?,next_step_id:next_step_id.clone()},
 WorkflowOperationDraft::Transform{mapping_json,output_schema_json,next_step_id}=>StoredOperation::Transform{mapping:raw(mapping_json)?,output_schema:raw(output_schema_json)?,next_step_id:next_step_id.clone()},
 WorkflowOperationDraft::Condition{predicate_json,if_true,if_false}=>StoredOperation::Condition{predicate:raw(predicate_json)?,if_true:if_true.clone(),if_false:if_false.clone()},
 WorkflowOperationDraft::Action{action_id,definition_digest,connection_id,account_id,input_json,next_step_id}=>StoredOperation::Action{action_id:action_id.clone(),definition_digest:definition_digest.clone(),connection_id:connection_id.clone(),account_id:account_id.clone(),input:raw(input_json)?,next_step_id:next_step_id.clone()},
 WorkflowOperationDraft::Timer{at,next_step_id}=>StoredOperation::Wait{until:raw(&encode(&StoredWait::Timer{at:at.clone()})?)?,next_step_id:next_step_id.clone()},
 WorkflowOperationDraft::ExternalInput{schema_json,expires_at,next_step_id}=>StoredOperation::Wait{until:raw(&encode(&StoredWait::ExternalInput{schema:raw(schema_json)?,expires_at:expires_at.clone()})?)?,next_step_id:next_step_id.clone()},
 WorkflowOperationDraft::Result{output_json}=>StoredOperation::Result{output:raw(output_json)?},
})}
fn encode_draft(draft:&WorkflowDraft,authored_by:&str)->Result<String,WorkflowError>{
 if draft.steps.len()>definition::limits().steps{return Err(error(WorkflowErrorCode::LimitExceeded));}
 let input_schema=raw(&draft.input_schema_json)?;
 // Drafts are bounded JSON, not yet executable definitions. Compute the same
 // canonical digest without compiling unsupported/incomplete schema semantics.
 let input_schema_digest=crate::ledger::sha256_hex(definition::canonical_json(input_schema.get()).map_err(|_|invalid())?.as_bytes());
 let declared_action_digests=draft.steps.iter().filter_map(|step|match &step.operation{WorkflowOperationDraft::Action{definition_digest,..}=>Some(definition_digest.clone()),_=>None}).collect::<BTreeSet<_>>().into_iter().collect();
 let steps=draft.steps.iter().map(|step|Ok(StoredStep{step_id:step.step_id.clone(),label:step.label.clone(),operation:raw(&encode(&operation(&step.operation)?)?)?})).collect::<Result<Vec<_>,WorkflowError>>()?;
 let stored=StoredDraft{format_version:definition::format_version(),workflow_id:draft.workflow_id.clone(),definition_hash:None,entry_step_id:draft.entry_step_id.clone(),input_schema,input_schema_digest,steps,trigger:raw(&draft.trigger_json)?,declared_action_digests,authored_by:authored_by.into()};
 let text=encode(&stored)?;bounded(&text)?;Ok(text)
}
type Fields=BTreeMap<String,Box<RawValue>>;
fn fields(text:&str)->Result<Fields,WorkflowError>{bounded(text)?;serde_json::from_str(text).map_err(|_|invalid())}
fn take<T:DeserializeOwned>(fields:&mut Fields,name:&str)->Result<T,WorkflowError>{serde_json::from_str(fields.remove(name).ok_or_else(invalid)?.get()).map_err(|_|invalid())}
fn take_raw(fields:&mut Fields,name:&str)->Result<String,WorkflowError>{fields.remove(name).map(|value|value.get().to_owned()).ok_or_else(invalid)}
fn empty(fields:Fields)->Result<(),WorkflowError>{if fields.is_empty(){Ok(())}else{Err(invalid())}}
fn decode_operation(text:&str)->Result<WorkflowOperationDraft,WorkflowError>{
 // Raw maps avoid serde's internally-tagged buffering through Value/f64.
 let mut fields=fields(text)?;let kind:String=take(&mut fields,"kind")?;
 let operation=match kind.as_str(){
  "read"=>WorkflowOperationDraft::Read{query_json:take_raw(&mut fields,"query")?,output_schema_json:take_raw(&mut fields,"outputSchema")?,next_step_id:take(&mut fields,"nextStepId")?},
  "transform"=>WorkflowOperationDraft::Transform{mapping_json:take_raw(&mut fields,"mapping")?,output_schema_json:take_raw(&mut fields,"outputSchema")?,next_step_id:take(&mut fields,"nextStepId")?},
  "condition"=>WorkflowOperationDraft::Condition{predicate_json:take_raw(&mut fields,"predicate")?,if_true:take(&mut fields,"ifTrue")?,if_false:take(&mut fields,"ifFalse")?},
  "action"=>WorkflowOperationDraft::Action{action_id:take(&mut fields,"actionId")?,definition_digest:take(&mut fields,"definitionDigest")?,connection_id:take(&mut fields,"connectionId")?,account_id:take(&mut fields,"accountId")?,input_json:take_raw(&mut fields,"input")?,next_step_id:take(&mut fields,"nextStepId")?},
  "wait"=>{
   let until=take_raw(&mut fields,"until")?;let mut wait=self::fields(&until)?;let kind:String=take(&mut wait,"kind")?;let next_step_id=take(&mut fields,"nextStepId")?;
   let result=match kind.as_str(){"timer"=>WorkflowOperationDraft::Timer{at:take(&mut wait,"at")?,next_step_id},"external_input"=>WorkflowOperationDraft::ExternalInput{schema_json:take_raw(&mut wait,"schema")?,expires_at:take(&mut wait,"expiresAt")?,next_step_id},_=>return Err(invalid())};empty(wait)?;result
  },
  "result"=>WorkflowOperationDraft::Result{output_json:take_raw(&mut fields,"output")?},_=>return Err(invalid()),
 };empty(fields)?;Ok(operation)
}
fn decode_draft(text:&str)->Result<WorkflowDraft,WorkflowError>{
 bounded(text)?;let stored:StoredDraft=serde_json::from_str(text).map_err(|_|error(WorkflowErrorCode::InvalidDefinition))?;
 if stored.format_version!=definition::format_version(){return Err(error(WorkflowErrorCode::UnsupportedFormat));}
 if stored.steps.len()>definition::limits().steps{return Err(error(WorkflowErrorCode::LimitExceeded));}
 let steps=stored.steps.into_iter().map(|step|Ok(WorkflowStepDraft{step_id:step.step_id,label:step.label,operation:decode_operation(step.operation.get())?})).collect::<Result<Vec<_>,WorkflowError>>()?;
 Ok(WorkflowDraft{workflow_id:stored.workflow_id,entry_step_id:stored.entry_step_id,input_schema_json:stored.input_schema.get().into(),trigger_json:stored.trigger.get().into(),steps})
}

fn decode_scoped_draft(text:&str,id:&str)->Result<WorkflowDraft,WorkflowError>{
 let draft=decode_draft(text)?;if draft.workflow_id!=id{return Err(error(WorkflowErrorCode::InvalidDefinition));}Ok(draft)
}
fn publication(value:files::PublicationRef)->Result<WorkflowPublication,WorkflowError>{Ok(WorkflowPublication{version:WorkflowVersionRef{workflow_id:value.workflow_id,definition_hash:value.definition_hash},revision:counter(value.revision)?})}
pub(crate) fn catalog(root:&Path,context:WorkflowContext,after:Option<&str>)->Result<WorkflowCatalog,WorkflowError>{
 let page=DefinitionStore::list_existing(root,after).map_err(file_error)?;
 let items=page.ids.into_iter().map(|id|match DefinitionStore::inspect_existing(root,&id){
  Ok(document)=>{let readable=document.draft.as_ref().is_none_or(|draft|decode_scoped_draft(&draft.json,&id).is_ok());let publication=document.publication.map(publication).transpose();match publication{Ok(publication)=>WorkflowListItem{workflow_id:id,publication,readable},Err(_)=>WorkflowListItem{workflow_id:id,publication:None,readable:false}}},
  Err(_)=>WorkflowListItem{workflow_id:id,publication:None,readable:false},
 }).collect();
 Ok(WorkflowCatalog{context,items,next_cursor:page.next_cursor,truncated:page.truncated})
}
pub(crate) fn document(root:&Path,context:WorkflowContext,id:&str)->Result<WorkflowDocument,WorkflowError>{
 let stored=DefinitionStore::inspect_existing(root,id).map_err(file_error)?;
 let draft=stored.draft.map(|draft|Ok::<_,WorkflowError>(WorkflowDraftSnapshot{etag:draft.reference.etag,draft:decode_scoped_draft(&draft.json,id)?})).transpose()?;
 Ok(WorkflowDocument{context,workflow_id:id.into(),publication_revision:counter(stored.publication_revision)?,draft,publication:stored.publication.map(publication).transpose()?,versions:stored.versions.into_iter().map(|definition_hash|WorkflowVersionRef{workflow_id:id.into(),definition_hash}).collect(),versions_truncated:stored.versions_truncated,activation:WorkflowActivationView::Unavailable{}})
}
pub(crate) fn version(root:&Path,version:&WorkflowVersionRef)->Result<WorkflowDraft,WorkflowError>{
 let pinned=DefinitionStore::read_existing_version(root,&version.workflow_id,&version.definition_hash).map_err(file_error)?;decode_draft(&pinned.canonical)
}
pub(crate) fn save(root:&Path,request:&WorkflowSaveRequest,authored_by:&str)->Result<WorkflowDraftSnapshot,WorkflowError>{
 let text=encode_draft(&request.draft,authored_by)?;let store=DefinitionStore::open(root,&request.draft.workflow_id).map_err(file_error)?;
 let saved=store.save_draft(&text,request.expected_etag.as_deref()).map_err(file_error)?;
 Ok(WorkflowDraftSnapshot{etag:saved.etag,draft:decode_draft(&text)?})
}
pub(crate) fn publish(root:&Path,request:&WorkflowPublishRequest)->Result<WorkflowPublication,WorkflowError>{
 let store=DefinitionStore::open(root,&request.workflow_id).map_err(file_error)?;
 let reference=files::DraftRef{workflow_id:request.workflow_id.clone(),etag:request.expected_draft_etag.clone()};
 publication(store.publish(&reference,request.expected_publication_revision.map(SafeCounter::get)).map_err(file_error)?)
}
fn compile_draft(draft:&WorkflowDraft,authored_by:&str)->Result<definition::ValidatedDefinition,WorkflowError>{
 encode_draft(draft,authored_by).and_then(|text|definition::validate(&text).map_err(definition_error))
}
pub(crate) fn validate(draft:&WorkflowDraft,authored_by:&str)->WorkflowValidation{
 match compile_draft(draft,authored_by).map(|_|()){
  Ok(())=>WorkflowValidation{valid:true,diagnostics:Vec::new()},Err(error)=>WorkflowValidation{valid:false,diagnostics:vec![WorkflowDiagnostic{code:error.code,step_id:None,field:None}]},
 }
}
#[cfg(all(test,unix))]
#[path="document_service_tests.rs"]
mod tests;

/// Unsaved validated definition and exact input, for read-only preview only.
/// This is data: it is not a published version, grant, native origin or run.
#[derive(Debug)]
pub(super) struct DraftSample {
    pub definition: definition::ValidatedDefinition,
    pub input: String,
}

pub(super) fn compile_sample(
    draft: &WorkflowDraft,
    authored_by: &str,
    input: &str,
) -> Result<DraftSample, WorkflowError> {
    let definition = compile_draft(draft, authored_by)?;
    // The same schema and exact parser as pinned execution; no Value/f64.
    definition::validate_input(&definition, input).map_err(|_| invalid())?;
    let limits = definition::limits();
    let input = crate::actions::schema::workflow_canonical_json(
        input, limits.step_output_bytes, limits.json_depth,
    ).map_err(|_| invalid())?;
    Ok(DraftSample { definition, input })
}

#[cfg(test)]
#[path = "draft_sample_tests.rs"]
mod sample_tests;
